package main

import (
	"errors"
	"strings"
	"testing"
)

func TestActionNoteMapsKnownEnglishErrors(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"text is required", "少了要念的文字"},
		{"no speech provider", "没找到可用的语音服务"},
		{"connection refused", "没连上队伍，稍后再试"},
		{"some internal explode", "这次没成功，稍后再试"},
	}
	for _, tc := range cases {
		got := actionNote("播报没成功", errors.New(tc.raw))
		if !strings.HasSuffix(got, tc.want) {
			t.Errorf("原始错误 %q 翻成了 %q，想要后缀 %q", tc.raw, got, tc.want)
		}
		if strings.Contains(got, tc.raw) {
			t.Errorf("英文内部错误 %q 直接上了界面：%q", tc.raw, got)
		}
	}
}

func TestActionNoteKeepsChineseReason(t *testing.T) {
	for _, raw := range []string{
		"没听出字来",
		"麦克风权限被拒绝：到「系统设置 → 隐私与安全性 → 麦克风」允许这个桌面 App",
		"录音没有正常收尾",
		"afplay 退出 1",
	} {
		got := actionNote("没识别成功", errors.New(raw))
		if !strings.HasSuffix(got, raw) {
			t.Errorf("中文 reason 没原样显示：%q → %q", raw, got)
		}
	}
}

func TestActionNoteNilErrorUsesGenericCopy(t *testing.T) {
	got := actionNote("没识别成功", nil)
	if got != "没识别成功：这次没成功，稍后再试" {
		t.Errorf("nil 错误的说法是 %q", got)
	}
}

func TestActionErrorHumanNeverEchoesUnknownASCII(t *testing.T) {
	if got := actionErrorHuman("ENOSPC while writing /tmp/x"); strings.Contains(got, "ENOSPC") {
		t.Errorf("未知英文错误漏了原文：%q", got)
	}
}
