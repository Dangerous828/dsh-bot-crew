// 自动发现队伍、配对、以及把配好的凭据留在本机。
//
// 目标只有一个：双击就能用。不再要求人去设 DSH_GW / DSH_TOKEN / DSH_DEVICE；
// 环境变量仍然优先，那是给调试和特殊部署留的后门，不是常态。
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// crewTarget 是这次要连的那一支队伍。
type crewTarget struct {
	// Base 是消息面地址（局域网监听），带设备凭据就能用。
	Base string
	// WebPort 是网页/管理面端口，出配对码要打这里。
	WebPort int
	// LanPort 是手机面端口，兑换配对码要打这里。
	LanPort int
	// Profile 是 discovery 找到的 profile 名；环境变量直接指定地址时为空。
	Profile string
	// Found 表示这台机器上确实有一个在跑的队伍。false 时界面要直说「没找到」。
	Found bool
}

// lanPort 与 backend/src/app/lan-server.ts 的 lanPort 同一条规则：
// 31 进制滚动哈希对 100000 取模，再加 20000。两处算法必须一致，
// 否则桌面端会去敲一个没人监听的门。
func lanPort(stateDir string) int {
	h := 0
	for _, c := range stateDir {
		h = (h*31 + int(c)) % 100000
	}
	return 20000 + h%40000
}

// patchSettings 从 profile 的 cordis.patch.yml 里读两件事：队伍的 stateDir 和网页端口。
//
// 只认最简单的 YAML 形状（`- id: x` 后跟缩进的 `key: value`），因为这份文件就是插件自己写的。
// 读不到就给零值：调用方会把它们当「没有」，而不是猜一个近似目录。
func patchSettings(text string) (stateDir string, webPort int) {
	block := ""
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}
		if strings.HasPrefix(line, "- id:") {
			block = unquote(strings.TrimSpace(strings.TrimPrefix(line, "- id:")))
			continue
		}
		switch block {
		case "dsh-superagent":
			if value, ok := yamlValue(line, "stateDir"); ok {
				stateDir = value
			}
		case "webserver":
			if value, ok := yamlValue(line, "port"); ok {
				if number, err := strconv.Atoi(value); err == nil {
					webPort = number
				}
			}
		}
	}
	return
}

// yamlValue 取 `key: value` 里的值；`config:` 这种没值的行返回 false。
func yamlValue(line, key string) (string, bool) {
	prefix := key + ":"
	if !strings.HasPrefix(line, prefix) {
		return "", false
	}
	value := unquote(strings.TrimSpace(strings.TrimPrefix(line, prefix)))
	return value, value != ""
}

func unquote(value string) string {
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
			return value[1 : len(value)-1]
		}
	}
	return value
}

// profiles 是与 backend/scripts/dsh-superagent 相同的默认目录；测试里换成临时目录。
func profilesDir() string {
	return filepath.Join(homeDir(), ".dsh", "profiles")
}

// discover 扫所有 profile，解析出队伍地址，再按端口探活。
//
// 按 profile 名排序（desktop 在 web 前），第一个能连上的就是这次要用的。
// 一个都连不上时返回找到的全部，调用方据此说「有队伍但没起来」或「根本没有」。
func discover(profiles string, alive func(port int) bool) []crewTarget {
	entries, err := os.ReadDir(profiles)
	if err != nil {
		return nil
	}
	var found []crewTarget
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(profiles, entry.Name(), "cordis.patch.yml"))
		if err != nil {
			continue
		}
		stateDir, webPort := patchSettings(string(raw))
		// 没有 stateDir 的 profile 不是这支队伍（插件要求它存在）。
		if stateDir == "" {
			continue
		}
		lan := lanPort(stateDir)
		if webPort == 0 {
			// 没有 webserver 段时 dsh 用默认端口；管理面也只认回环，这个默认值足够出码。
			webPort = 3080
		}
		found = append(found, crewTarget{Base: fmt.Sprintf("http://127.0.0.1:%d", lan),
			WebPort: webPort, LanPort: lan, Profile: entry.Name()})
	}
	sort.Slice(found, func(a, b int) bool { return found[a].Profile < found[b].Profile })
	if alive == nil {
		return found
	}
	live := found[:0]
	for _, target := range found {
		target.Found = alive(target.LanPort)
		if target.Found {
			// profile 里写的网页端口常常只是默认值（3080），真正答管理面的是同进程里
			// 另一个端口。发现了活队伍就顺手问一次，免得设备表与备份打到错的端口上。
			target.WebPort = webPortNear(target.LanPort, target.WebPort)
			live = append(live, target)
		}
	}
	return live
}

// dialAlive 用一次短连接回答「这个端口上有人在听吗」。
// 超时短到点一下按钮不会觉得卡：本机端口只有几十个，扫一遍也就一瞬间。
func dialAlive(port int) bool {
	connection, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 250*time.Millisecond)
	if err != nil {
		return false
	}
	connection.Close()
	return true
}

// webPortNear 找与 lanPort 同一个进程的那个网页端口。
//
// Electron 内置的 dsh 不把网页端口写进 profile，它在启动时随机分配。两个监听在同一个进程里，
// 这是唯一可靠的关联：先按 lan 端口找到进程，再在它的监听里认出会答管理面的那个。
// 拿不到（没有 lsof、或进程已经退出）就退回 profile 里写的端口。
func webPortNear(lanPort, configured int) int {
	pid := pidListeningOn(lanPort)
	if pid == 0 {
		return configured
	}
	for _, port := range listeningPortsOf(pid) {
		if port != lanPort && respondsAsOrchestrator(port) {
			return port
		}
	}
	return configured
}

// pidListeningOn 问 lsof 谁在听这个端口。它只在本机跑，参数全是数字，没有注入面。
func pidListeningOn(port int) int {
	out, err := exec.Command("lsof", "-nP", fmt.Sprintf("-iTCP:%d", port), "-sTCP:LISTEN", "-t").Output()
	if err != nil {
		return 0
	}
	return firstPID(string(out))
}

// listeningPortsOf 列出一个进程所有 TCP 监听端口。
func listeningPortsOf(pid int) []int {
	out, err := exec.Command("lsof", "-nP", "-a", "-p", strconv.Itoa(pid), "-iTCP", "-sTCP:LISTEN", "-Fn").Output()
	if err != nil {
		return nil
	}
	return portsFromLsof(string(out))
}

// firstPID 读 `lsof -t` 的输出：一行一个 PID，取第一个。
func firstPID(text string) int {
	for _, line := range strings.Split(text, "\n") {
		if pid, err := strconv.Atoi(strings.TrimSpace(line)); err == nil {
			return pid
		}
	}
	return 0
}

// portsFromLsof 读 `lsof -Fn` 的输出：`n127.0.0.1:53925` 这种行，取冒号后面的端口。
// IPv6 地址带方括号，所以从右边切最后一段。
func portsFromLsof(text string) []int {
	var ports []int
	seen := make(map[int]bool)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "n") {
			continue
		}
		value := line[1:]
		colon := strings.LastIndex(value, ":")
		if colon < 0 {
			continue
		}
		port, err := strconv.Atoi(value[colon+1:])
		if err != nil || port <= 0 || seen[port] {
			continue
		}
		seen[port] = true
		ports = append(ports, port)
	}
	return ports
}

// respondsAsOrchestrator 问一句「你是管理面吗」。配对面按 Host 判本机、按同源头判来源，
// 所以探测也要带同样的两样；超时短到扫完一个进程的端口不会觉得卡。
func respondsAsOrchestrator(port int) bool {
	authority := fmt.Sprintf("127.0.0.1:%d", port)
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://%s/orchestrator/api/state", authority), nil)
	if err != nil {
		return false
	}
	request.Host = authority
	request.Header.Set("x-orchestrator-request", "1")
	response, err := (&http.Client{Timeout: 400 * time.Millisecond}).Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	return response.StatusCode == http.StatusOK
}

// Credential 是本机为某一支队伍持有的凭据。凭据只落在这台电脑上，且只有它自己能读。
type Credential struct {
	DeviceID string `json:"deviceId"`
	Token    string `json:"token"`
	Base     string `json:"base"`
}

// credentialPath 是凭据的落点。~/.config 是 macOS 的标准位置；
// 目录 0700、文件 0600 由 saveCredential 保证。
func credentialPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "crew-desktop", "credential.json")
}

// loadCredential 读回上次配好的凭据。文件坏了就当作没配过：宁可重配，也不要让启动崩在解析上。
func loadCredential(path string) (Credential, bool) {
	if path == "" {
		return Credential{}, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return Credential{}, false
	}
	var saved Credential
	if err := json.Unmarshal(raw, &saved); err != nil {
		return Credential{}, false
	}
	if saved.DeviceID == "" || saved.Token == "" || saved.Base == "" {
		return Credential{}, false
	}
	return saved, true
}

// saveCredential 写凭据：目录 0700、文件 0600。凭据泄露等于别人能读这段对话。
func saveCredential(path string, saved Credential) error {
	if path == "" {
		return fmt.Errorf("没有可写凭据的主目录")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(saved, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	// WriteFile 只在新建时用 0600：已存在的文件（比如早先手动放的）不会被改权限。
	// 凭据是能做任意请求的东西，写一次就收紧一次。
	return os.Chmod(path, 0o600)
}
