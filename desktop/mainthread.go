package main

// mainthread.go —— 「我现在是不是在主线程上」这一件事的唯一实现。
//
// 为什么要它：mygo 的主线程队列（Window.Update / view）跑在某一条 goroutine 上，
// 而调试口的 socket 处理在另一些 goroutine 上。把动作投给主线程之前必须先认出
// 「我是不是已经在那儿了」—— 主线程把任务排进自己的队列再等它执行，是必死的死锁。
//
// 实现是读 runtime.Stack 的第一行（goroutine N [...]）。标准库没有导出 goroutine id，
// 但这一行的格式是 runtime 的稳定输出，且只在两条边界上用（入队前判一次、绑定窗口时记一次），
// 不在热路径里：一次 ~200 字节的栈读取，与一次状态推进相比可以忽略。

import (
	"bytes"
	"errors"
	"runtime"
	"strconv"
)

// errMainClosed 是主线程队列已经收掉（窗口关了 / 应用退了）时，runOnMain 的返回值。
// 明确报错而不是干等：调用方该知道「这条动作永远不会执行了」。
var errMainClosed = errors.New("窗口已经关掉，这条动作不会执行")

// goroutineID 返回当前 goroutine 的编号。取不到时返回 0（调用方按「不是主线程」处理）。
func goroutineID() uint64 {
	var buf [64]byte
	n := runtime.Stack(buf[:], false)
	// 形如 "goroutine 18 [running]:"。
	fields := bytes.Fields(buf[:n])
	if len(fields) < 2 || string(fields[0]) != "goroutine" {
		return 0
	}
	id, err := strconv.ParseUint(string(fields[1]), 10, 64)
	if err != nil {
		return 0
	}
	return id
}
