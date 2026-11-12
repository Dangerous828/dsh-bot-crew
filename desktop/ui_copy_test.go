package main

import (
	"strings"
	"testing"
	"time"
)

func TestHeaderUsesDesignCopy(t *testing.T) {
	a := &app{conversation: &Conversation{
		Bots:         []BotCard{{ID: "lead", Name: "大哥", Role: "前端", Persona: "前端 · 话少，先验再说"}},
		DefaultBotID: "lead",
	}}
	if got := a.title(); got != "大哥 · 前端" {
		t.Errorf("主标题没写成「名字 · 职能」：%q", got)
	}
	if got := a.subtitle(); got != "都在待命" {
		t.Errorf("常态副标题是 %q", got)
	}
	a.conversation.Tasks = []Task{{ID: "tk-1", Open: true, BotID: "lead",
		CreatedAt: time.Now().Add(-3 * time.Minute).Format(time.RFC3339)}}
	if got := a.subtitle(); !strings.HasPrefix(got, "正在工作 · ") || !strings.HasSuffix(got, "分钟") {
		t.Errorf("在跑时副标题没给状态 + 时长：%q", got)
	}
	a.conversation.Status.Paused = true
	if got := a.subtitle(); got != "已暂停" {
		t.Errorf("暂停时副标题是 %q", got)
	}
	if got := (&app{}).subtitle(); got != "正在读…" {
		t.Errorf("没读到队伍时副标题是 %q", got)
	}
}

func TestHeaderDoesNotInventElapsed(t *testing.T) {
	for _, at := range []string{"", "not-a-time", time.Now().Add(-48 * time.Hour).Format(time.RFC3339)} {
		if got := elapsedLabel(at); got != "" {
			t.Errorf("算不出的时长 %q 编成了 %q", at, got)
		}
	}
}

func TestComposerNoteUsesOneLinePriority(t *testing.T) {
	a := &app{actions: newActionState(), conversation: &Conversation{Bots: []BotCard{{ID: "lead", Name: "大哥"}}}}
	if got, danger := a.composerNote(); got != "都在待命，发出去就会接上" || danger {
		t.Errorf("常态是 %q / danger=%v", got, danger)
	}
	a.actions.speakNote = "已念完（3 秒）"
	if got, danger := a.composerNote(); got != "已念完（3 秒）" || danger {
		t.Errorf("播报回执没进状态带：%q / danger=%v", got, danger)
	}
	a.actions.speakNote = "播报没成功：少了要念的文字"
	if got, danger := a.composerNote(); !strings.Contains(got, "播报没成功") || !danger {
		t.Errorf("播报错误没标红：%q / danger=%v", got, danger)
	}
	a.withdrawError = "已经读过了"
	if got, danger := a.composerNote(); !strings.HasPrefix(got, "撤回没成功") || !danger {
		t.Errorf("撤回错误应压过其它回执：%q / danger=%v", got, danger)
	}
}

func TestMessageKeyStable(t *testing.T) {
	m := Message{ID: "m-1", At: "2026-11-12T12:00:00Z", Text: "好"}
	if got := messageKey(m); got != "m-1" {
		t.Errorf("有 ID 时键是 %q", got)
	}
	m.ID = ""
	m.RequestID = "r-1"
	if got := messageKey(m); got != "r-1" {
		t.Errorf("有请求号时键是 %q", got)
	}
	m.RequestID = ""
	if got, again := messageKey(m), messageKey(m); got != again || got == "" {
		t.Errorf("兜底键不稳定：%q / %q", got, again)
	}
}
