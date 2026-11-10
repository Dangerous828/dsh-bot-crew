package main

import (
	"encoding/json"
	"testing"
)

// 代码块是「改了什么」的证据。解析错了不会报错，只会画出一张空卡 ——
// 所以这里钉住字段名与三种行类型。
func TestMessageCarriesItsCodeBlock(t *testing.T) {
	raw := `{
		"id": "m1", "role": "agent", "text": "改好了",
		"code": {
			"path": "login.tsx", "added": 2, "removed": 1,
			"lines": [
				{"text": "gap: 12px;", "kind": "context"},
				{"text": "gap: 16px;", "kind": "added"},
				{"text": "padding-bottom: 0;", "kind": "removed"}
			]
		}
	}`
	var message Message
	if err := json.Unmarshal([]byte(raw), &message); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	block := message.Code()
	if block == nil {
		t.Fatal("消息里带了 code，但没取出来")
	}
	if block.Path != "login.tsx" || block.Added != 2 || block.Removed != 1 {
		t.Errorf("表头解析错: %+v", block)
	}
	if len(block.Lines) != 3 {
		t.Fatalf("应有 3 行，实际 %d", len(block.Lines))
	}
	if block.Lines[1].Kind != "added" || block.Lines[2].Kind != "removed" {
		t.Errorf("行类型解析错: %+v", block.Lines)
	}
}

// 没有代码块的消息要返回 nil，不能返回一张空卡。
func TestMessageWithoutCodeHasNoBlock(t *testing.T) {
	var message Message
	if err := json.Unmarshal([]byte(`{"id":"m2","role":"user","text":"你好"}`), &message); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if message.Code() != nil {
		t.Error("没带代码却拿到了代码块")
	}
}

// 后端若把字段叫 diff，也要认。
func TestCodeAcceptsDiffNaming(t *testing.T) {
	raw := `{"id":"m3","role":"agent","text":"x","diff":{"path":"a.ts","added":1,"removed":0,"lines":[{"text":"x","kind":"added"}]}}`
	var message Message
	if err := json.Unmarshal([]byte(raw), &message); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	block := message.Code()
	if block == nil || block.Path != "a.ts" {
		t.Fatalf("diff 这种命名没认出来: %+v", block)
	}
}
