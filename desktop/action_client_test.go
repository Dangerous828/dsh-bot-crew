package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// 最小 WAV：44 字节头 + 4 字节静音。parseSpeak / playWav 只认 RIFF....WAVE。
func testWav() []byte {
	wav := make([]byte, 48)
	copy(wav[0:4], "RIFF")
	copy(wav[8:12], "WAVE")
	copy(wav[12:16], "fmt ")
	copy(wav[36:40], "data")
	return wav
}

// 入口 2：按 mobile-http.ts:470-490 的真实契约分岔，成功/无能力/失败/错误状态都要分清。
func TestParseSpeakContract(t *testing.T) {
	for _, tc := range []struct {
		name          string
		status        int
		contentType   string
		headers       http.Header
		body          []byte
		wantErr       string
		wantSeconds   string
		wantTruncated bool
	}{
		{"wav ok", 200, "audio/wav", http.Header{"X-Speech-Seconds": {"1.25"}}, testWav(), "", "1.25", false},
		{"wav truncated with charset", 200, "audio/wav; charset=binary", http.Header{"X-Speech-Truncated": {"1"}}, testWav(), "", "", true},
		{"backend not wired", 200, "application/json", nil, []byte(`{"available":false,"reason":"这台后端没有接入播报"}`), "这台后端没有接入播报", "", false},
		{"say failed", 200, "application/json", nil, []byte(`{"available":false,"status":"failed","reason":"say 退出 1"}`), "say 退出 1", "", false},
		{"text required", 400, "application/json", nil, []byte(`{"error":"text is required"}`), "text is required", "", false},
		{"unauthorized", 401, "application/json", nil, []byte(`{"error":"Unauthorized"}`), "token 不对", "", false},
		{"wav without content type", 200, "application/json", nil, testWav(), "内容类型不是 audio/wav", "", false},
		{"json pretending to be wav", 200, "audio/wav", nil, []byte(`{"available":false}`), "RIFF/WAVE", "", false},
		{"empty 200", 200, "application/json", nil, nil, "没有说原因", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			clip, err := parseSpeak(tc.status, tc.contentType, tc.headers, tc.body)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("要报错含 %q，实际 clip=%v err=%v", tc.wantErr, clip, err)
				}
				if clip != nil {
					t.Error("报错时不该还带回可播的音频")
				}
				return
			}
			if err != nil {
				t.Fatalf("parseSpeak: %v", err)
			}
			if !bytes.Equal(clip.WAV, tc.body) || clip.Seconds != tc.wantSeconds || clip.Truncated != tc.wantTruncated {
				t.Errorf("clip 不对：len=%d seconds=%q truncated=%v", len(clip.WAV), clip.Seconds, clip.Truncated)
			}
		})
	}
}

// 入口 2：客户端把 text 发到 /api/mobile/speak，并把二进制与两个响应头原样带回来。
func TestClientSpeakRoundTrip(t *testing.T) {
	wav := testWav()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/mobile/speak" {
			t.Errorf("打错端点了：%s %s", r.Method, r.URL.Path)
		}
		var asked map[string]string
		if err := json.NewDecoder(r.Body).Decode(&asked); err != nil || asked["text"] != "今天做完了" {
			t.Errorf("播报正文不对：%v %v", asked, err)
		}
		w.Header().Set("Content-Type", "audio/wav")
		w.Header().Set("X-Speech-Seconds", "2.50")
		w.Header().Set("X-Speech-Truncated", "1")
		_, _ = w.Write(wav)
	}))
	defer server.Close()
	clip, err := New(server.URL, "token", "").Speak(context.Background(), "今天做完了")
	if err != nil {
		t.Fatalf("Speak: %v", err)
	}
	if !bytes.Equal(clip.WAV, wav) || clip.Seconds != "2.50" || !clip.Truncated {
		t.Errorf("WAV 或响应头没带回来：len=%d seconds=%q truncated=%v", len(clip.WAV), clip.Seconds, clip.Truncated)
	}
}

// 入口 2：后端没接播报时是 200 + JSON，客户端必须把它当失败，不能拿去播。
func TestClientSpeakRefusal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"available":false,"status":"unavailable","reason":"这台后端没有接入播报"}`))
	}))
	defer server.Close()
	clip, err := New(server.URL, "token", "").Speak(context.Background(), "念一句")
	if err == nil || !strings.Contains(err.Error(), "这台后端没有接入播报") {
		t.Fatalf("没把后端 reason 带回来：clip=%v err=%v", clip, err)
	}
	if clip != nil {
		t.Error("失败时不该有可播的音频")
	}
}

// 入口 2：临时文件在播完、播放失败后都要收走；非 WAV 根本不建文件、不播。
func TestPlayWavCleansTempFile(t *testing.T) {
	wav := testWav()
	t.Run("success", func(t *testing.T) {
		seen := ""
		err := playWav(wav, func(path string) error {
			seen = path
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			if !bytes.Equal(data, wav) {
				return errors.New("临时文件里不是那段 WAV")
			}
			return nil
		})
		if err != nil {
			t.Fatalf("playWav: %v", err)
		}
		if seen == "" {
			t.Fatal("没有把临时文件交给播放器")
		}
		if _, err := os.Stat(seen); !os.IsNotExist(err) {
			t.Errorf("播完临时文件没删：%s (%v)", seen, err)
		}
	})
	t.Run("player fails", func(t *testing.T) {
		seen := ""
		err := playWav(wav, func(path string) error {
			seen = path
			return errors.New("afplay 退出 1")
		})
		if err == nil || !strings.Contains(err.Error(), "afplay 退出 1") {
			t.Fatalf("播放失败没报出来：%v", err)
		}
		if _, err := os.Stat(seen); !os.IsNotExist(err) {
			t.Errorf("播放失败后临时文件没删：%s (%v)", seen, err)
		}
	})
	t.Run("not a wav", func(t *testing.T) {
		called := false
		if err := playWav([]byte("not a wav"), func(string) error { called = true; return nil }); err == nil {
			t.Error("非 WAV 也当成能播")
		}
		if called {
			t.Error("非 WAV 也去建文件播放了")
		}
	})
}
