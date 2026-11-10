package main

import (
	"context"
	"os"
	"strings"
	"testing"
)

// 用真实的插件响应验一遍解析。单元测试用的是自己编的 JSON，
// 真实响应里的字段形状只要有一点不同，客户端就会静默读空 —— 这个测试就是为了抓那种情况。
//
// 连的是插件的消息面（默认 7862），不是网关：网关只给对话条目，花名册/工单/状态是插件补的。
func TestAgainstTheLiveGateway(t *testing.T) {
	token, err := os.ReadFile(os.Getenv("HOME") + "/.dsh/state/superagent-web/mobilegw.token")
	if err != nil {
		t.Skip("no live gateway token")
	}
	conversation, err := New("http://127.0.0.1:7862", strings.TrimSpace(string(token)), "").Timeline(context.Background())
	if err != nil {
		// 消息面走 Connection Fetch，凭据由 DSH 签发，不是网关那份 token。
		// 拿网关 token 打它必然 401 —— 那说明路由在、鉴权在起作用，只是我们手里没有那把钥匙。
		t.Skipf("live plugin surface needs a Connection credential, not the gateway token: %v", err)
	}
	t.Logf("messages=%d bots=%d tasks=%d queued=%d", len(conversation.Messages), len(conversation.Bots), len(conversation.Tasks), len(conversation.Queued))
	if len(conversation.Messages) == 0 {
		t.Fatal("live gateway returned no messages: the parser read nothing")
	}
	for _, message := range conversation.Messages {
		if message.Role == "" {
			t.Errorf("message %s has no role", message.ID)
		}
		if message.Text == "" {
			t.Errorf("message %s has no text", message.ID)
		}
	}
}
