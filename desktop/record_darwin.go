//go:build darwin && cgo

// macOS 原生录音：AVFoundation 的 AVAudioRecorder 直接写 16kHz / 单声道 / 16 位 WAV。
// 权限走 AVCaptureDevice 的 authorizationStatus / requestAccess；拒绝、取消都如实报回 Go。
//
// 下面那段注释是 cgo 预导言，会被原样交给 clang 编译：里面只能写 C 声明，
// 不能写中文 —— 中文标点会被当成标识符字符，直接编译失败。
package main

// #cgo darwin CFLAGS: -x objective-c
// #cgo darwin LDFLAGS: -framework Foundation -framework AVFoundation
// #include <stdlib.h>
//
// int crew_mic_status(void);
// int crew_mic_request(void);
// int crew_record_start(const char *path);
// int crew_record_stop(void);
// void crew_record_cancel(void);
// const char *crew_last_error(void);
import "C"

import (
	"errors"
	"strings"
	"unsafe"
)

func micUnavailableReason() string { return "" }

func micStatus() int { return int(C.crew_mic_status()) }

func micRequest() int { return int(C.crew_mic_request()) }

func micStart(path string) error {
	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))
	if C.crew_record_start(cpath) == 0 {
		if reason := strings.TrimSpace(C.GoString(C.crew_last_error())); reason != "" {
			return errors.New(reason)
		}
		return errors.New("macOS 没能开始录音，系统没有给出原因")
	}
	return nil
}

func micStop() error {
	if C.crew_record_stop() == 0 {
		if reason := strings.TrimSpace(C.GoString(C.crew_last_error())); reason != "" {
			return errors.New(reason)
		}
		return errors.New("录音没有正常收尾")
	}
	return nil
}

func micCancel() { C.crew_record_cancel() }
