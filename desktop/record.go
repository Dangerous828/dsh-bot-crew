// 麦克风录音的平台无关外壳：权限状态、单例串行、临时文件与资源收尾。
// 真正的录音在 record_darwin.go/.m（AVFoundation）；其它平台是明确报错的桩。
package main

import (
	"errors"
	"fmt"
	"os"
	"sync"
)

// 权限状态与 AVFoundation 的 AVAuthorizationStatus 对应（record_darwin.m）。
const (
	micNotDetermined = 0
	micRestricted    = 1
	micDenied        = 2
	micGranted       = 3
	micUnknown       = -1
)

// micStatusMessage 把权限状态翻成一句能照着做的中文。已授权时返回空串。
func micStatusMessage(status int) string {
	switch status {
	case micDenied:
		return "麦克风权限被拒绝：到「系统设置 → 隐私与安全性 → 麦克风」允许这个桌面 App（打包时用 desktop/Info.plist 的 NSMicrophoneUsageDescription），再试一次"
	case micRestricted:
		return "这台机器的麦克风被限制使用（监管或家长控制），桌面拿不到录音"
	case micNotDetermined:
		return "还没决定是否允许用麦克风，请在系统弹出的提示里允许"
	case micGranted:
		return ""
	default:
		return "查不出麦克风权限状态（请求超时或系统没回应）"
	}
}

// micSession 串行化那一个录音器：Objective-C 侧只有一个 AVAudioRecorder 单例，
// 开始 / 停止 / 取消都走同一把锁，句柄不跨线程传。
type micSession struct {
	mu     sync.Mutex
	active bool
	path   string
}

var mic micSession

// start 检查并请求权限，建临时文件，交给平台开始录音。只在后台 goroutine 调。
func (m *micSession) start() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active {
		return errors.New("上一次录音还没结束")
	}
	if reason := micUnavailableReason(); reason != "" {
		return errors.New(reason)
	}
	status := micStatus()
	if status == micNotDetermined {
		status = micRequest()
	}
	if message := micStatusMessage(status); message != "" {
		return errors.New(message)
	}
	file, err := os.CreateTemp("", "crew-voice-*.wav")
	if err != nil {
		return fmt.Errorf("建录音临时文件: %w", err)
	}
	path := file.Name()
	file.Close()
	// AVAudioRecorder 要自己建这个文件，先收掉 CreateTemp 留下的空占位。
	os.Remove(path)
	if err := micStart(path); err != nil {
		os.Remove(path)
		return err
	}
	m.active, m.path = true, path
	return nil
}

// stop 停下来、读出 WAV 字节，临时文件一定删掉。
func (m *micSession) stop() ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.active {
		return nil, errors.New("现在没有在录音")
	}
	path := m.path
	m.active, m.path = false, ""
	defer os.Remove(path)
	if err := micStop(); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读录音: %w", err)
	}
	if len(data) == 0 {
		return nil, errors.New("录出来是空的")
	}
	return data, nil
}

// cancel 停止、删文件、释放 Objective-C 那一头的对象。取消后不产生草稿。
func (m *micSession) cancel() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.active {
		return
	}
	path := m.path
	m.active, m.path = false, ""
	micCancel()
	os.Remove(path)
}

// 取消之后的界面状态：不写草稿，只把这句实话留下。
func voiceCancelNote() string { return "已取消录音，临时文件已收走" }

// voiceRecorder 是录音动作的端口。生产实现是 micSession（AVFoundation），
// 测试里换成写固定 WAV 的假实现 —— 权限、转码、识别链都不用真开麦克风。
type voiceRecorder interface {
	start() error
	stop() ([]byte, error)
	cancel()
}
