// 队伍对话的消息面客户端。只说两件事：拉时间线、发消息。
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Message 是对话里的一条。Role 只有两种：人说的，和队伍里某个 Bot 说的。
// Extra 兜住这个版本还不认识的字段：后台加了新字段，旧客户端也要原样带回去。
type Message struct {
	ID        string `json:"id"`
	Role      string `json:"role"`
	BotID     string `json:"bot_id,omitempty"`
	Text      string `json:"text"`
	At        string `json:"at"`
	RequestID string `json:"request_id,omitempty"`
	Extra     map[string]json.RawMessage `json:"-"`
}

func (m *Message) UnmarshalJSON(data []byte) error {
	type plain Message
	var known plain
	if err := json.Unmarshal(data, &known); err != nil {
		return err
	}
	*m = Message(known)
	var all map[string]json.RawMessage
	if err := json.Unmarshal(data, &all); err != nil {
		return err
	}
	for _, named := range []string{"id", "role", "bot_id", "text", "at", "request_id"} {
		delete(all, named)
	}
	if len(all) > 0 {
		m.Extra = all
	}
	return nil
}

func (m Message) MarshalJSON() ([]byte, error) {
	type plain Message
	known, err := json.Marshal(plain(m))
	if err != nil {
		return nil, err
	}
	if len(m.Extra) == 0 {
		return known, nil
	}
	var merged map[string]json.RawMessage
	if err := json.Unmarshal(known, &merged); err != nil {
		return nil, err
	}
	for name, value := range m.Extra {
		if _, named := merged[name]; !named {
			merged[name] = value
		}
	}
	return json.Marshal(merged)
}

// BotCard 是名片上能看到的那些字。它是身份与呈现，不持有任何任务状态。
type BotCard struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Role    string `json:"role"`
	Persona string `json:"persona,omitempty"`
}

// Task 是后台工单的只读投影。只拿来显示「谁在干」，不据此维护状态机。
type Task struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	State string `json:"state"`
}

// Conversation 是一次读到的队伍。
type Conversation struct {
	Messages     []Message
	Bots         []BotCard
	DefaultBotID string
	Tasks        []Task
}

// Client 连一段对话。base 是消息面的根，token 是网关凭据。
type Client struct {
	base  string
	token string
	http  *http.Client
}

// New 造一个客户端。base 形如 http://127.0.0.1:18882。
func New(base, token string) *Client {
	return &Client{base: base, token: token, http: &http.Client{Timeout: 15 * time.Second}}
}

// Timeline 拉整段对话。消息按时间从旧到新。
func (c *Client) Timeline(ctx context.Context) (*Conversation, error) {
	var payload struct {
		Items []Message `json:"items"`
		Bots  []BotCard `json:"bots"`
		DefaultBotID string `json:"default_bot_id"`
		Tasks []Task    `json:"tasks"`
	}
	if err := c.do(ctx, http.MethodGet, "/timeline", nil, &payload); err != nil {
		return nil, err
	}
	return &Conversation{Messages: payload.Items, Bots: payload.Bots, DefaultBotID: payload.DefaultBotID,
		Tasks: payload.Tasks}, nil
}

// Send 把一句话送进对话。mentions 里是点名的 bot_id，可以没有。
// 返回的 requestID 是这次发送的幂等键：重试要沿用它，不能重新生成。
func (c *Client) Send(ctx context.Context, text string, mentions []string) (requestID string, err error) {
	requestID, err = newRequestID()
	if err != nil {
		return "", err
	}
	if mentions == nil {
		mentions = []string{}
	}
	body := map[string]any{"text": text, "request_id": requestID, "mentions": mentions}
	return requestID, c.do(ctx, http.MethodPost, "/send", body, nil)
}

// SendAgain 用同一个幂等键重发。网关会认出这是同一次发送，不会在对话里留下第二条。
func (c *Client) SendAgain(ctx context.Context, requestID, text string, mentions []string) error {
	if mentions == nil {
		mentions = []string{}
	}
	body := map[string]any{"text": text, "request_id": requestID, "mentions": mentions}
	return c.do(ctx, http.MethodPost, "/send", body, nil)
}

func (c *Client) do(ctx context.Context, method, path string, body any, into any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("编码请求: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return fmt.Errorf("构造请求: %w", err)
	}
	request.Header.Set("X-GW-Token", c.token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("连不上队伍（%s）: %w", c.base, err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("队伍拒绝了这次请求：token 不对（看 %s 的 mobilegw.token）", c.base)
	}
	if response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return fmt.Errorf("队伍返回 %d: %s", response.StatusCode, bytes.TrimSpace(detail))
	}
	if into == nil {
		return nil
	}
	if err := json.NewDecoder(response.Body).Decode(into); err != nil {
		return fmt.Errorf("读不懂队伍的回应: %w", err)
	}
	return nil
}

func newRequestID() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", fmt.Errorf("生成幂等键: %w", err)
	}
	return hex.EncodeToString(buffer[:]), nil
}
