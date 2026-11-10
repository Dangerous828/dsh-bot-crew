// 首次配对：本机出码，本机兑换，全程不需要人念数字。
//
// 出码走管理面（只认回环 Host），兑换走局域网消息面的 `/api/mobile/pair` ——
// 后端对那一跳放行，因为这时这台设备还没有凭据；码本身就是它的凭据。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// pairDevice 配一支新凭据。名字与平台只影响管理面里怎么显示这台设备。
func pairDevice(ctx context.Context, target crewTarget, deviceID, name, platform string, client *http.Client) (Credential, error) {
	if target.WebPort == 0 || target.LanPort == 0 {
		return Credential{}, fmt.Errorf("没找到这台机器上的队伍，先确认它已经启动")
	}
	code, err := requestPairingCode(ctx, target.WebPort, deviceID, client)
	if err != nil {
		return Credential{}, err
	}
	token, err := redeemPairingCode(ctx, target.LanPort, code, deviceID, name, platform, client)
	if err != nil {
		return Credential{}, err
	}
	return Credential{DeviceID: deviceID, Token: token, Base: target.Base}, nil
}

// requestPairingCode 让本机出一支六位码。
func requestPairingCode(ctx context.Context, webPort int, deviceID string, client *http.Client) (string, error) {
	body, err := json.Marshal(map[string]string{"deviceId": deviceID})
	if err != nil {
		return "", err
	}
	authority := fmt.Sprintf("127.0.0.1:%d", webPort)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("http://%s/orchestrator/api/remote/pairing", authority), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	// 配对面按 Host 判本机，按 x-orchestrator-request 判同源；两个都要对。
	request.Host = authority
	request.Header.Set("x-orchestrator-request", "1")
	request.Header.Set("origin", fmt.Sprintf("http://%s", authority))
	request.Header.Set("content-type", "application/json")
	var answer struct {
		Code string `json:"code"`
	}
	if err := send(request, client, &answer); err != nil {
		return "", fmt.Errorf("出配对码失败：%w", err)
	}
	if answer.Code == "" {
		return "", fmt.Errorf("出配对码失败：队伍没回码")
	}
	return answer.Code, nil
}

// redeemPairingCode 立刻用码换凭据。码五分钟有效，出完就换，不等。
func redeemPairingCode(ctx context.Context, lanPort int, code, deviceID, name, platform string, client *http.Client) (string, error) {
	body, err := json.Marshal(map[string]string{"code": code, "deviceId": deviceID, "name": name, "platform": platform})
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/api/mobile/pair", lanPort), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	// 首次配对还没有凭据；设备号带上只是为了在后端日志里认得出是谁在换码。
	request.Header.Set("x-crew-device", deviceID)
	request.Header.Set("content-type", "application/json")
	var answer struct {
		Token string `json:"token"`
	}
	if err := send(request, client, &answer); err != nil {
		return "", fmt.Errorf("兑换配对码失败：%w", err)
	}
	if answer.Token == "" {
		return "", fmt.Errorf("兑换配对码失败：队伍没发凭据")
	}
	return answer.Token, nil
}

// send 发一个请求并把 2xx 的 JSON 解进 into。错误只带状态与一小段正文：
// 配对失败的原因（码过期、设备被拒）都在那里。
func send(request *http.Request, client *http.Client, into any) error {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 200))
		message := strings.TrimSpace(string(detail))
		if message == "" {
			message = response.Status
		}
		return fmt.Errorf("%s", message)
	}
	if into == nil {
		return nil
	}
	return json.NewDecoder(response.Body).Decode(into)
}
