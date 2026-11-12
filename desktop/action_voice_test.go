package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 造一份 44 字节头的 PCM WAV，方便测重采样与格式拒绝。
func makePCM16Wav(rate, channels int, samples []int16) []byte {
	data := make([]byte, len(samples)*2)
	for i, s := range samples {
		binary.LittleEndian.PutUint16(data[i*2:i*2+2], uint16(s))
	}
	out := make([]byte, 44+len(data))
	copy(out[0:4], "RIFF")
	binary.LittleEndian.PutUint32(out[4:8], uint32(36+len(data)))
	copy(out[8:12], "WAVE")
	copy(out[12:16], "fmt ")
	binary.LittleEndian.PutUint32(out[16:20], 16)
	binary.LittleEndian.PutUint16(out[20:22], 1)
	binary.LittleEndian.PutUint16(out[22:24], uint16(channels))
	binary.LittleEndian.PutUint32(out[24:28], uint32(rate))
	binary.LittleEndian.PutUint32(out[28:32], uint32(rate*channels*2))
	binary.LittleEndian.PutUint16(out[32:34], uint16(channels*2))
	binary.LittleEndian.PutUint16(out[34:36], 16)
	copy(out[36:40], "data")
	binary.LittleEndian.PutUint32(out[40:44], uint32(len(data)))
	copy(out[44:], data)
	return out
}

// 入口 4：已经是 16k mono 的录音，PCM 数据一个字节都不改。
func TestNormalizeVoiceWavAlreadySpec(t *testing.T) {
	raw := makePCM16Wav(16000, 1, []int16{0, 100, -100, 200, -200})
	out, err := normalizeVoiceWav(raw)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	info, err := readPCM(out)
	if err != nil {
		t.Fatalf("输出不是可读 PCM：%v", err)
	}
	if info.sampleRate != 16000 || info.channels != 1 || info.bits != 16 {
		t.Errorf("输出规格不对：%+v", info)
	}
	if !bytes.Equal(info.data, raw[44:]) {
		t.Error("同规格录音被重采样改掉了")
	}
}

// 入口 4：44.1kHz 立体声要压成 16kHz 单声道，左右相反时混音应全静音。
func TestNormalizeVoiceWavResamplesAndMixes(t *testing.T) {
	const frames = 4410 // 0.1 秒 @44.1k
	samples := make([]int16, frames*2)
	for i := 0; i < frames; i++ {
		samples[i*2], samples[i*2+1] = 100, -100
	}
	out, err := normalizeVoiceWav(makePCM16Wav(44100, 2, samples))
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	info, err := readPCM(out)
	if err != nil {
		t.Fatalf("输出不是可读 PCM：%v", err)
	}
	if info.sampleRate != 16000 || info.channels != 1 || info.bits != 16 {
		t.Errorf("输出规格不对：%+v", info)
	}
	if got := len(info.data) / 2; got != 1600 {
		t.Errorf("重采样后 %d 帧，要 1600 帧", got)
	}
	for i := 0; i+2 <= len(info.data); i += 2 {
		if got := int16(binary.LittleEndian.Uint16(info.data[i : i+2])); got != 0 {
			t.Fatalf("左右相反的两声道没混成静音：第 %d 帧 = %d", i/2, got)
		}
	}
}

// 入口 4：格式不对、空录音、超长、过大都在本地拦下，不白跑一次识别。
func TestNormalizeVoiceWavRefusals(t *testing.T) {
	noFmt := make([]byte, 44)
	copy(noFmt[0:4], "RIFF")
	copy(noFmt[8:12], "WAVE")
	copy(noFmt[36:40], "data")
	eightBit := makePCM16Wav(16000, 1, []int16{1, 2})
	binary.LittleEndian.PutUint16(eightBit[34:36], 8)
	floatWav := makePCM16Wav(16000, 1, []int16{1, 2})
	binary.LittleEndian.PutUint16(floatWav[20:22], 3)
	tooLong := makePCM16Wav(1000, 1, make([]int16, 121001)) // 121 秒，但只有 242KB
	tooBig := make([]byte, maxVoiceBytes+1)
	copy(tooBig[0:4], "RIFF")
	copy(tooBig[8:12], "WAVE")

	for _, tc := range []struct {
		name string
		raw  []byte
		want string
	}{
		{"not a wav", []byte("not a wav"), "不是 WAV"},
		{"no fmt", noFmt, "没有 fmt 块"},
		{"8 bit", eightBit, "不是 16 位 PCM"},
		{"float", floatWav, "不是整数 PCM"},
		{"empty data", makePCM16Wav(16000, 1, nil), "没有声音数据"},
		{"too long", tooLong, "一次最多 120 秒"},
		{"too big", tooBig, "一次最多 8 MB"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := normalizeVoiceWav(tc.raw)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("要报错含 %q，实际 out=%d bytes err=%v", tc.want, len(out), err)
			}
			if out != nil {
				t.Error("拒绝时不该还交出音频")
			}
		})
	}
}

// 入口 4：识别契约（mobile-http.ts:492-501 / voice.ts 的 Transcript）。
func TestParseTranscript(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   string
		bad    string
	}{
		{"ok", 200, `{"available":true,"text":"把周报发我","language":"zh","provider":"sensevoice"}`, "把周报发我", ""},
		{"backend not wired", 200, `{"available":false,"reason":"这台后端没有接入语音识别"}`, "", "这台后端没有接入语音识别"},
		{"nothing heard", 200, `{"available":false,"reason":"没听出字来"}`, "", "没听出字来"},
		{"blank text", 200, `{"available":true,"text":"   "}`, "", "后端没给出识别文字"},
		{"missing text", 200, `{"available":true}`, "", "后端没给出识别文字"},
		{"bad request", 400, `{"error":"Invalid JSON"}`, "", "Invalid JSON"},
		{"unauthorized", 401, `{"error":"Unauthorized"}`, "", "token 不对"},
		{"not json", 200, `not json`, "", "读不懂识别结果"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseTranscript(tc.status, []byte(tc.body))
			if tc.bad != "" {
				if err == nil || !strings.Contains(err.Error(), tc.bad) {
					t.Fatalf("要报错含 %q，实际 got=%q err=%v", tc.bad, got, err)
				}
				if got != "" {
					t.Error("失败时不该带回识别文字")
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got=%q err=%v，要 %q", got, err, tc.want)
			}
		})
	}
}

// 入口 4：客户端把 WAV 原字节发给 /api/mobile/voice，识别文字带回来。
func TestClientVoiceRoundTrip(t *testing.T) {
	wav := makePCM16Wav(16000, 1, []int16{1, 2, 3})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/mobile/voice" {
			t.Errorf("打错端点了：%s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); got != "audio/wav" {
			t.Errorf("语音输入要 audio/wav 原字节：%q", got)
		}
		body, _ := io.ReadAll(r.Body)
		if !bytes.Equal(body, wav) {
			t.Error("发过去的不是那段 WAV 原字节（可能被 JSON 或 base64 包了一层）")
		}
		_, _ = w.Write([]byte(`{"available":true,"text":"把周报发我"}`))
	}))
	defer server.Close()
	text, err := New(server.URL, "token", "").Voice(context.Background(), wav)
	if err != nil || text != "把周报发我" {
		t.Fatalf("Voice = %q, %v", text, err)
	}
}

// 入口 4：没接识别能力时把后端 reason 带回来；空/非 WAV 输入本地就拒，不发请求。
func TestClientVoiceRefusals(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"available":false,"reason":"这台后端没有接入语音识别"}`))
	}))
	defer server.Close()
	client := New(server.URL, "token", "")
	if _, err := client.Voice(context.Background(), makePCM16Wav(16000, 1, []int16{1})); err == nil ||
		!strings.Contains(err.Error(), "这台后端没有接入语音识别") {
		t.Fatalf("没把后端 reason 带回来：%v", err)
	}
	for _, bad := range [][]byte{nil, []byte("nope")} {
		if _, err := client.Voice(context.Background(), bad); err == nil {
			t.Error("空/非 WAV 输入也被发出去了")
		}
	}
	if calls != 1 {
		t.Errorf("多发了 %d 个注定失败的请求", calls-1)
	}
}

// 权限拒绝、受限、超时都要有能照着做的中文；已授权不显示任何话。
func TestMicStatusMessage(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   string
	}{
		{micDenied, "隐私与安全性"},
		{micRestricted, "限制使用"},
		{micNotDetermined, "还没决定"},
		{micUnknown, "查不出"},
		{micGranted, ""},
	} {
		if got := micStatusMessage(tc.status); !strings.Contains(got, tc.want) {
			t.Errorf("status %d = %q，要含 %q", tc.status, got, tc.want)
		}
	}
}

// 没在录音时 stop 明确说没有，cancel 安全空转；两者都不碰麦克风。
func TestMicSessionIdleIsSafe(t *testing.T) {
	if _, err := mic.stop(); err == nil || !strings.Contains(err.Error(), "现在没有在录音") {
		t.Fatalf("空闲 stop 没如实说：%v", err)
	}
	mic.cancel()
}

// 取消与失败都不写草稿；只有 ok 且带文字时才把字并进输入框。
func TestVoiceStateTransitionsKeepDraft(t *testing.T) {
	s := &app{actions: newActionState(), input: "已打了一半"}
	s.applyAction(actionResult{kind: "voice", state: "recording", note: "正在录音"})
	if s.actions.voiceState != "recording" || s.input != "已打了一半" {
		t.Fatal("进入录音状态就动了草稿")
	}
	s.applyAction(actionResult{kind: "voice", state: "", note: voiceCancelNote()})
	if s.actions.voiceState != "" || s.input != "已打了一半" || !strings.Contains(s.actions.voiceNote, "已取消") {
		t.Fatalf("取消没如实收尾：%+v", s.actions)
	}
	s.applyAction(actionResult{kind: "voice", state: "", note: "没识别成功：没听出字来"})
	if s.input != "已打了一半" {
		t.Error("识别失败还改了草稿")
	}
}
