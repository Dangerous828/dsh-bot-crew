// 四个新增入口的消息面调用。speak 成功回的是 WAV 二进制、voice 发的是 WAV 二进制，
// 这两条不能走 do() 的 JSON 编解码，所以共用一个「原始字节」的请求辅助。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// 一次回包最多读这些。后端 voice.ts 把 WAV 上限定在 8MB，这里留一点余量。
const maxActionReply = 12 * 1024 * 1024

// postRaw 把一段原始字节发过去，状态、响应头与正文原样带回来。
// 播报要先经系统 say 生成音频、识别要走本地模型，15 秒不够，这一组动作给两分钟。
func (c *Client) postRaw(ctx context.Context, path string, body []byte, contentType string) (int, http.Header, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, fmt.Errorf("构造请求: %w", err)
	}
	c.auth(request)
	request.Header.Set("Content-Type", contentType)
	client := *c.http
	client.Timeout = 120 * time.Second
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, nil, fmt.Errorf("连不上队伍（%s）: %w", c.base, err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxActionReply))
	if err != nil {
		return 0, nil, nil, fmt.Errorf("读队伍的回应: %w", err)
	}
	return response.StatusCode, response.Header, data, nil
}

// backendMessage 从失败回执里取出给人看的那句话。
// 200 上的 {available:false, reason} 与 4xx 上的 {error} 都在这里归一。
func backendMessage(status int, body []byte) string {
	var payload struct {
		Error  string `json:"error"`
		Reason string `json:"reason"`
		Status string `json:"status"`
	}
	_ = json.Unmarshal(body, &payload)
	switch {
	case status == http.StatusUnauthorized:
		return "队伍拒绝了这次请求：token 不对（看 mobilegw.token）"
	case payload.Reason != "":
		return payload.Reason
	case payload.Error != "":
		return payload.Error
	case payload.Status != "":
		return "播报状态：" + payload.Status
	}
	detail := strings.TrimSpace(string(body))
	if len(detail) > 160 {
		detail = detail[:160] + "…"
	}
	if detail == "" {
		return fmt.Sprintf("队伍返回 %d，没有说原因", status)
	}
	return fmt.Sprintf("队伍返回 %d：%s", status, detail)
}

// isWav 只认文件头，不猜格式：RIFF....WAVE 是后端 voice.ts / speech.ts 收的那一种。
func isWav(data []byte) bool {
	return len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WAVE"
}

// speakClip 是一次播报拿回来的音频与那两个响应头（mobile-http.ts:482-489）。
type speakClip struct {
	WAV       []byte
	Seconds   string
	Truncated bool
}

// parseSpeak 按真实契约分岔：成功是 200 + audio/wav 的二进制 WAV；
// 没能力或念失败是 200 的 JSON；其它状态是错误正文。
func parseSpeak(status int, contentType string, headers http.Header, body []byte) (*speakClip, error) {
	if status >= 300 {
		return nil, errors.New(backendMessage(status, body))
	}
	if strings.Contains(strings.ToLower(contentType), "audio/wav") {
		if !isWav(body) {
			return nil, errors.New("播报说回的是 WAV，内容却不是 RIFF/WAVE")
		}
		return &speakClip{
			WAV:       body,
			Seconds:   headers.Get("x-speech-seconds"),
			Truncated: headers.Get("x-speech-truncated") == "1",
		}, nil
	}
	if isWav(body) {
		return nil, errors.New("播报回来的内容类型不是 audio/wav")
	}
	return nil, errors.New(backendMessage(status, body))
}

// Speak 念一句话。成功回 WAV 字节；后端没接入、声音不存在、文本为空都按 reason 报错。
func (c *Client) Speak(ctx context.Context, text string) (*speakClip, error) {
	body, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return nil, fmt.Errorf("编码播报请求: %w", err)
	}
	status, headers, data, err := c.postRaw(ctx, "/api/mobile/speak", body, "application/json")
	if err != nil {
		return nil, err
	}
	return parseSpeak(status, headers.Get("Content-Type"), headers, data)
}

// playWav 把音频写成临时文件交给系统播放器，返回后删掉临时文件。
// run 是注入的播放动作：真机上给 systemPlay，测试里给一个假的，不必真的出声。
func playWav(wav []byte, run func(path string) error) error {
	if !isWav(wav) {
		return errors.New("播报回来的不是 WAV 音频")
	}
	file, err := os.CreateTemp("", "crew-speak-*.wav")
	if err != nil {
		return fmt.Errorf("建临时音频: %w", err)
	}
	path := file.Name()
	defer os.Remove(path)
	if _, err := file.Write(wav); err != nil {
		file.Close()
		return fmt.Errorf("写临时音频: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("收尾临时音频: %w", err)
	}
	return run(path)
}

// systemPlay 用 macOS 自带的 afplay 放一段 WAV。不引第三方播放库，也不开窗口。
func systemPlay(path string) error {
	afplay, err := exec.LookPath("afplay")
	if err != nil {
		return errors.New("这台机器没有系统播放器 afplay（需要 macOS）")
	}
	command := exec.Command(afplay, path)
	if output, err := command.CombinedOutput(); err != nil {
		if detail := strings.TrimSpace(string(output)); detail != "" {
			return fmt.Errorf("播放没成功：%s", detail)
		}
		return fmt.Errorf("播放没成功：%v", err)
	}
	return nil
}

// takeoverAck 用指针区分「字段没给」与「给了 false」：接手这件事上两者都不能算成功。
type takeoverAck struct {
	OK      *bool `json:"ok"`
	Stopped *bool `json:"stopped"`
}

func parseTakeover(status int, body []byte) (takeoverAck, error) {
	if status >= 300 {
		return takeoverAck{}, errors.New(backendMessage(status, body))
	}
	var ack takeoverAck
	if err := json.Unmarshal(body, &ack); err != nil {
		return takeoverAck{}, fmt.Errorf("读不懂接手回执: %w", err)
	}
	return ack, nil
}

// Takeover 接手一张工单。后端只在 {ok:true, stopped:true} 时真的停了这张票
// （mobile-http.ts:640-649）；其它回执原样带回来给界面说清。
func (c *Client) Takeover(ctx context.Context, ticket string) (takeoverAck, error) {
	body, err := json.Marshal(map[string]string{"ticket": ticket})
	if err != nil {
		return takeoverAck{}, fmt.Errorf("编码接手请求: %w", err)
	}
	status, _, data, err := c.postRaw(ctx, "/api/mobile/takeover", body, "application/json")
	if err != nil {
		return takeoverAck{}, err
	}
	return parseTakeover(status, data)
}

// takeoverOK 是「后端确实确认接了」的唯一判据：两个字段都得是真。
func takeoverOK(ack takeoverAck, err error) bool {
	return err == nil && ack.OK != nil && *ack.OK && ack.Stopped != nil && *ack.Stopped
}

// takeoverNote 按真实回执说话：没确认停下、没确认接手、报错都不冒充「已接手」。
func takeoverNote(ack takeoverAck, err error) string {
	if err != nil {
		return "接手没成功：" + err.Error()
	}
	if ack.OK == nil || !*ack.OK {
		return "后端没有确认接手（回执里 ok 不是 true）"
	}
	if ack.Stopped == nil || !*ack.Stopped {
		return "后端说接手了，但没确认这张票停下（stopped 不是 true）"
	}
	return "已接手：这张票停下了"
}

// parseTranscript 按 mobile-http.ts:492-501 / voice.ts 的契约：
// 200 + {available:true,text} 才有字；available:false 带 reason；其它状态是错误正文。
func parseTranscript(status int, body []byte) (string, error) {
	if status >= 300 {
		return "", errors.New(backendMessage(status, body))
	}
	var answer struct {
		Available bool   `json:"available"`
		Text      string `json:"text"`
		Reason    string `json:"reason"`
	}
	if err := json.Unmarshal(body, &answer); err != nil {
		return "", fmt.Errorf("读不懂识别结果: %w", err)
	}
	text := strings.TrimSpace(answer.Text)
	if !answer.Available || text == "" {
		if answer.Reason != "" {
			return "", errors.New(answer.Reason)
		}
		return "", errors.New("后端没给出识别文字")
	}
	return text, nil
}

// Voice 把一段 16kHz 单声道 WAV 原样 POST 给后端（不是 JSON、不是 base64）。
// 识别出来的字由调用方放进草稿，这里不碰任何发送逻辑。
func (c *Client) Voice(ctx context.Context, wav []byte) (string, error) {
	if !isWav(wav) {
		return "", errors.New("这段录音不是 WAV，后端只收 WAV")
	}
	if len(wav) > maxVoiceBytes {
		return "", fmt.Errorf("录音 %d KB，一次最多 %d MB", len(wav)/1024, maxVoiceBytes/1024/1024)
	}
	status, _, data, err := c.postRaw(ctx, "/api/mobile/voice", wav, "audio/wav")
	if err != nil {
		return "", err
	}
	return parseTranscript(status, data)
}
