package main

// debug_mainthread_test.go —— 调试口「所有动作在主线程串行执行」的证明（issue #27 遗留）。
//
// 背景：产品的 wake → postMain → drain 已经在主线程上跑（#27 修完那一半）。
// 剩下的是调试口自己：bus.handleConn 在 socket 的 goroutine 上直接
// runPending + drain(nil)，等于与真窗口的 view() 并发读写同一批字段。
//
// 这一组钉住四件事，全部**不靠「跑一遍没崩」**这种弱断言：
//  1. 动作体确实在跑批的那个 goroutine 上执行（不是 socket goroutine）；
//  2. 两个 socket 连接同时打动作，动作体不重叠（串行），状态不串；
//  3. 主线程不来时，动作按明确超时返回 ok:false，不是永远挂着；
//  4. 队列收掉（窗口关了）时，等在里面的动作立刻拿到明确错误。

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ── ① 执行位置：动作体跑在跑批的 goroutine 上 ────────────────────────────

// 动作体必须与 runPending 在同一个 goroutine 上执行。
// 判据不是「跑完了」，而是「执行期间 batchGID 指向的就是本 goroutine」。
func TestDebugActionRunsOnThePumpingGoroutine(t *testing.T) {
	s, _ := sessionApp(t)
	bus := newDebugBus(s)

	var seen atomic.Uint64
	var myGID atomic.Uint64
	bus.register("test.where", func(args map[string]json.RawMessage) (any, error) {
		myGID.Store(goroutineID())
		seen.Store(s.batchGID.Load())
		return map[string]any{"ok": true}, nil
	})

	// 绑一个「像窗口那样」的队列：真窗口里就是 mygo.Window.Update 在跑 runPending。
	// 这里用一个独立 goroutine 充当主线程，从而让调用方（测试 goroutine）
	// 明确处于「不是主线程」的位置。
	posted := make(chan func(), 8)
	s.bindPost(func(fn func()) { posted <- fn })
	mainDone := make(chan struct{})
	go func() {
		defer close(mainDone)
		for fn := range posted {
			fn()
		}
	}()

	// 在调用方 goroutine（= 非主线程）上发起动作，由上面那条 goroutine 跑批。
	if _, err := bus.invoke("test.where", nil); err != nil {
		t.Fatalf("test.where: %v", err)
	}
	close(posted)
	<-mainDone

	if seen.Load() == 0 {
		t.Fatal("动作体执行时不在主线程队列里（batchGID=0）：说明它是在调用方 goroutine 上直接跑的")
	}
	if myGID.Load() != seen.Load() {
		t.Fatalf("动作体跑在 goroutine %d，而主线程队列是 %d：两者必须相同",
			myGID.Load(), seen.Load())
	}
	if myGID.Load() == goroutineID() {
		t.Fatal("动作体跑在调用方 goroutine 上：这正是要修掉的跨线程写")
	}
}

// 反向：撤掉主线程投递（直接跑 fn），上一条的判据必须红。
// 这条用「手动模拟旧写法」来证明判据本身有效，不依赖改源码。
func TestActionOnTheCallerGoroutineWouldFailTheCheck(t *testing.T) {
	s, _ := sessionApp(t)
	bus := newDebugBus(s)

	var seen atomic.Uint64
	bus.register("test.legacy", func(args map[string]json.RawMessage) (any, error) {
		seen.Store(s.batchGID.Load())
		return nil, nil
	})
	s.bindPost(func(fn func()) { fn() })

	// 旧写法：调用方直接跑 fn（不经过主线程队列）。这里显式重现它。
	bus.mu.Lock()
	_, _ = bus.actions["test.legacy"](nil)
	bus.mu.Unlock()

	if seen.Load() != 0 {
		t.Fatalf("判据失效：在调用方 goroutine 上直接跑，batchGID 却是 %d", seen.Load())
	}
}

// ── ② 并发 socket：动作串行，不串状态 ───────────────────────────────────

// 两个连接同时打同一个动作，动作体不能重叠 —— 这是「串行」的定义。
// 同时验证：8 个连接各打 5 次 state.dump，全部 ok，且每次都读得到同一份稳定状态。
func TestConcurrentDebugSocketsSerializeActions(t *testing.T) {
	s, _ := sessionApp(t)
	s.sessionsChecked, s.sessionAPI = true, true
	s.sessions = []string{"main", "work"}
	s.navTab = navRoutine
	bus := newDebugBus(s)
	bus.timeout = 5 * time.Second

	var inFlight, maxInFlight atomic.Int32
	bus.register("test.slow", func(args map[string]json.RawMessage) (any, error) {
		now := inFlight.Add(1)
		for {
			old := maxInFlight.Load()
			if now <= old || maxInFlight.CompareAndSwap(old, now) {
				break
			}
		}
		time.Sleep(3 * time.Millisecond) // 拉宽重叠窗口，让竞态真的有机会发生
		inFlight.Add(-1)
		return map[string]any{"nav": s.navTab}, nil
	})

	posted := make(chan func(), 256)
	s.bindPost(func(fn func()) { posted <- fn })
	stopMain := make(chan struct{})
	var mainWG sync.WaitGroup
	mainWG.Add(1)
	go func() {
		defer mainWG.Done()
		for {
			select {
			case fn := <-posted:
				fn()
			case <-stopMain:
				return
			}
		}
	}()

	socket := filepath.Join("/tmp", fmt.Sprintf("crew-mt-%d.sock", os.Getpid()))
	t.Cleanup(func() { _ = os.Remove(socket) })
	t.Setenv("CREW_DEBUG_SOCK", socket)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := bus.serveDebug(ctx); err != nil {
		t.Fatalf("调试口开不起来：%v", err)
	}

	const connections, perConnection = 8, 5
	var wg sync.WaitGroup
	errs := make(chan error, connections*perConnection)
	for i := 0; i < connections; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < perConnection; j++ {
				action := "state.dump"
				if j%2 == 0 {
					action = "test.slow"
				}
				if _, err := debugOverSocket(socket, action, nil); err != nil {
					errs <- fmt.Errorf("连接 %d 第 %d 次 %s: %w", i, j, action, err)
					return
				}
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	close(stopMain)
	mainWG.Wait()

	for err := range errs {
		t.Fatalf("并发调用失败：%v", err)
	}
	if got := maxInFlight.Load(); got > 1 {
		t.Fatalf("动作体重叠了 %d 层：动作必须串行执行", got)
	}
}

// 并发读状态不能读到「一半改完」的值：一个动作成对写两个字段，读者要么看到
// 两个旧值、要么两个新值。串行执行下这条恒成立；跨线程并发下会出现撕裂。
func TestConcurrentDumpsNeverSeeATornState(t *testing.T) {
	s, _ := sessionApp(t)
	s.sessionsChecked, s.sessionAPI = true, true
	bus := newDebugBus(s)
	bus.timeout = 5 * time.Second

	// 成对不变量：sidebarClosed 与 navTab 一起变。动作体是原子的（都在主线程上），
	// 所以任何一刻读到的都必须是「同一对」。
	bus.register("test.pair", func(args map[string]json.RawMessage) (any, error) {
		s.sidebarClosed = !s.sidebarClosed
		if s.sidebarClosed {
			s.navTab = navMemory
		} else {
			s.navTab = navBoard
		}
		return nil, nil
	})

	posted := make(chan func(), 256)
	s.bindPost(func(fn func()) { posted <- fn })
	stopMain := make(chan struct{})
	var mainWG sync.WaitGroup
	mainWG.Add(1)
	go func() {
		defer mainWG.Done()
		for {
			select {
			case fn := <-posted:
				fn()
			case <-stopMain:
				return
			}
		}
	}()

	socket := filepath.Join("/tmp", fmt.Sprintf("crew-pair-%d.sock", os.Getpid()))
	t.Cleanup(func() { _ = os.Remove(socket) })
	t.Setenv("CREW_DEBUG_SOCK", socket)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := bus.serveDebug(ctx); err != nil {
		t.Fatalf("调试口开不起来：%v", err)
	}

	var wg sync.WaitGroup
	torn := make(chan string, 16)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 8; j++ {
				action := "test.pair"
				if j%3 == 0 {
					action = "state.dump"
				}
				response, err := debugOverSocket(socket, action, nil)
				if err != nil {
					torn <- err.Error()
					return
				}
				if action != "state.dump" {
					continue
				}
				result, _ := response["result"].(map[string]any)
				closed, _ := result["sidebarClosed"].(bool)
				nav, _ := result["nav"].(string)
				if closed && nav != "memory" || !closed && nav != "board" {
					torn <- fmt.Sprintf("读到撕裂状态 sidebarClosed=%v nav=%s", closed, nav)
					return
				}
			}
		}(i)
	}
	wg.Wait()
	close(stopMain)
	mainWG.Wait()
	close(torn)
	for problem := range torn {
		t.Fatalf("并发读状态：%s", problem)
	}
}

// 真正的红点：产品 view() 与调试动作同时碰同一批字段。
//
// 这条是 -race 下才会说话的用例，也是唯一直接对准「真窗口」的判据：
// 主线程 goroutine 一帧一帧地画（view 读 navTab / sidebarClosed / selectedBot / input…），
// socket goroutine 同时按名字改它们。修复后动作体也在主线程上跑，两者串行 —— 干净；
// 旧写法（动作在 socket goroutine 上直接改）会让 -race 报同一批字段两个写者。
func TestDebugActionsDoNotRaceTheProductView(t *testing.T) {
	_, _, s := guiFixture(t)
	s.sessionsChecked, s.sessionAPI = true, true
	s.sessions = []string{"main", "work"}
	bus := newDebugBus(s)
	bus.timeout = 5 * time.Second

	// 主线程：收到任务就跑，没任务就画一帧。view() 在真窗口里就是这样被反复调用的。
	posted := make(chan func(), 256)
	s.bindPost(func(fn func()) { posted <- fn })
	tt := sessionGUI(s)
	stop := make(chan struct{})
	var mainWG sync.WaitGroup
	mainWG.Add(1)
	go func() {
		defer mainWG.Done()
		for {
			select {
			case fn := <-posted:
				fn()
			case <-stop:
				return
			default:
				tt.Frame()
				time.Sleep(200 * time.Microsecond)
			}
		}
	}()

	socket := filepath.Join("/tmp", fmt.Sprintf("crew-race-%d.sock", os.Getpid()))
	t.Cleanup(func() { _ = os.Remove(socket) })
	t.Setenv("CREW_DEBUG_SOCK", socket)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := bus.serveDebug(ctx); err != nil {
		t.Fatalf("调试口开不起来：%v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 12; j++ {
				for _, action := range []string{"sidebar.toggle", "nav.routines", "nav.board", "state.dump"} {
					if _, err := debugOverSocket(socket, action, nil); err != nil {
						t.Errorf("socket 上 %s 失败：%v", action, err)
						return
					}
				}
			}
		}()
	}
	wg.Wait()
	close(stop)
	mainWG.Wait()
}

// ── ③ 超时：主线程不来就明确报错，不永远挂着 ─────────────────────────────

// 主线程队列绑上了但没人跑：动作必须在 timeout 内返回明确错误。
func TestDebugActionTimesOutWhenTheMainThreadNeverRuns(t *testing.T) {
	s, _ := sessionApp(t)
	bus := newDebugBus(s)
	bus.timeout = 120 * time.Millisecond
	bus.register("test.noop", func(args map[string]json.RawMessage) (any, error) { return "ran", nil })

	// 绑了队列但故意不跑：模拟主线程卡住 / 窗口线程被占住。
	queued := make(chan func(), 4)
	s.bindPost(func(fn func()) { queued <- fn })

	start := time.Now()
	_, err := bus.invoke("test.noop", nil)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("主线程没跑，动作却成功了")
	}
	if elapsed > time.Second {
		t.Fatalf("超时用了 %s，应接近设定的 120ms", elapsed)
	}
	// 错误里要有动作名，外部脚本才知道是哪一条超时了。
	if got := err.Error(); !strings.Contains(got, "test.noop") {
		t.Fatalf("超时错误没带动作名：%s", got)
	}
	// 动作体确实一次都没跑。
	if len(queued) != 1 {
		t.Fatalf("队列里应有 1 个待跑任务，实际 %d", len(queued))
	}
	select {
	case fn := <-queued:
		fn() // 晚到的主线程跑它：结果写进已无人接收的 channel，不能 panic
	case <-time.After(100 * time.Millisecond):
		t.Fatal("任务没排进主线程队列")
	}
}

// 超时的语义是「调用方不再等」，**不是「动作被撤销」**。
//
// 这条把当前行为钉死：超时之后主线程恢复，那条动作照样执行、副作用照样发生。
// 若将来引入真正的取消机制，这条会红 —— 那时要同步改文档与外部脚本的假设
// （它们现在按「超时≠没发生」写的）。钉住它比让它默默漂移安全。
func TestTimedOutActionStillRunsWhenTheMainThreadComesBack(t *testing.T) {
	s, _ := sessionApp(t)
	bus := newDebugBus(s)
	bus.timeout = 100 * time.Millisecond

	var ran atomic.Int32
	bus.register("test.late", func(args map[string]json.RawMessage) (any, error) {
		ran.Add(1)
		s.sidebarClosed = true // 副作用：改状态
		return "ran", nil
	})

	queued := make(chan func(), 4)
	s.bindPost(func(fn func()) { queued <- fn })

	_, err := bus.invoke("test.late", nil)
	if err == nil {
		t.Fatal("主线程没跑，动作却成功了")
	}
	if ran.Load() != 0 {
		t.Fatalf("超时之前不该执行过，实际 %d 次", ran.Load())
	}

	// 主线程恢复：把排着的任务跑掉。
	select {
	case fn := <-queued:
		fn()
	case <-time.After(time.Second):
		t.Fatal("任务没留在主线程队列里")
	}
	if ran.Load() != 1 {
		t.Fatalf("超时后主线程恢复，动作应照常执行一次，实际 %d 次", ran.Load())
	}
	if !s.sidebarClosed {
		t.Fatal("动作的副作用没落地：超时并不撤销动作")
	}
}

// ── ④ 生命周期：队列收掉后立刻返回，不干等超时 ──────────────────────────

// closeMain 之后：新的动作立刻拿到 errMainClosed，等着的动作也被立刻放行。
func TestDebugActionFailsFastAfterTheQueueCloses(t *testing.T) {
	s, _ := sessionApp(t)
	bus := newDebugBus(s)
	bus.timeout = 10 * time.Second // 故意很长：证明不是靠超时返回的
	bus.register("test.noop", func(args map[string]json.RawMessage) (any, error) { return "ran", nil })

	queued := make(chan func(), 4)
	s.bindPost(func(fn func()) { queued <- fn })

	// 先在后台起一条会一直等的调用。
	done := make(chan error, 1)
	go func() {
		_, err := bus.invoke("test.noop", nil)
		done <- err
	}()
	// 等它真的排进队列（= 已经在等主线程）。
	select {
	case <-queued:
	case <-time.After(time.Second):
		t.Fatal("动作没排进主线程队列")
	}

	start := time.Now()
	s.closeMain()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("队列关了，动作却成功了")
		}
		if !isMainClosed(err) {
			t.Fatalf("错误应是 errMainClosed，实际：%v", err)
		}
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Fatalf("关队列后用了 %s 才返回，应立刻返回", elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("关队列后动作还在等：这不是「立刻返回」")
	}

	// 关掉之后新来的动作也不许悄悄成功。
	if _, err := bus.invoke("test.noop", nil); err == nil || !isMainClosed(err) {
		t.Fatalf("关队列后的新动作应立刻报 errMainClosed，实际：%v", err)
	}
	// 关两次不能 panic。
	s.closeMain()
}

// 队列收掉之后，postMain 不再接受任务（否则任务进了一个永远不跑的队列）。
func TestPostMainIsRefusedAfterClose(t *testing.T) {
	s, _ := sessionApp(t)
	ran := 0
	s.closeMain()
	s.postMain(func() { ran++ })
	s.runPending()
	if ran != 0 {
		t.Fatalf("关掉之后的任务仍被执行了 %d 次", ran)
	}
}

// ── ⑤ 连接生命周期：窗口关掉后连接被收掉，不是「连着但没反应」 ──────────

// closeConnections 之后：已建立的连接被关闭（再读写得到 EOF），新连接连不上。
func TestCloseConnectionsEndsOpenSockets(t *testing.T) {
	s, _ := sessionApp(t)
	bus := newDebugBus(s)
	bus.register("test.noop", func(args map[string]json.RawMessage) (any, error) { return "ran", nil })

	// 有主线程队列但故意不跑：让连接停在「等主线程」上，模拟窗口卡住时挂着的外部脚本。
	queued := make(chan func(), 8)
	s.bindPost(func(fn func()) { queued <- fn })

	socket := filepath.Join("/tmp", fmt.Sprintf("crew-close-%d.sock", os.Getpid()))
	t.Cleanup(func() { _ = os.Remove(socket) })
	t.Setenv("CREW_DEBUG_SOCK", socket)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := bus.serveDebug(ctx); err != nil {
		t.Fatalf("调试口开不起来：%v", err)
	}

	conn, err := net.DialTimeout("unix", socket, 2*time.Second)
	if err != nil {
		t.Fatalf("连不上：%v", err)
	}
	defer conn.Close()
	payload, _ := json.Marshal(map[string]any{"action": "test.noop"})
	if _, err := conn.Write(append(payload, '\n')); err != nil {
		t.Fatalf("写不进去：%v", err)
	}
	// 等这条请求真的进到「等主线程」那一步。
	select {
	case <-queued:
	case <-time.After(2 * time.Second):
		t.Fatal("请求没排进主线程队列")
	}

	bus.closeConnections()

	// 连接应被服务端关掉：读会拿到 EOF，而不是一直挂着。
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buffer := make([]byte, 64)
	if _, err := conn.Read(buffer); err == nil {
		t.Fatal("连接没被关掉：还能读到数据")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("连接既没关也没回话：外部脚本会看到「连着但没反应」")
	}

	// 新连接连不上（listener 已关）。
	if _, err := net.DialTimeout("unix", socket, 300*time.Millisecond); err == nil {
		t.Fatal("listener 已关，却还能建立新连接")
	}
}

// ── 小工具 ───────────────────────────────────────────────────────────────

// isMainClosed 判断错误链里是不是 errMainClosed。
func isMainClosed(err error) bool {
	for err != nil {
		if err == errMainClosed {
			return true
		}
		type unwrapper interface{ Unwrap() error }
		wrapped, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = wrapped.Unwrap()
	}
	return false
}
