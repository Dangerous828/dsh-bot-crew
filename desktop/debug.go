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

	// ── 会话：与手机端 CrewDebug.kt 同名同语义的三个动作 ─────────────
	//
	// 为什么桌面也要有：真 GUI 验收不许抢焦点、不许发桌面输入事件，而「点左栏那一段会话」
	// 在自动化眼里就是像素。issue #18 第 2 项要求把这条路变成可寻址的，于是补上这三个。
	//
	// 它们调的是界面按一下会调的同一个方法（switchSession / probeSessions），
	// 能力位门禁原样保留 —— 调试口不绕过先验，否则「调试一下」就能造出界面做不到的状态。
	bus.register("session.list", func(args map[string]json.RawMessage) (any, error) {
		rows := make([]map[string]any, 0, len(s.sessions))
		for _, id := range s.sessions {
			rows = append(rows, map[string]any{"id": id, "name": id, "current": id == s.currentSession})
		}
		return map[string]any{
			"capability": s.sessionCapabilityName(),
			"switchable": s.sessionSwitchable(),
			"current":    s.currentSession,
			"default":    defaultSessionID,
			"note":       s.sessionNote,
			"sessions":   rows,
		}, nil
	})
	bus.register("session.set", func(args map[string]json.RawMessage) (any, error) {
		id, err := argString(args, "session")
		if err != nil {
			return nil, err
		}
		// 与手机端 CrewDebug.switchSession 同一条规矩：能力位没到 live 就拒绝。
		if !s.sessionSwitchable() {
			note := s.sessionNote
			if note != "" {
				note = " (" + note + ")"
			}
			return nil, fmt.Errorf("session switching is locked: capability=%s%s", s.sessionCapabilityName(), note)
		}
		if !s.switchSession(id) {
			// switchSession 已把原因写进 sessionNote（形状不对 / 不在名单里），原样带回。
			reason := s.sessionNote
			if reason == "" {
				reason = "switch refused"
			}
			return nil, fmt.Errorf("%s", reason)
		}
		// 切过去之后那次时间线读是异步的：等它真的落进当前会话的缓存再回话，
		// 外部脚本才能「切完立刻看 messages」。窗口没在画时靠 pumpResults 收。
		want := s.currentSession
		s.pumpResults(10*time.Second, func() bool {
			return s.conversation != nil && s.conversation.SessionID == want
		})
		return map[string]any{
			"session": s.currentSession, "loaded": s.conversation != nil,
			"messages": s.currentMessageCount(),
		}, nil
	})
	bus.register("session.reload", func(args map[string]json.RawMessage) (any, error) {
		// 等价于点界面那次「重试」/ 进队伍时那次先验：重新 GET /sessions。
		// 在别的门新建了会话之后，桌面不重拉名单就永远只看到旧的。
		if s.client == nil {
			return nil, errors.New("还没有连上队伍，读不到会话名单")
		}
		if s.sessionBusy {
			return nil, errors.New("会话名单正在读，稍后再说")
		}
		s.probeSessions()
		// 等先验的三态落到状态上（applySessions 还会顺手读一次时间线）。
		// 判据只看「先验结束了」：名单与能力位可能本来就一样，那不是没跑完。
		settled := s.pumpResults(15*time.Second, func() bool {
			return s.sessionsChecked && !s.sessionBusy
		})
		return map[string]any{
			"reloading": true, "settled": settled,
			"capability": s.sessionCapabilityName(), "sessions": append([]string(nil), s.sessions...),
		}, nil
	})

	// ── 记忆 ─────────────────────────────────────────────────
	bus.register("memory.reload", func(args map[string]json.RawMessage) (any, error) {
		// 已经在读就不叠第二个请求（loadMemory 自己会挡住），等它落地。
		wasLoading := s.loadingMemory
		s.loadMemory()
		settled := s.pumpResults(15*time.Second, func() bool {
			return !s.loadingMemory && (s.memory != nil || s.memoryNote != "")
		})
		return map[string]any{"loading": wasLoading, "settled": settled,
			"count": s.memoryActiveCount()}, nil
	})
	bus.register("memory.forget", func(args map[string]json.RawMessage) (any, error) {
		name, err := argString(args, "name")
		if err != nil {
			return nil, err
		}
		s.forgetMemory(name)
		return map[string]any{"forgetting": name}, nil
	})
	// memory.dump 是「这一刻账本里有什么」的结构化快照：真 GUI 验收靠它断言
	// 「改之前是这句、改之后是那句」，不用去看像素。
	bus.register("memory.dump", func(args map[string]json.RawMessage) (any, error) {
		if s.memory == nil {
			return map[string]any{
				"state": "pending", "items": []map[string]any{}, "note": s.memoryNote,
				"counts": map[string]int{},
			}, nil
		}
		items := make([]map[string]any, 0, len(s.memory.Items))
		for _, item := range s.memory.Items {
			items = append(items, map[string]any{
				"name": item.Name, "bot_id": item.BotID, "description": item.Description,
				"body": item.Body, "type": item.Type, "state": item.State,
				"origin": item.Origin, "updated": item.Updated,
			})
		}
		return map[string]any{
			"state": s.memory.State, "note": s.memoryNote, "items": items,
			"counts": map[string]int{
				"active": s.memory.Counts.Active, "forgotten": s.memory.Counts.Forgotten,
				"superseded": s.memory.Counts.Superseded,
			},
		}, nil
	})
	// memory.edit 打开的是界面那一层（标题 / 正文两个输入框），填的是这条现在的值；
	// 不给 description / body 就沿用账本里的原值。
	bus.register("memory.edit", func(args map[string]json.RawMessage) (any, error) {
		name, err := argString(args, "name")
		if err != nil {
			return nil, err
		}
		if s.memory == nil {
			return nil, errors.New("还没读到记忆账本：先 memory.reload")
		}
		var found MemoryItem
		ok := false
		for _, item := range s.memory.Items {
			if item.Name == name {
				found, ok = item, true
				break
			}
		}
		if !ok {
			return nil, fmt.Errorf("no such memory: %s", name)
		}
		// 与界面上点「编辑」同一条入口：草稿从账本现值起，再套上这次要改的字段。
		s.editMemory(found)
		if description := argStringDefault(args, "description", ""); description != "" {
			s.actions.memoryDescription = description
		}
		if body := argStringDefault(args, "body", ""); body != "" {
			s.actions.memoryBody = body
		}
		return map[string]any{
			"editing": s.actions.editingMemory, "description": s.actions.memoryDescription,
			"body": s.actions.memoryBody,
		}, nil
	})
	// memory.save 与界面上点「保存」同一个收口（Client.EditMemory + applyMemoryOutcome）。
	// 这里是同步的：socket 那一条本来就是「一条请求一条响应」，等结果回来才回话，
	// 外部脚本才能立刻断言「改成功了 / 被后端拒了」。
	bus.register("memory.save", func(args map[string]json.RawMessage) (any, error) {
		a := s.actions
		if a == nil || a.editingMemory == "" {
			return nil, errors.New("没有打开的编辑层：先 memory.edit")
		}
		if s.client == nil {
			return nil, errors.New("还没有连上队伍，改不了记忆")
		}
		name, description, body := a.editingMemory, a.memoryDescription, a.memoryBody
		a.memorySaving, a.memoryEditError = true, ""
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		err := s.client.EditMemory(ctx, name, description, body)
		s.applyMemoryOutcome(name, err)
		if err != nil {
			return nil, err
		}
		// 成功后 applyMemoryOutcome 会重读账本：等重读落地，脚本才能立刻 memory.dump 看到新值。
		s.pumpResults(15*time.Second, func() bool { return !s.loadingMemory })
		return map[string]any{"saved": name, "description": description, "body": body,
			"count": s.memoryActiveCount()}, nil
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
		// 走界面同一个 refresh()，再把它带来的异步结果收进状态（窗口没在画时
		// 一帧都不会来，光调 refresh 会让调用方永远看到 messages:-1）。
		s.refresh()
		want := s.currentSession
		settled := s.pumpResults(15*time.Second, func() bool {
			return !s.sessionsChecked || (s.conversation != nil && s.conversation.SessionID == want && !s.isRefreshing(want))
		})
		// refreshing 报的是「回话这一刻还有没有在途」——settled 之后它应是 false。
		return map[string]any{"refreshing": s.isRefreshing(want), "settled": settled,
			"session": want, "messages": s.currentMessageCount()}, nil
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

// sessionCapabilityName 把「会话能不能切」这件事摊成手机端那四个同名档位
// （CrewWire.kt 的 SessionCapability）：pending / live / unsupported / unreadable。
//
// 桌面端没有单独存一个枚举：能力位的结论就在 sessionsChecked / sessionAPI / sessionNote 三处。
// 这里只是把它们翻译成同一个词表，让两端脚本能对同名字段做同一套断言。
func (s *app) sessionCapabilityName() string {
	switch {
	case !s.sessionsChecked:
		return "pending"
	case s.sessionAPI:
		return "live"
	case s.sessionNote == legacySessionNote:
		return "unsupported"
	default:
		return "unreadable"
	}
}

// sessionSwitchable 是「这一刻能不能切」的唯一判据：与界面画不画切换条、按下去动不动
// 用的是同一个字段（sessionAPI）。调试口不另造一套。
func (s *app) sessionSwitchable() bool { return s.sessionAPI }

// pumpResults 把**已经到达**的后台结果收进状态，直到 done() 成立或预算用完。
//
// 为什么需要它：drain 只在 view() 每帧被调一次，而一扇没有在画的窗口（被遮挡、
// 显示器休眠、App Nap）一帧都不会来 —— 后台线程早把结果放进了通道，状态却停在旧值。
// 调试口是「按名字调方法」，不受帧的节奏约束，所以自己把 drain 走一遍（传 nil：
// drain 里的 c.Invalidate() 对 nil 是安全的），等结果真的落地再回话。
//
// 它不改变产品行为：走的还是同一个 drain、同一批通道、同一套 apply*。
// 真正的根治（让 drain 不只挂在帧上）在 ui.go 的 drain 调用点，属于另一件事，
// 已在 docs 里记为发现；这里只保证调试口不因「窗口没画」而看不见真实状态。
func (s *app) pumpResults(budget time.Duration, done func() bool) bool {
	deadline := time.Now().Add(budget)
	for {
		s.drain(nil)
		if done == nil || done() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// applyMemoryOutcome 是记忆写入结果落到状态上的唯一收口：界面那条路（applyAction）
// 与调试口那条路（memory.save 同步等结果）都走这里，行为不会分成两套。
//
// 成功才关层并重读；失败把后端那句 reason 原样留在层里，编辑层不关。
func (s *app) applyMemoryOutcome(name string, err error) {
	a := s.actions
	if a == nil {
		return
	}
	// 换了另一条再收到旧回执：那句话不该写到新开的编辑层上。
	if name != a.editingMemory {
		return
	}
	a.memorySaving = false
	if err != nil {
		a.memoryEditError = actionErrorText(err)
		return
	}
	a.editingMemory, a.memoryDescription, a.memoryBody, a.memoryEditError = "", "", "", ""
	s.loadMemory()
}

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
		// 会话：真 GUI 验收全靠这三个字段断言「现在在哪一段、能不能切」，
		// 与 session.list 是同一份事实（同一批字段算出来的）。
		"session":           s.currentSession,
		"sessionCapability": s.sessionCapabilityName(),
		"sessionSwitchable": s.sessionSwitchable(),
		"sessionNote":       s.sessionNote,
		"sessions":          append([]string(nil), s.sessions...),
		// 记忆：记得几条（active），以及这一刻编辑层开着哪一条。
		// 条数 -1 表示还没读回来，不是「一条都没有」。
		"memoryCount":    -1,
		"memoryEditing":  "",
	}
	if s.memory != nil {
		snap["memoryCount"] = s.memory.Counts.Active
		snap["memoryState"] = s.memory.State
	}
	if s.actions != nil {
		snap["memoryEditing"] = s.actions.editingMemory
		snap["memorySaving"] = s.actions.memorySaving
		snap["memoryEditError"] = s.actions.memoryEditError
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
	// 刷新在途：脚本据此判断「再等一会儿」还是「已经到底了」。
	snap["refreshing"] = s.isRefreshing(s.currentSession)
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

// memoryActiveCount 是这一刻账本里「还参与召回」的条数；没读回来时是 -1。
// 与 state.dump 的 memoryCount 同一个口径，脚本两端对得上。
func (s *app) memoryActiveCount() int {
	if s.memory == nil {
		return -1
	}
	return s.memory.Counts.Active
}

// isRefreshing 报「这一段会话的时间线读还在路上」。切到另一段时不算在途
// （refresh 只挡同一段），与 refresh 里的判据同一口径。
func (s *app) isRefreshing(session string) bool {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	return s.refreshing && s.refreshingSession == session
}

// currentMessageCount 是当前这段会话已经读到的消息条数；还没读到是 -1
// （不是 0 —— 那会读成「这一段是空的」）。
func (s *app) currentMessageCount() int {
	if s.conversation == nil {
		return -1
	}
	return len(s.conversation.Messages)
}
