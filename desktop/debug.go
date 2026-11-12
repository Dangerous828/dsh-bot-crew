package main

// debug.go —— 全局调试态：把 UI 后背那一排功能挂成「可按名字调用」的动作总线，
// 并在 CREW_DEBUG=1 时开一条本地 unix socket 供外部（自动化 / curl / 我自己）直接驱动。
//
// 为什么要有它：mygo 把每个控件都画成 AXStaticText，没有可寻址的 actionable 元素，
// 裸鼠标坐标事件也不稳。所以「点一下常规任务」在自动化眼里几乎是黑盒。这里换一条路——
// 不去点像素，而是按名字调 app 的方法（pressNav(navRoutine) / send(...) / adopt(...)），
// 并读回一份结构化的状态快照（state.dump），断言「这一下到底改了什么」。
//
// 生产面零暴露：CREW_DEBUG 不设时，一个 socket 都不开，动作表也不建。
//
// 两种入口共用同一张动作表：
//   ① 进程内：DebugBus.invoke(name, args) —— Go 单测可直接调，无需 socket。
//   ② 进程外：CREW_DEBUG=1 时监听 unix socket，收 {"action":"...","args":{...}}，
//      回 {"ok":true,"result":...} 或 {"ok":false,"error":"..."}。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// debugAction 是一条可调用动作：收一组 JSON 参数，回一个可 JSON 化的结果。
// 返回 error 表示动作本身拒绝/失败（会变成 ok:false）；result 为 nil 也可以。
type debugAction func(args map[string]json.RawMessage) (any, error)

// DebugBus 是一张「名字 → 动作」的表，外加一把锁——动作会读写 app 状态，
// 而 mygo 的界面线程也在碰同一份状态，所以外部调用统一在这一层串行。
type DebugBus struct {
	app *app
	mu  sync.Mutex
	// actions 是全部可调用动作。建一次，不随刷新变。
	actions map[string]debugAction
}

// newDebugBus 把 app 的方法逐个包成可按名字调用。
//
// 这里只做「翻译」：把 JSON 参数取出来、调对应那一个 app 方法、把结果拼成 JSON。
// 业务规则仍留在 app 方法里，不在这里重写一遍——调试口不该有第二套行为。
func newDebugBus(s *app) *DebugBus {
	bus := &DebugBus{app: s, actions: map[string]debugAction{}}

	// ── 导航：等价于点左栏任一项 ──────────────────────────────
	nav := map[string]navItem{
		"backend": navBackend, "models": navModel, "outputs": navOutput,
		"routines": navRoutine, "memory": navMemory, "board": navBoard,
	}
	for name, item := range nav {
		it := item
		bus.register("nav."+name, func(args map[string]json.RawMessage) (any, error) {
			// 已经在这一项上再点一次，会收起右栏（和真点一下一样）。
			ok := s.pressNav(it)
			return map[string]any{"ok": ok, "nav": bus.navName(s.navTab), "backendOpen": s.backendOpen}, nil
		})
	}
	bus.register("nav.selectBot", func(args map[string]json.RawMessage) (any, error) {
		id, err := argString(args, "bot_id")
		if err != nil {
			return nil, err
		}
		s.selectedBot = id
		s.screen = nil // 和真点在花名册上一样：回到对话主界面
		s.wake()
		return map[string]any{"selectedBot": s.selectedBot}, nil
	})
	bus.register("backend.tab", func(args map[string]json.RawMessage) (any, error) {
		// 0=进行中 1=待你 2=已完成，和 backendTabCell 的档位一致。
		tab, err := argInt(args, "index")
		if err != nil || tab < 0 || tab > 2 {
			return nil, errors.New("index must be 0, 1 or 2")
		}
		s.navTab = navBackend
		s.backendOpen = true
		s.backendTab = tab
		s.wake()
		return map[string]any{"backendTab": s.backendTab}, nil
	})
	bus.register("sidebar.toggle", func(args map[string]json.RawMessage) (any, error) {
		s.sidebarClosed = !s.sidebarClosed
		s.wake()
		return map[string]any{"sidebarClosed": s.sidebarClosed}, nil
	})
	bus.register("sidebar.width", func(args map[string]json.RawMessage) (any, error) {
		px, err := argFloat(args, "px")
		if err != nil || px <= 0 {
			return nil, errors.New("px must be a positive number")
		}
		s.sidebarWidth = float32(px)
		s.wake()
		return map[string]any{"sidebarWidth": s.sidebarWidth}, nil
	})

	// ── 对话：发 / 撤 / 采用 / 看 / 答 / 插队 ───────────────────
	bus.register("send", func(args map[string]json.RawMessage) (any, error) {
		text, err := argString(args, "text")
		if err != nil {
			return nil, err
		}
		// 和输入框那条路一样：写进 s.input，再走 s.send()，这样并发/清空逻辑都一致。
		s.input = text
		s.send()
		return map[string]any{"sent": text}, nil
	})
	bus.register("withdraw", func(args map[string]json.RawMessage) (any, error) {
		id, err := argString(args, "request_id")
		if err != nil {
			return nil, err
		}
		s.withdraw(id)
		return map[string]any{"withdrawing": id}, nil
	})
	bus.register("adopt", func(args map[string]json.RawMessage) (any, error) {
		bot, _ := argString(args, "bot_id")
		block, ok := s.findBlock(argStringDefault(args, "block_id", ""))
		if !ok {
			return nil, errors.New("no such code block")
		}
		s.adopt(block, bot)
		return map[string]any{"block": block.ID}, nil
	})
	bus.register("preview", func(args map[string]json.RawMessage) (any, error) {
		block, ok := s.findBlock(argStringDefault(args, "block_id", ""))
		if !ok {
			return nil, errors.New("no such code block")
		}
		s.preview(block)
		return map[string]any{"block": block.ID}, nil
	})
	bus.register("answer", func(args map[string]json.RawMessage) (any, error) {
		taskID, err := argString(args, "ticket_id")
		if err != nil {
			return nil, err
		}
		optionID, err := argString(args, "option_id")
		if err != nil {
			return nil, err
		}
		task, ok := bus.pendingTask(taskID)
		if !ok {
			return nil, errors.New("no pending decision for that ticket")
		}
		var chosen AttentionOption
		found := false
		for _, o := range task.Options {
			if o.ID == optionID {
				chosen, found = o, true
				break
			}
		}
		if !found {
			return nil, errors.New("no such option on that card")
		}
		s.answer(task, chosen)
		return map[string]any{"ticket": taskID, "option": optionID}, nil
	})
	bus.register("steer", func(args map[string]json.RawMessage) (any, error) {
		req, _ := argString(args, "request_id")
		ticket, _ := argString(args, "ticket_id")
		s.steer(req, ticket)
		return map[string]any{"steered": req}, nil
	})
	bus.register("pauseAll", func(args map[string]json.RawMessage) (any, error) {
		s.pauseAll()
		return map[string]any{"pausing": true}, nil
	})

	// ── 屏幕 ─────────────────────────────────────────────────
	bus.register("screen.look", func(args map[string]json.RawMessage) (any, error) {
		s.lookAtScreen()
		return map[string]any{"looking": true}, nil
	})
	bus.register("screen.fullscreen", func(args map[string]json.RawMessage) (any, error) {
		on, err := argBool(args, "on")
		if err != nil {
			return nil, err
		}
		s.screenFull = on
		s.wake()
		return map[string]any{"screenFull": s.screenFull}, nil
	})
	bus.register("work.open", func(args map[string]json.RawMessage) (any, error) {
		id, err := argString(args, "ticket_id")
		if err != nil {
			return nil, err
		}
		s.openWork(id)
		return map[string]any{"openTicket": id}, nil
	})

	// ── 模型 ─────────────────────────────────────────────────
	bus.register("model.open", func(args map[string]json.RawMessage) (any, error) {
		s.pressNav(navModel)
		return map[string]any{"nav": bus.navName(s.navTab)}, nil
	})
	bus.register("model.scope", func(args map[string]json.RawMessage) (any, error) {
		scope, _ := argString(args, "bot_id") // 空串 = 全场
		s.modelScope = scope
		s.loadEfforts()
		s.wake()
		return map[string]any{"modelScope": s.modelScope}, nil
	})
	bus.register("model.switch", func(args map[string]json.RawMessage) (any, error) {
		provider, err := argString(args, "provider")
		if err != nil {
			return nil, err
		}
		model, err := argString(args, "model")
		if err != nil {
			return nil, err
		}
		effort, _ := argString(args, "reasoning_effort")
		choice := ModelChoice{Provider: provider, Model: model, ReasoningEffort: effort}
		s.switchTo(choice)
		return map[string]any{"switching": choice}, nil
	})
	bus.register("model.reload", func(args map[string]json.RawMessage) (any, error) {
		s.loadModels()
		return map[string]any{"loading": true}, nil
	})

	// ── 记忆 ─────────────────────────────────────────────────
	bus.register("memory.reload", func(args map[string]json.RawMessage) (any, error) {
		s.loadMemory()
		return map[string]any{"loading": true}, nil
	})
	bus.register("memory.forget", func(args map[string]json.RawMessage) (any, error) {
		name, err := argString(args, "name")
		if err != nil {
			return nil, err
		}
		s.forgetMemory(name)
		return map[string]any{"forgetting": name}, nil
	})

	// ── 常规任务 ─────────────────────────────────────────────
	bus.register("routines.reload", func(args map[string]json.RawMessage) (any, error) {
		s.loadRoutines()
		return map[string]any{"loading": true}, nil
	})

	// ── 模式：等价于点标题栏那条 segmented ────────────────────
	bus.register("mode.set", func(args map[string]json.RawMessage) (any, error) {
		name, err := argString(args, "mode")
		if err != nil {
			return nil, err
		}
		switch name {
		case "chat":
			s.mode = modeChat
		case "triage":
			s.mode = modeTriage
		default:
			return nil, fmt.Errorf("unknown mode: %s", name)
		}
		s.wake()
		return map[string]any{"mode": modeName(s.mode)}, nil
	})

	// ── 刷新 / 状态 ──────────────────────────────────────────
	bus.register("refresh", func(args map[string]json.RawMessage) (any, error) {
		s.refresh()
		return map[string]any{"refreshing": true}, nil
	})
	bus.register("state.dump", func(args map[string]json.RawMessage) (any, error) {
		return s.stateSnapshot(), nil
	})
	bus.register("actions.list", func(args map[string]json.RawMessage) (any, error) {
		names := make([]string, 0, len(bus.actions))
		for name := range bus.actions {
			names = append(names, name)
		}
		sort.Strings(names)
		return map[string]any{"actions": names}, nil
	})

	return bus
}

func (bus *DebugBus) register(name string, fn debugAction) { bus.actions[name] = fn }

// invoke 按名字调一条动作。未知动作明确报错，不静默。
func (bus *DebugBus) invoke(name string, args map[string]json.RawMessage) (any, error) {
	fn, ok := bus.actions[name]
	if !ok {
		return nil, fmt.Errorf("unknown action: %s", name)
	}
	bus.mu.Lock()
	defer bus.mu.Unlock()
	return fn(args)
}

func (bus *DebugBus) navName(item navItem) string {
	switch item {
	case navBackend:
		return "backend"
	case navModel:
		return "models"
	case navOutput:
		return "outputs"
	case navRoutine:
		return "routines"
	case navMemory:
		return "memory"
	case navBoard:
		return "board"
	}
	return "unknown"
}

// pendingTask 在待决卡里按票号找一张。找不到返回 false。
func (bus *DebugBus) pendingTask(ticketID string) (Task, bool) {
	for _, t := range bus.app.pendingDecisions() {
		if t.ID == ticketID {
			return t, true
		}
	}
	return Task{}, false
}

// stateSnapshot 把 app 最要紧的那批状态摊平成一份 JSON —— 调试时靠它断言「这一下改了什么」，
// 不用去看像素。字段都是「现在这一屏为什么长这样」的直接来源。
func (s *app) stateSnapshot() map[string]any {
	snap := map[string]any{
		"nav":          tabName(s.navTab),
		"mode":         modeName(s.mode),
		"backendOpen":  s.backendOpen,
		"backendTab":   s.backendTab,
		"selectedBot":  s.selectedBot,
		"sidebarClosed": s.sidebarClosed,
		"sidebarWidth": s.sidebarWidth,
		"backendWidth": s.backendWidth,
		"input":        s.input,
		"sending":      s.sending,
		"problem":      s.problem,
		"endpoint":     s.endpoint,
		"screenFull":   s.screenFull,
		"screenActive": s.screen != nil,
		"openTicket":   s.openTicket,
		"modelScope":   s.modelScope,
		"modelNote":    s.modelNote,
		"modelError":   s.modelsError,
	}
	if s.conversation != nil {
		snap["messages"] = len(s.conversation.Messages)
		snap["bots"] = len(s.conversation.Bots)
		snap["tasks"] = len(s.conversation.Tasks)
	} else {
		snap["messages"] = -1 // 还没读到时间线
	}
	if n, ok := s.unreadCount(); ok {
		snap["unread"] = n
	}
	if n, ok := s.unreadRepliesCount(); ok {
		snap["unreadReplies"] = n
	}
	if s.models != nil {
		snap["modelCount"] = len(s.models.Providers)
	}
	snap["pendingDecisions"] = len(s.pendingDecisions())
	return snap
}

// tabName 是 navItem 的面板名（snapshot 用），与 bus.navName 是同一套字符串。
func tabName(item navItem) string {
	switch item {
	case navBackend:
		return "backend"
	case navModel:
		return "models"
	case navOutput:
		return "outputs"
	case navRoutine:
		return "routines"
	case navMemory:
		return "memory"
	case navBoard:
		return "board"
	}
	return "unknown"
}

// findBlock 在当前的对话消息里按 ID 找一段代码卡。adopt / preview 需要完整的 CodeBlock。
// 一条消息至多一个代码块（见 Message.Code），所以逐条取 Code() 比对即可。
func (s *app) findBlock(blockID string) (CodeBlock, bool) {
	if s.conversation == nil {
		return CodeBlock{}, false
	}
	for _, m := range s.conversation.Messages {
		if block := m.Code(); block != nil && block.ID == blockID {
			return *block, true
		}
	}
	return CodeBlock{}, false
}

// ── 参数取值小工具 ─────────────────────────────────────────

func argString(args map[string]json.RawMessage, key string) (string, error) {
	raw, ok := args[key]
	if !ok {
		return "", fmt.Errorf("%s is required", key)
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return "", fmt.Errorf("%s must be a string", key)
	}
	if v == "" {
		return "", fmt.Errorf("%s must not be empty", key)
	}
	return v, nil
}

func argStringDefault(args map[string]json.RawMessage, key, def string) string {
	raw, ok := args[key]
	if !ok {
		return def
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return def
	}
	return v
}

func argInt(args map[string]json.RawMessage, key string) (int, error) {
	raw, ok := args[key]
	if !ok {
		return 0, fmt.Errorf("%s is required", key)
	}
	var v int
	if err := json.Unmarshal(raw, &v); err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	return v, nil
}

func argFloat(args map[string]json.RawMessage, key string) (float64, error) {
	raw, ok := args[key]
	if !ok {
		return 0, fmt.Errorf("%s is required", key)
	}
	var v float64
	if err := json.Unmarshal(raw, &v); err != nil {
		return 0, fmt.Errorf("%s must be a number", key)
	}
	return v, nil
}

func argBool(args map[string]json.RawMessage, key string) (bool, error) {
	raw, ok := args[key]
	if !ok {
		return false, fmt.Errorf("%s is required", key)
	}
	var v bool
	if err := json.Unmarshal(raw, &v); err != nil {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return v, nil
}

// ── unix socket 服务（仅 CREW_DEBUG=1 时开）────────────────────

// debugSocketPath 是控制口的落点：$TMPDIR/crew-debug.sock（只本机能连，无端口占用）。
// 让调用方能从环境变量覆盖，测试里指到临时目录。
func debugSocketPath() string {
	if p := os.Getenv("CREW_DEBUG_SOCK"); p != "" {
		return p
	}
	return filepath.Join(os.TempDir(), "crew-debug.sock")
}

// serveDebug 在 unix socket 上跑一个极简的「一行一个请求」服务：每收到一行 JSON
// {"action":...,"args":{...}}，回一行 JSON {"ok":...,"result"/"error":...}。
// 每个连接单独处理；错误只回给这一条，不退出服务。
func (bus *DebugBus) serveDebug(ctx context.Context) error {
	path := debugSocketPath()
	_ = os.Remove(path) // 清掉上一次崩溃留下的死 socket
	listener, err := net.Listen("unix", path)
	if err != nil {
		return fmt.Errorf("listen unix %s: %w", path, err)
	}
	// 只有本用户能读写：调试口能驱动整个界面，不该给别的账号。
	_ = os.Chmod(path, 0o600)
	go func() {
		<-ctx.Done()
		listener.Close()
		_ = os.Remove(path)
	}()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return // listener 被关时 Accept 报错，正常退出
			}
			go bus.handleConn(conn)
		}
	}()
	return nil
}

func (bus *DebugBus) handleConn(conn net.Conn) {
	defer conn.Close()
	decoder := json.NewDecoder(conn)
	encoder := json.NewEncoder(conn)
	for {
		var request struct {
			Action string                     `json:"action"`
			Args   map[string]json.RawMessage `json:"args"`
		}
		if err := decoder.Decode(&request); err != nil {
			return // 连到 EOF 或坏帧，收掉这个连接
		}
		result, err := bus.invoke(request.Action, request.Args)
		response := map[string]any{}
		if err != nil {
			response["ok"] = false
			response["error"] = err.Error()
		} else {
			response["ok"] = true
			response["result"] = result
		}
		if encodeErr := encoder.Encode(response); encodeErr != nil {
			return
		}
	}
}

// debugClient 向本地控制口发一条动作并读回结果。供宿主机一侧的调试脚本用（tests / 手工）。
// 非调试构建里它也在，但没人监听 socket —— 调用会如实报连不上。
func debugClient(action string, args map[string]any) (map[string]any, error) {
	conn, err := net.DialTimeout("unix", debugSocketPath(), 2*time.Second)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	payload, _ := json.Marshal(map[string]any{"action": action, "args": args})
	if _, err := conn.Write(append(payload, '\n')); err != nil {
		return nil, err
	}
	var response map[string]any
	if err := json.NewDecoder(conn).Decode(&response); err != nil {
		return nil, err
	}
	return response, nil
}

// debugEnabled 读环境开关。除 "1" 之外一律算没开——调试口能驱动整屏，默认必须是关的。
func debugEnabled() bool { return os.Getenv("CREW_DEBUG") == "1" }
