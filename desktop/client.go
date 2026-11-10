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
	"net/url"
	"regexp"
	"strings"
	"time"
)

// CodeBlock 是消息里带出来的代码片段。
//
// 它说的是「改了什么」：文件名、逐行的增删、以及各自属于哪一类。
// 这些信息后端已经给了，只是之前没画出来。
type CodeBlock struct {
	Path    string
	Added   int
	Removed int
	Lines   []CodeLine
}

// CodeLine 是代码块里的一行。Kind 取 added / removed / 空。
type CodeLine struct {
	Text string
	Kind string
}

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

// Code 从消息里取出代码块，没有就返回 nil。
//
// 字段名不一定叫 code —— 后端可能给 `code` 也可能给 `diff`，
// 两种都认，免得为了一个显示字段去动契约。
func (m Message) Code() *CodeBlock {
	if m.Extra == nil {
		return nil
	}
	for _, key := range []string{"code", "diff"} {
		raw, ok := m.Extra[key]
		if !ok {
			continue
		}
		var block CodeBlock
		if err := json.Unmarshal(raw, &block); err != nil {
			continue
		}
		if block.Path != "" || len(block.Lines) > 0 {
			return &block
		}
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
	BotID string `json:"bot_id,omitempty"`
	// NeedsPerson names what the ticket is waiting for, when it is waiting on a person.
	NeedsPerson string `json:"needs_person,omitempty"`
	CreatedAt   string `json:"created_at,omitempty"`
	UpdatedAt   string `json:"updated_at,omitempty"`
	// TotalSteps 是这张票计划里的总步数。后端目前还没有这个字段 ——
	// 没有它就画不出进度条，见 ui.go 的 progressOf。
	TotalSteps int `json:"total_steps,omitempty"`
}

// AgentNode is one agent under a ticket. A subagent of a subagent is a child again, so this nests.
type AgentNode struct {
	ID       string      `json:"id"`
	Label    string      `json:"label"`
	State    string      `json:"state"`
	Children []AgentNode `json:"children"`
}

// Agents reads the tree under one ticket. The phone shows who was dispatched and how deep it went.
func (c *Client) Agents(ctx context.Context, ticketID string) ([]AgentNode, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/mobile/agents?ticket="+url.QueryEscape(ticketID), nil)
	if err != nil {
		return nil, err
	}
	c.auth(request)
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("agents: %s", response.Status)
	}
	var payload struct{ Agents []AgentNode `json:"agents"` }
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return payload.Agents, nil
}

// BackendStatus is the crew's own health, as the surface reports it.
type BackendStatus struct {
	Runtime string `json:"runtime"`
	Mobile  string `json:"mobile"`
	Paused  bool   `json:"paused"`
}

// Ready is true when the crew can take work: running and not paused.
func (s BackendStatus) Ready() bool { return s.Runtime == "ready" && !s.Paused }

// Conversation 是一次读到的队伍。
type Conversation struct {
	Messages     []Message
	Bots         []BotCard
	DefaultBotID string
	Tasks        []Task
	Status       BackendStatus
	// Queued holds the request ids of messages the crew has not answered yet; those can still be withdrawn.
	Queued []string
	// Declined holds the messages the crew read and chose not to act on, with the reason it gave. Without it the
	// conversation cannot tell a thought still in progress from one that will never be answered.
	Declined []Declined
	// Model is what the crew is answering with right now; the roster footer shows it.
	Model string
}

// Declined 是被读过、但不打算动手的那条消息，以及给出来的理由。
type Declined struct {
	RequestID string `json:"request_id"`
	Reason    string `json:"reason"`
}

// Client 连一段对话。base 是消息面的根，token 是网关凭据。
type Client struct {
	base   string
	token  string
	// 设备号：独立监听那道门要它配对凭据一起出示。
	deviceID string
	http     *http.Client
}

// New 造一个客户端。base 形如 http://127.0.0.1:18882。
func New(base, token, deviceID string) *Client {
	return &Client{base: base, token: token, deviceID: deviceID, http: &http.Client{Timeout: 15 * time.Second}}
}

// Timeline 拉整段对话。消息按时间从旧到新。
func (c *Client) Timeline(ctx context.Context) (*Conversation, error) {
	var payload struct {
		Items []Message `json:"items"`
		Bots  []BotCard `json:"bots"`
		DefaultBotID string        `json:"default_bot_id"`
		Model        string        `json:"model"`
		Tasks        []Task        `json:"tasks"`
		Status       BackendStatus `json:"status"`
		Queued       []string      `json:"queued"`
		Declined     []Declined    `json:"declined"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/mobile/timeline", nil, &payload); err != nil {
		return nil, err
	}
	// 有些历史消息的正文是 URL 编码过的：解回人话再交出去。
	for i := range payload.Items {
		payload.Items[i].Text = readable(payload.Items[i].Text)
	}
	return &Conversation{Messages: payload.Items, Bots: payload.Bots, DefaultBotID: payload.DefaultBotID,
		Tasks: payload.Tasks, Status: payload.Status, Queued: payload.Queued, Declined: payload.Declined}, nil
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
	return requestID, c.do(ctx, http.MethodPost, "/api/mobile/send", body, nil)
}

// SendAgain 用同一个幂等键重发。网关会认出这是同一次发送，不会在对话里留下第二条。
func (c *Client) SendAgain(ctx context.Context, requestID, text string, mentions []string) error {
	if mentions == nil {
		mentions = []string{}
	}
	body := map[string]any{"text": text, "request_id": requestID, "mentions": mentions}
	return c.do(ctx, http.MethodPost, "/api/mobile/send", body, nil)
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
	c.auth(request)
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

// PairedDevice 是一台配过的设备。凭据摘要不在里面：那是能拿来撞库的东西，不该离开那台机器。
type PairedDevice struct {
	DeviceID string `json:"deviceId"`
	Name     string `json:"name"`
	Platform string `json:"platform"`
	PairedAt string `json:"pairedAt"`
}

// PairingCode 让这台电脑发一支码。手机上念的就是这六位。
func (c *Client) PairingCode(ctx context.Context, deviceID string) (string, error) {
	body, err := json.Marshal(map[string]string{"deviceId": deviceID})
	if err != nil {
		return "", err
	}
	var answer struct {
		Code string `json:"code"`
	}
	if err := c.management(ctx, http.MethodPost, "/remote/pairing", body, &answer); err != nil {
		return "", err
	}
	return answer.Code, nil
}

// Devices 列出配过的设备。
func (c *Client) Devices(ctx context.Context) ([]PairedDevice, error) {
	var answer struct {
		Devices []PairedDevice `json:"devices"`
	}
	if err := c.management(ctx, http.MethodGet, "/remote/devices", nil, &answer); err != nil {
		return nil, err
	}
	return answer.Devices, nil
}

// Revoke 撤掉一台设备。手机丢了就用它，撤掉之后那份凭据立刻作废。
func (c *Client) Revoke(ctx context.Context, deviceID string) error {
	body, err := json.Marshal(map[string]string{"deviceId": deviceID})
	if err != nil {
		return err
	}
	return c.management(ctx, http.MethodDelete, "/remote/devices", body, nil)
}

// management 打管理面。它和消息面不是同一条路：要走同源标记，而且只在本机可用。
func (c *Client) management(ctx context.Context, method, path string, body []byte, into any) error {
	request, err := http.NewRequestWithContext(ctx, method, c.base+"/orchestrator/api"+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("x-orchestrator-request", "1")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		return fmt.Errorf("%s: %s %s", path, response.Status, strings.TrimSpace(string(body)))
	}
	if into == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(into)
}

// WorkStep 是一次执行留下的结论。工单里没有逐轮日志，只有每次执行的一句话总结。
type WorkStep struct {
	At   string `json:"at"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// Work 读一张工单是怎么做出来的。
func (c *Client) Work(ctx context.Context, ticketID string) ([]WorkStep, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/mobile/work?ticket="+url.QueryEscape(ticketID), nil)
	if err != nil {
		return nil, err
	}
	c.auth(request)
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("work: %s", response.Status)
	}
	var payload struct{ Steps []WorkStep `json:"steps"` }
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return payload.Steps, nil
}

// ModelChoice 是一个能选的模型，连同它在哪一家。
//
// 模型名单独拿出来是不完整的：同一个名字在不同的 provider 上不是同一个模型，
// 后端换模型也要两样一起给。所以这一对永远成对出现。
type ModelChoice struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// ModelOption 是目录里的一条：模型 + 它给人看的名字（没有名字就和 id 一样）。
type ModelOption struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// ModelProvider 是同一家下面的一组模型。
type ModelProvider struct {
	ID     string        `json:"id"`
	Name   string        `json:"name"`
	Models []ModelOption `json:"models"`
}

// ModelFailure 是读不出目录的那一家。只带名字：失败原因里可能有内网地址。
type ModelFailure struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ModelCatalog 是「能切成什么」加上「现在是什么」。
type ModelCatalog struct {
	Current   *ModelChoice    `json:"current,omitempty"`
	Providers []ModelProvider `json:"providers"`
	Failures  []ModelFailure  `json:"failures"`
}

// Models 读一遍模型目录。
func (c *Client) Models(ctx context.Context) (*ModelCatalog, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/mobile/models", nil)
	if err != nil {
		return nil, err
	}
	c.auth(request)
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("models: %s", response.Status)
	}
	var catalog ModelCatalog
	if err := json.NewDecoder(response.Body).Decode(&catalog); err != nil {
		return nil, err
	}
	return &catalog, nil
}

// SwitchModel 换队伍干活用的模型。换完由调用方重新读时间线，让左栏显示跟上。
func (c *Client) SwitchModel(ctx context.Context, choice ModelChoice) error {
	body, err := json.Marshal(choice)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/api/mobile/model", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	c.auth(request)
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		answer, _ := io.ReadAll(response.Body)
		return fmt.Errorf("换模型没成功：%s %s", response.Status, strings.TrimSpace(string(answer)))
	}
	return nil
}

// Retry asks the crew to run a failed ticket again. It is a management action, not a message.
func (c *Client) Retry(ctx context.Context, ticketID string) error {
	return c.management(ctx, http.MethodPost, "/tickets/"+url.PathEscape(ticketID)+"/retry", nil, nil)
}

// defaultDeviceID 是这样没给设备号时出示的那个。
//
// 后端的 presented() 要求「设备号 + 凭据」两样都在才放行，缺设备号直接 401。
// 这台电脑没有配过对，也就没有签发过的设备号；但凭据本身是真的，
// 只要凑一个非空、稳定的名字就能过 present() 那一关。
// 选固定字面量而不是 os.Hostname()：主机名会随网络与改名变，
// 这里要的只是一个稳定的标签，让「是谁在连」在日志里可读、每次启动都一样。
const defaultDeviceID = "crew-desktop"

// auth 把队伍自己的凭据带上。
//
// 独立监听（lan-server）要的是「设备号 + 凭据」两样同时非空；网关那套认 X-GW-Token。
// 所以语义是：有 token 就一定发凭据，设备号没有就给默认值 ——
// 以前是「设备号为空就凭据也不发」，于是每个请求都缺 x-crew-device，必然 401。
// 反过来说，没有 token 时一个都不发：空串凭据只会让对端分不清「没配」和「配错了」。
func (c *Client) auth(request *http.Request) {
	token := strings.TrimSpace(c.token)
	if token == "" {
		return
	}
	device := strings.TrimSpace(c.deviceID)
	if device == "" {
		device = defaultDeviceID
	}
	request.Header.Set("x-crew-device", device)
	request.Header.Set("x-crew-credential", token)
	// 下面两个是历史兼容头：早期的网关与插件消息面只认它们，
	// 现在它们已经不被读取，保留只为让旧对端不至于连不上。新代码不要依赖。
	request.Header.Set("X-Crew-Token", token)
	request.Header.Set("X-GW-Token", token)
}

// readable 修掉历史上被当成正文发进去的 URL 编码串。
//
// 只在「确实有 %XX、且解出来不一样」时才动它，普通消息原样返回 ——
// 百分号在正常文本里也常见，不能一概解释。
func readable(raw string) string {
	if !strings.Contains(raw, "%") {
		return raw
	}
	matched, err := regexp.MatchString(`%[0-9A-Fa-f]{2}`, raw)
	if err != nil || !matched {
		return raw
	}
	decoded, err := url.QueryUnescape(raw)
	if err != nil || strings.TrimSpace(decoded) == "" {
		return raw
	}
	return decoded
}
