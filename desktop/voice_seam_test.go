package main

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 假录音器：写固定 WAV 字节，不碰真麦克风。用 actionState.recorder 这个 seam 注入，
// 权限、转码、识别整条链都能自动化跑，真机验收只留给 GUI 与 TCC 弹窗。
type fakeRecorder struct {
	wav       []byte
	startErr  error
	stopErr   error
	cancelled bool
	started   bool
}

func (f *fakeRecorder) start() error          { f.started = true; return f.startErr }
func (f *fakeRecorder) stop() ([]byte, error) { return f.wav, f.stopErr }
func (f *fakeRecorder) cancel()               { f.cancelled = true }

func awaitAction(t *testing.T, s *app) actionResult {
	t.Helper()
	select {
	case result := <-s.actions.results:
		s.applyAction(result)
		return result
	case <-time.After(3 * time.Second):
		t.Fatal("动作结果没有回到主线程")
		return actionResult{}
	}
}

// 入口 4 全链路：录音 → 16k mono WAV → POST /api/mobile/voice → 文字只进草稿，不发送。
func TestVoiceChainFillsDraftOnly(t *testing.T) {
	wav := makePCM16Wav(16000, 1, []int16{1, 2, 3, 4})
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/api/mobile/voice" {
			t.Errorf("识别之外还发了别的请求：%s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if !isWav(body) {
			t.Error("发给后端的不是 WAV 字节")
		}
		_, _ = w.Write([]byte(`{"available":true,"text":"把周报发我","language":"zh","provider":"sensevoice"}`))
	}))
	defer server.Close()

	s := &app{client: New(server.URL, "token", ""), actions: newActionState()}
	recorder := &fakeRecorder{wav: wav}
	s.actions.recorder = recorder
	s.startVoice()
	started := awaitAction(t, s)
	if started.state != "recording" || s.actions.voiceState != "recording" || s.input != "" {
		t.Fatalf("录音没进入 recording：%+v / %+v", started, s.actions)
	}
	s.stopVoice()
	result := awaitAction(t, s)
	if !result.ok || result.text != "把周报发我" {
		t.Fatalf("识别结果不对：%+v", result)
	}
	if s.input != "把周报发我" || s.sending {
		t.Errorf("识别文字没只进草稿：input=%q sending=%v", s.input, s.sending)
	}
	if s.actions.voiceState != "" || !strings.Contains(s.actions.voiceNote, "没发出去") {
		t.Errorf("收尾状态不对：%+v", s.actions)
	}
	if calls != 1 || !recorder.started {
		t.Errorf("录音/识别次数不对：calls=%d started=%v", calls, recorder.started)
	}
}

// 取消：录音器收走、临时文件不留下、草稿不动、结果不冒充识别成功。
func TestVoiceCancelReleasesAndKeepsDraft(t *testing.T) {
	s := &app{actions: newActionState(), input: "已打了一半"}
	recorder := &fakeRecorder{}
	s.actions.recorder = recorder
	s.actions.voiceState = "recording"
	s.cancelVoice()
	result := awaitAction(t, s)
	if result.ok || result.text != "" || s.input != "已打了一半" {
		t.Errorf("取消产生了识别结果或改了草稿：%+v input=%q", result, s.input)
	}
	if !recorder.cancelled || s.actions.voiceState != "" || !strings.Contains(s.actions.voiceNote, "已取消") {
		t.Errorf("取消没收干净：cancelled=%v %+v", recorder.cancelled, s.actions)
	}
}

// 权限拒绝：明确显示原因，状态回到空闲，不进入 recording。
func TestVoiceStartPermissionDenied(t *testing.T) {
	s := &app{actions: newActionState()}
	s.actions.recorder = &fakeRecorder{startErr: errors.New("麦克风权限被拒绝：到「系统设置 → 隐私与安全性 → 麦克风」允许这个桌面 App")}
	s.startVoice()
	result := awaitAction(t, s)
	if result.state != "" || s.actions.voiceState != "" || !strings.Contains(s.actions.voiceNote, "隐私与安全性") {
		t.Fatalf("权限拒绝没如实显示：%+v / %+v", result, s.actions)
	}
}

// 识别失败：后端 reason 原样显示，草稿不动。
func TestVoiceStopRefusalShowsReason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"available":false,"reason":"没听出字来"}`))
	}))
	defer server.Close()
	s := &app{client: New(server.URL, "token", ""), actions: newActionState(), input: "草稿"}
	s.actions.recorder = &fakeRecorder{wav: makePCM16Wav(16000, 1, []int16{1, 2})}
	s.actions.voiceState = "recording"
	s.stopVoice()
	result := awaitAction(t, s)
	if result.ok || result.text != "" || s.input != "草稿" {
		t.Errorf("识别失败还改了草稿：%+v input=%q", result, s.input)
	}
	if !strings.Contains(s.actions.voiceNote, "没听出字来") {
		t.Errorf("没把后端 reason 显示出来：%q", s.actions.voiceNote)
	}
}

// 录音收尾失败（例如设备被拔掉）：明确显示，不把错误当成一段空草稿。
func TestVoiceStopRecorderFailure(t *testing.T) {
	s := &app{actions: newActionState()}
	s.actions.recorder = &fakeRecorder{stopErr: errors.New("录音没有正常收尾")}
	s.actions.voiceState = "recording"
	s.stopVoice()
	result := awaitAction(t, s)
	if result.ok || !strings.Contains(s.actions.voiceNote, "录音没有正常收尾") {
		t.Errorf("录音失败没如实显示：%+v / %q", result, s.actions.voiceNote)
	}
}
