package main

import (
	"context"
	"time"
)

// voiceRecorderOf 用注入的录音器（测试里写固定 WAV 的假实现），
// 没注入就用真机的 micSession（record.go 的 AVFoundation 实现）。
func voiceRecorderOf(a *actionState) voiceRecorder {
	if a != nil && a.recorder != nil {
		return a.recorder
	}
	return &mic
}

// startVoice 在后台检查权限并开录；UI 先摆成 starting，连点不会叠出两个录音。
func (s *app) startVoice() {
	a := s.actions
	if a == nil || a.voiceState != "" {
		return
	}
	a.voiceState, a.voiceNote = "starting", "正在请求麦克风权限…"
	recorder := voiceRecorderOf(a)
	go func() {
		if err := recorder.start(); err != nil {
			s.deliver(actionResult{kind: "voice", state: "", note: "录音没开始：" + err.Error()})
			return
		}
		s.deliver(actionResult{kind: "voice", state: "recording", note: "正在录音，点「停止并识别」把话变成草稿"})
	}()
}

// stopVoice 收好录音 → 整理成 16k mono WAV → 交给后端识别 → 文字只进草稿。
// 整条链都在后台：请求麦克风、录、转码、识别都不碰 UI 线程。
func (s *app) stopVoice() {
	a := s.actions
	if a == nil || a.voiceState != "recording" {
		return
	}
	a.voiceState, a.voiceNote = "working", "正在整理录音…"
	recorder := voiceRecorderOf(a)
	go func() {
		raw, err := recorder.stop()
		if err != nil {
			s.deliver(actionResult{kind: "voice", state: "", note: "录音没收好：" + err.Error()})
			return
		}
		wav, err := normalizeVoiceWav(raw)
		if err != nil {
			s.deliver(actionResult{kind: "voice", state: "", note: "录音不合后端规格：" + err.Error()})
			return
		}
		if s.client == nil {
			s.deliver(actionResult{kind: "voice", state: "", note: "还没连上队伍，识别不了"})
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		text, err := s.client.Voice(ctx, wav)
		if err != nil {
			s.deliver(actionResult{kind: "voice", state: "", note: "没识别成功：" + err.Error()})
			return
		}
		s.deliver(actionResult{kind: "voice", state: "", note: "识别好了，文字只在草稿里，没发出去", text: text, ok: true})
	}()
}

// cancelVoice 取消录音：临时文件与录音器都收走，不产生草稿、不自动发。
func (s *app) cancelVoice() {
	a := s.actions
	if a == nil || a.voiceState != "recording" {
		return
	}
	a.voiceState, a.voiceNote = "working", "正在取消录音…"
	recorder := voiceRecorderOf(a)
	go func() {
		recorder.cancel()
		s.deliver(actionResult{kind: "voice", state: "", note: voiceCancelNote()})
	}()
}
