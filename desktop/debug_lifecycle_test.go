package main

// debug_lifecycle_test.go —— 收口与完成撞在一起时的三条生命周期缺陷（F1/F2/F3）。
//
// 三件事同一个根：**「已经收口」与「动作/监听器已经就绪」是两个独立信号，
// 而代码按「谁先被调度」决定结论**。于是同一份状态会给出方向相反的答复：
//   F1 动作已经跑完，调用方却拿到「这条动作不会执行」；
//   F2 listener 一边无锁写、一边锁内读；
//   F3 收口之后再 bind，留下一个连得上、永远没回话的死 socket。
//
// 判据全部是确定性的：不靠随机压测碰运气，而是把两个信号**都摆成 ready**
// 再让代码去选（F1 用固定轮数，两 case 同时 ready 时 select 每轮各半），
// 或者用受控次序（F3 先收口再启动）。

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// ── F1：完成与收口同时就绪，结果必须优先于「不会执行」 ──────────────────

// 动作已经执行完（done 里已有答案），同一刻窗口也收了口。
// select 在两个 case 同时 ready 时随机选一个 —— 选中 closedCh 就把「已执行、
// 副作用已落地」报成「这条动作不会执行」，外部脚本据此重试就是重复副作用。
//
// 这里把两个信号都摆好再进 select：post 回调里先把动作跑完，再收口，然后才返回。
// 所以 runOnMain 走到 select 时两个 case 必然同时 ready，每轮各有一次机会选错；
// 固定 200 轮，修前几乎必然至少错一次。
func TestRunOnMainPrefersFinishedResultOverClosed(t *testing.T) {
	for i := 0; i < 200; i++ {
		s := newApp(nil)
		executed := false
		// 同步 post：先跑完动作（done 就绪），再收口（closedCh 关闭），然后返回 ——
		// 让 runOnMain 一定在两者都 ready 之后才进入 select。
		s.bindPost(func(fn func()) {
			fn()
			s.closeMain()
		})
		err := s.runOnMain(time.Second, func() { executed = true })
		if !executed {
			t.Fatalf("第 %d 轮：动作没被执行，用例前提就不成立", i)
		}
		if isMainClosed(err) {
			t.Fatalf("第 %d 轮：动作已执行完，调用方却拿到「不会执行」(%v)", i, err)
		}
		if err != nil {
			t.Fatalf("第 %d 轮：动作成功完成，却返回错误 %v", i, err)
		}
	}
}

// 同一个根的另一面：动作已完成，但计时器也在同一刻到期。
// 报「没有执行完」同样是方向相反的结论 —— 它已经执行完了。
//
// 构造：超时给 1ns，动作在同步 post 里立刻跑完，于是 runOnMain 进 select 时
// done 与 timer.C 都已经 ready，每轮各有一半机会选错。
func TestRunOnMainPrefersFinishedResultOverTimeout(t *testing.T) {
	for i := 0; i < 200; i++ {
		s := newApp(nil)
		executed := false
		s.bindPost(func(fn func()) { fn() })
		err := s.runOnMain(time.Nanosecond, func() { executed = true })
		if !executed {
			t.Fatalf("第 %d 轮：动作没被执行，用例前提就不成立", i)
		}
		if err != nil {
			t.Fatalf("第 %d 轮：动作已执行完，却返回 %v", i, err)
		}
	}
}

// ── F2：serveDebug 与 closeConnections 并发，listener 必须一把锁 ─────────

// 并发 serve / close 50 轮：-race 下修前点名 bus.listener 的无锁写；
// 不带 -race 时也有语义判据 —— 收口之后不许留下一个还能连上的 listener。
//
// 两个失败模式都来自同一个根：写 listener 与读 listener 不在同一把锁里，
// close 可能在「Listen 成功」与「登记 listener」之间跑过，于是它读到 nil，
// 那个 listener 再没人关。
func TestServeDebugAndCloseConnectionsRaceSafely(t *testing.T) {
	// unix socket 路径上限 104 字节，t.TempDir() 在 macOS 上就超了。
	socket := shortSocket(t, "crew-race")
	t.Setenv("CREW_DEBUG_SOCK", socket)

	for i := 0; i < 50; i++ {
		s := newApp(nil)
		bus := newDebugBus(s)
		ctx, cancel := context.WithCancel(context.Background())

		var wg sync.WaitGroup
		wg.Add(2)
		start := make(chan struct{})
		go func() {
			defer wg.Done()
			<-start
			_ = bus.serveDebug(ctx)
		}()
		go func() {
			defer wg.Done()
			<-start
			bus.closeConnections()
		}()
		close(start)
		wg.Wait()
		cancel()

		// 收口之后 listener 必须已经收掉：还能连上就是「连着但没回话」。
		if conn, err := net.DialTimeout("unix", socket, 200*time.Millisecond); err == nil {
			_ = conn.Close()
			t.Fatalf("第 %d 轮：收口之后 socket 还能连上，listener 泄漏了", i)
		}
	}
}

// ── F3：收口之后不许再 bind ──────────────────────────────────────────────

// closeConnections 之后 serveDebug：修前 net.Listen 照样成功（它不知道 connClosed），
// accept 循环拿到第一条连接就被 trackConn 拒绝并 return —— listener 还开着，
// 再没人 accept。于是留下一个连得上、写得进、永远没回话的死 socket。
func TestServeDebugAfterCloseLeavesNoSocket(t *testing.T) {
	socket := shortSocket(t, "crew-closed")
	t.Setenv("CREW_DEBUG_SOCK", socket)

	s := newApp(nil)
	bus := newDebugBus(s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	bus.closeConnections()

	if err := bus.serveDebug(ctx); err == nil {
		t.Fatal("已经收口，调试口却开起来了")
	} else if !isMainClosed(err) {
		t.Fatalf("收口后启动应报 errMainClosed，实际：%v", err)
	}

	if _, err := os.Stat(socket); err == nil {
		t.Fatal("收口后启动仍留下了 socket 文件")
	}
	if conn, err := net.DialTimeout("unix", socket, 200*time.Millisecond); err == nil {
		_ = conn.Close()
		t.Fatal("收口后启动仍留下可连接的 socket：死 socket")
	}
}

// 收口之后再启动两次，也不能在第二次把第一次留下的东西「复活」。
func TestServeDebugAfterCloseIsIdempotent(t *testing.T) {
	socket := shortSocket(t, "crew-closed-twice")
	t.Setenv("CREW_DEBUG_SOCK", socket)

	s := newApp(nil)
	bus := newDebugBus(s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	bus.closeConnections()
	for i := 0; i < 3; i++ {
		if err := bus.serveDebug(ctx); !isMainClosed(err) {
			t.Fatalf("第 %d 次：应报 errMainClosed，实际 %v", i, err)
		}
	}
	if _, err := os.Stat(socket); err == nil {
		t.Fatal("反复启动后仍留下 socket 文件")
	}
}

// shortSocket 给一条短的 unix socket 路径。sun_path 只有 104 字节，
// t.TempDir() 在 macOS 上的路径就超过这个长度，Listen 会报 bind: invalid argument。
func shortSocket(t *testing.T, name string) string {
	t.Helper()
	socket := filepath.Join(os.TempDir(), fmt.Sprintf("%s-%d.sock", name, os.Getpid()))
	t.Cleanup(func() { _ = os.Remove(socket) })
	return socket
}
