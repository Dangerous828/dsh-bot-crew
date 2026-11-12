//go:build !darwin || !cgo

package main

import "errors"

// 非 macOS 或关掉 cgo 的编译：明确说没有原生录音，不假装有麦克风。
func micUnavailableReason() string {
	return "这次编译没有 macOS 原生录音（需要 darwin + cgo + AVFoundation），语音输入不会假装录到声音"
}

func micStatus() int        { return micUnknown }
func micRequest() int       { return micUnknown }
func micStart(string) error { return errors.New(micUnavailableReason()) }
func micStop() error        { return errors.New(micUnavailableReason()) }
func micCancel()            {}
