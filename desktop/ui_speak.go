package main

import (
	"context"
	"strings"
	"time"
)

// speak 把一句 Bot 回复交给后端念成 WAV，再用系统播放器放出来。
// 要音频、写临时文件、afplay 整条链都在后台 goroutine，UI 不等它。
func (s *app) speak(text string) {
	a := s.actions
	if a == nil || s.client == nil || a.speaking || strings.TrimSpace(text) == "" {
		return
	}
	a.speaking, a.speakNote = true, "正在让队伍把这句话念出来…"
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		clip, err := s.client.Speak(ctx, text)
		if err != nil {
			s.deliver(actionResult{kind: "speak", note: "播报没成功：" + err.Error()})
			return
		}
		if err := playWav(clip.WAV, systemPlay); err != nil {
			s.deliver(actionResult{kind: "speak", note: "播报没成功：" + err.Error()})
			return
		}
		note := "已念完"
		if clip.Seconds != "" {
			note += "（" + clip.Seconds + " 秒）"
		}
		if clip.Truncated {
			note += "，太长只念了前一段"
		}
		s.deliver(actionResult{kind: "speak", ok: true, note: note})
	}()
}
