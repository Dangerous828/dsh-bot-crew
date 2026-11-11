// 队伍对话的消息面客户端。只说两件事：拉时间线、发消息。
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
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
//
// TicketRef 是这段改动属于哪张工单：卡片下面「看看改完的样子」要在那张票的
// 活动快照里看，不能拿第一张在跑的票冒充。没有就不猜，说了也做不到就如实讲。
type CodeBlock struct {
	ID        string     `json:"id,omitempty"`
	Path      string     `json:"path"`
	Added     int        `json:"added"`
	Removed   int        `json:"removed"`
	Lines     []CodeLine `json:"lines"`
	TicketRef string     `json:"ticket_ref,omitempty"`
}

// CodeLine 是代码块里的一行。Kind 取 added / removed / 空。
type CodeLine struct {
	Text string `json:"text"`
	Kind string `json:"kind"`
}

// Message 是对话里的一条。Role 只有两种：人说的，和队伍里某个 Bot 说的。
// Extra 兜住这个版本还不认识的字段：后台加了新字段，旧客户端也要原样带回去。
type Message struct {
	ID        string                     `json:"id"`
	Role      string                     `json:"role"`
	BotID     string                     `json:"bot_id,omitempty"`
	Text      string                     `json:"text"`
	At        string                     `json:"at"`
	RequestID string                     `json:"request_id,omitempty"`
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
//
// 票号优先取代码块自己的，其次取消息上的 `ticket_ref`（契约 §4 那个只读引用）：
// 卡片上的「看看改完的样子」要知道去看哪张票，缺了就如实说，不拿别的票顶。
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
			if block.TicketRef == "" {
				block.TicketRef = m.ticketRef()
			}
			// 卡片身份：没有 id 时用票号 + 文件名拼一个，足够区分同一段对话里的两张卡，
			// 「采用中 / 已采用」与回执都按它各记各的。
			if block.ID == "" {
				block.ID = block.TicketRef + "|" + block.Path
			}
			return &block
		}
	}
	return nil
}

// ticketRef 是消息上那个只读的票号引用。它只用来展示，不据此维护任何任务账。
func (m Message) ticketRef() string {
	if m.Extra == nil {
		return ""
	}
	raw, ok := m.Extra["ticket_ref"]
	if !ok {
		return ""
	}
	var ref string
	if err := json.Unmarshal(raw, &ref); err != nil {
		return ""
	}
	return strings.TrimSpace(ref)
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

// UnmarshalJSON lets an older backend without the explicit `open` flag still be understood:
// the ticket is open unless its state is one of the five terminal outcomes.
func (t *Task) UnmarshalJSON(data []byte) error {
	var wire struct {
		ID          string            `json:"id"`
		Title       string            `json:"title"`
		State       string            `json:"state"`
		Open        *bool             `json:"open"`
		Retryable   bool              `json:"retryable"`
		BotID       string            `json:"bot_id,omitempty"`
		NeedsPerson string            `json:"needs_person,omitempty"`
		Question    string            `json:"question,omitempty"`
		Options     []AttentionOption `json:"options,omitempty"`
		CreatedAt   string            `json:"created_at,omitempty"`
		UpdatedAt   string            `json:"updated_at,omitempty"`
		TotalSteps  int               `json:"total_steps,omitempty"`
		StepsDone   int               `json:"steps_done,omitempty"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*t = Task{ID: wire.ID, Title: wire.Title, State: wire.State, Retryable: wire.Retryable,
		BotID: wire.BotID, NeedsPerson: wire.NeedsPerson, Question: wire.Question, Options: wire.Options,
		CreatedAt: wire.CreatedAt, UpdatedAt: wire.UpdatedAt, TotalSteps: wire.TotalSteps, StepsDone: wire.StepsDone,
		Open: !terminalState(wire.State)}
	if wire.Open != nil {
		t.Open = *wire.Open
	}
	return nil
}

// terminalState 是 ticket.ended.outcome 的五个取值。没有 open 字段的老后端靠它兜底。
func terminalState(state string) bool {
	switch state {
	case "completed", "merged", "closed", "dropped", "stopped":
		return true
	}
	return false
}

// Task 是后台工单的只读投影。只拿来显示「谁在干」，不据此维护状态机。
type Task struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	State string `json:"state"`
	// Open 是「还没结束」。页签与徽标按它判，不要解释 State 的词表（终态有五种）。
	Open bool `json:"open"`
	// Retryable 是后端说这张票还能再跑一次（卡在 failed/blocked，或投递失败）。
	Retryable bool   `json:"retryable"`
	BotID     string `json:"bot_id,omitempty"`
	// NeedsPerson names what the ticket is waiting for, when it is waiting on a person.
	NeedsPerson string `json:"needs_person,omitempty"`
	// Question is the sentence the ticket waits on, when it waits on an answer rather than on a delivery,
	// a review, or a failure. Empty means the backend named no question, and the card must not invent one.
	Question string `json:"question,omitempty"`
	// Options are the answers that question offers, in reading order. Empty means it takes a written reply;
	// the front end never makes up A/B out of the question's own words.
	Options   []AttentionOption `json:"options,omitempty"`
	CreatedAt string            `json:"created_at,omitempty"`
	UpdatedAt string            `json:"updated_at,omitempty"`
	// TotalSteps 是这张票计划里的总步数，StepsDone 是其中走完的几步。两个都来自
	// worker 自己写的待办清单（见后端 work.ts 的 planOf）；后端没有计划时两个都缺省，
	// 此时不画进度条 —— 见 ui.go 的 progressOf。
	TotalSteps int `json:"total_steps,omitempty"`
	// StepsDone 只在 TotalSteps 同时出现时有意义；后端没给计划就一起缺着。
	StepsDone int `json:"steps_done,omitempty"`
}

// AttentionOption 是「等你决定」那张卡上的一个答案：id 在这句问题里唯一且稳定，
// label 是给人读的一句话，点下去就把这句话原样作为回答发回去。
type AttentionOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
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
	var payload struct {
		Agents []AgentNode `json:"agents"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return payload.Agents, nil
}

// ScreenLine is one line of what a worker did: a command, its output, something it said, or a status change.
type ScreenLine struct {
	At   string `json:"at"`
	Kind string `json:"kind"` // command | output | said | status
	Text string `json:"text"`
}

// ScreenView is what the backend says about a ticket's screen right now.
// `live` carries the activity snapshot; `unavailable` carries the reason it is honest about.
type ScreenView struct {
	State    string       `json:"state"`
	Kind     string       `json:"kind"`
	TicketID string       `json:"ticket_id"`
	Live     bool         `json:"live"`
	At       string       `json:"at"`
	Cwd      string       `json:"cwd"`
	Reason   string       `json:"reason"`
	Lines    []ScreenLine `json:"lines"`
}

// Screen asks for a ticket's screen; the backend either shows one or says why it cannot.
func (c *Client) Screen(ctx context.Context, ticketID string) (*ScreenView, error) {
	path := "/api/mobile/screen"
	if ticketID != "" {
		path += "?ticket=" + url.QueryEscape(ticketID)
	}
	var view ScreenView
	if err := c.do(ctx, http.MethodGet, path, nil, &view); err != nil {
		return nil, err
	}
	return &view, nil
}

// Pause stops the executor from taking new work. It is the only pause the phone surface has,
// so the caller must say "全局" when reporting it back.
func (c *Client) Pause(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/api/mobile/pause", map[string]any{}, nil)
}

// OutputItem 是一条产出：worker 在它那张工单里写过的一个文件（契约 §5.4）。
//
// 它不是一张新表的投影：后台读的是工单 worker 会话里 write / edit 的路径。
// Kind 只有 file / image 两种；image 只说明「路径以图片扩展名结尾」，不是截帧。
type OutputItem struct {
	ID          string `json:"id"`
	TicketID    string `json:"ticket_id"`
	TicketTitle string `json:"ticket_title"`
	BotID       string `json:"bot_id,omitempty"`
	Kind        string `json:"kind"`
	Path        string `json:"path"`
	Cwd         string `json:"cwd,omitempty"`
	Title       string `json:"title"`
	Writes      int    `json:"writes"`
	At          string `json:"at"`
}

// OutputCounts 是按类的条数。结果条上那句「两张图片」就是从这里来的。
type OutputCounts struct {
	File  int `json:"file"`
	Image int `json:"image"`
}

// OutputsView 是「产出」那一栏的一份快照。
//
// State 的三种取值不能混：live 有东西；empty 读得到、确实没有；unavailable 读不到。
// 把读不到说成没有，就是替队伍编一句话。
type OutputsView struct {
	Items    []OutputItem `json:"items"`
	State    string       `json:"state"`
	Counts   OutputCounts `json:"counts"`
	Reason   string       `json:"reason,omitempty"`
	TicketID string       `json:"ticket_id,omitempty"`
}

// Outputs 读产出。ticketID 为空就读最近几张票合在一起的那一栏。
func (c *Client) Outputs(ctx context.Context, ticketID string) (*OutputsView, error) {
	path := "/api/mobile/outputs"
	if ticketID != "" {
		path += "?ticket=" + url.QueryEscape(ticketID)
	}
	var view OutputsView
	if err := c.do(ctx, http.MethodGet, path, nil, &view); err != nil {
		return nil, err
	}
	return &view, nil
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
	base  string
	token string
	// 设备号：独立监听那道门要它配对凭据一起出示。
	deviceID string
	http     *http.Client
	// managementBase 是管理面的根（网页端口）。空表示还没发现，退回消息面（会 404）。
	managementBase string
}

// New 造一个客户端。base 形如 http://127.0.0.1:18882。
func New(base, token, deviceID string) *Client {
	return &Client{base: base, token: token, deviceID: deviceID, http: &http.Client{Timeout: 15 * time.Second}}
}

// WithManagement 指向管理面（网页端口）。
//
// 管理路由只在那道门上：手机面那个端口（43499 之类）根本不注册
// `/orchestrator/api/*`，拿它去要设备表或备份只会拿到 404。
func (c *Client) WithManagement(base string) *Client {
	clone := *c
	clone.managementBase = strings.TrimSuffix(base, "/")
	return &clone
}

// Timeline 拉整段对话。消息按时间从旧到新。
func (c *Client) Timeline(ctx context.Context) (*Conversation, error) {
	var payload struct {
		Items        []Message     `json:"items"`
		Bots         []BotCard     `json:"bots"`
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
		Tasks: payload.Tasks, Status: payload.Status, Queued: payload.Queued, Declined: payload.Declined,
		Model: payload.Model}, nil
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

// withdrawPath 是撤回排队消息的那条路。契约集中在这里：
// POST /api/mobile/withdraw，body {"request_id":"..."}，成功 200，已读/已回复 409。
const withdrawPath = "/api/mobile/withdraw"

// ErrSteerTooLate 是插队时的 409：这条已被回复、已被读走或已经撤回过，不能再插。
var ErrSteerTooLate = errors.New("这条已经被队伍读走了，插不进去")

// SteerText 发送即插队：把新写的一句直接交给正在跑的 worker，不经过排队。
// 网关会把它插成已读，路由不会再把这句当新活接一遍。
func (c *Client) SteerText(ctx context.Context, ticketID, requestID, text string) error {
	body, err := json.Marshal(map[string]string{"ticket": ticketID, "request_id": requestID, "text": text})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/api/mobile/steer", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	c.auth(request)
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("连不上队伍（%s）: %w", c.base, err)
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode == http.StatusOK:
		return nil
	case response.StatusCode == http.StatusConflict:
		return ErrSteerTooLate
	default:
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return fmt.Errorf("队伍返回 %d: %s", response.StatusCode, bytes.TrimSpace(detail))
	}
}

// Steer 把一条排队消息直接交给正在跑的 worker：它在下一步边界先读，不等队列轮询。
func (c *Client) Steer(ctx context.Context, ticketID, requestID string) error {
	body, err := json.Marshal(map[string]string{"ticket": ticketID, "request_id": requestID})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/api/mobile/steer", bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	c.auth(request)
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("连不上队伍（%s）: %w", c.base, err)
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode == http.StatusOK:
		return nil
	case response.StatusCode == http.StatusConflict:
		return ErrSteerTooLate
	default:
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return fmt.Errorf("队伍返回 %d: %s", response.StatusCode, bytes.TrimSpace(detail))
	}
}

// ErrWithdrawalTooLate 是网关的 409：消息已经回复、已被 worker 读走，或已经撤回过。
// 这不是连接故障，界面据此重读时间线，而不是把它写进断连横幅。
var ErrWithdrawalTooLate = errors.New("这条已经被队伍读过了，撤不回来")

// Withdraw 撤掉一条还没被队伍读到的排队消息。
// 409 是「已经读过了，撤不回来」——那不是网络错误，要把话说清楚，
// 让人知道这条消息不会再消失，而不是以为网络抖了一下。
func (c *Client) Withdraw(ctx context.Context, requestID string) error {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return fmt.Errorf("没有要撤回的请求号")
	}
	body, err := json.Marshal(map[string]string{"request_id": requestID})
	if err != nil {
		return fmt.Errorf("编码请求: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+withdrawPath, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("构造请求: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	c.auth(request)
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("连不上队伍（%s）: %w", c.base, err)
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode == http.StatusOK:
		return nil
	case response.StatusCode == http.StatusConflict:
		return ErrWithdrawalTooLate
	default:
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return fmt.Errorf("队伍返回 %d: %s", response.StatusCode, bytes.TrimSpace(detail))
	}
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
	root := c.managementBase
	if root == "" {
		root = c.base
	}
	request, err := http.NewRequestWithContext(ctx, method, root+"/orchestrator/api"+path, bytes.NewReader(body))
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
	var payload struct {
		Steps []WorkStep `json:"steps"`
	}
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
	Provider        string `json:"provider"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
}

// EffortOption 是一个可选推理档位：id 是提交值，name 是给人看的名字。
type EffortOption struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// EffortsView 是一条模型路由支持的推理档位，以及它的默认值。
type EffortsView struct {
	Efforts []EffortOption `json:"efforts"`
	Default string         `json:"default,omitempty"`
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
	Current   *ModelChoice           `json:"current,omitempty"`
	BotModels map[string]ModelChoice `json:"bot_models,omitempty"`
	Providers []ModelProvider        `json:"providers"`
	Failures  []ModelFailure         `json:"failures"`
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

// Efforts 问一条模型路由支持哪些推理档位。
func (c *Client) Efforts(ctx context.Context, provider, model string) (*EffortsView, error) {
	path := "/api/mobile/efforts?provider=" + url.QueryEscape(provider) + "&model=" + url.QueryEscape(model)
	var view EffortsView
	if err := c.do(ctx, http.MethodGet, path, nil, &view); err != nil {
		return nil, err
	}
	return &view, nil
}

// SwitchModel 换队伍干活用的模型。换完由调用方重新读时间线，让左栏显示跟上。
func (c *Client) SwitchModel(ctx context.Context, choice ModelChoice, botID string) error {
	body, err := json.Marshal(struct {
		ModelChoice
		BotID string `json:"bot_id,omitempty"`
	}{choice, botID})
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

// Retry asks the crew to run a failed ticket again. It goes through the phone surface: the
// management routes require a same-origin loopback Host, which this client never has.
func (c *Client) Retry(ctx context.Context, ticketID string) error {
	return c.do(ctx, http.MethodPost, "/api/mobile/retry?ticket="+url.QueryEscape(ticketID), nil, nil)
}

// EditBot 改一位 Bot 的名字与人设。bot_id 不动：他的记忆挂在它上面。
//
// 走 POST + action：DSH 的 Connection 只放行 GET/POST，PUT 到不了插件。
func (c *Client) EditBot(ctx context.Context, botID, name, persona string) error {
	return c.do(ctx, http.MethodPost, "/api/mobile/bots",
		map[string]string{"action": "edit", "bot_id": botID, "name": name, "persona": persona}, nil)
}

// RemoveBot 撤一位 Bot。后端会把 default 顺延给下一位。
func (c *Client) RemoveBot(ctx context.Context, botID string) error {
	return c.do(ctx, http.MethodPost, "/api/mobile/bots", map[string]string{"action": "remove", "bot_id": botID}, nil)
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

// ExportRecords 取一份备份：配置、花名册、政策、每张工单的最终状态。
// 走管理面 —— 它要求同源本机，导出文件不该能从手机那一侧拉走。
func (c *Client) ExportRecords(ctx context.Context) ([]byte, error) {
	root := c.managementBase
	if root == "" {
		root = c.base
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, root+"/orchestrator/api/records/export", nil)
	if err != nil {
		return nil, fmt.Errorf("构造请求: %w", err)
	}
	request.Header.Set("x-orchestrator-request", "1")
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("连不上队伍（%s）: %w", c.base, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return nil, fmt.Errorf("导出失败（%d）：%s", response.StatusCode, bytes.TrimSpace(detail))
	}
	return io.ReadAll(response.Body)
}
