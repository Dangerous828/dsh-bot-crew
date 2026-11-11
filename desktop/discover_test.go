package main

import (
	"os"
	"path/filepath"
	"testing"
)

// lanPort 必须和 backend/src/app/lan-server.ts 的 lanPort 算出同一个数，
// 否则桌面端会去敲一个没人监听的门。两个样例取自实际跑起来的那两支队伍。
func TestLanPortMatchesTheBackend(t *testing.T) {
	cases := map[string]int{
		"/Users/cpuser/.dsh/state/superagent-web": 38162,
		"/Users/cpuser/.dsh/state/superagent":     43499,
	}
	for stateDir, want := range cases {
		if got := lanPort(stateDir); got != want {
			t.Errorf("lanPort(%q) = %d, want %d", stateDir, got, want)
		}
	}
}

func TestPatchSettingsReadsStateDirAndWebPort(t *testing.T) {
	// desktop profile 的真实形状：老段落加几个不相干的行。
	patch := `# 顶部注释
- id: llm-pi-ai
  config:
    providers: {}
- id: webserver
  name: "@deepseek-ai/dsh-host-webserver"
  config:
    host: 127.0.0.1
    port: 3080
- id: dsh-superagent
  config:
    stateDir: /Users/cpuser/.dsh/state/superagent
`
	stateDir, webPort := patchSettings(patch)
	if stateDir != "/Users/cpuser/.dsh/state/superagent" {
		t.Errorf("stateDir = %q", stateDir)
	}
	if webPort != 3080 {
		t.Errorf("webPort = %d", webPort)
	}
}

func TestPatchSettingsIgnoresProfilesWithoutACrew(t *testing.T) {
	// headless 那种 profile 没有 dsh-superagent 段：它不是这支队伍。
	if stateDir, webPort := patchSettings("- id: permission\n  config:\n    defaultPreset: danger\n"); stateDir != "" || webPort != 0 {
		t.Errorf("got (%q, %d), want empty", stateDir, webPort)
	}
	// 带引号的值也要认。
	stateDir, webPort := patchSettings("- id: webserver\n  config:\n    port: \"3099\"\n- id: dsh-superagent\n  config:\n    stateDir: \"/tmp/crew\"\n")
	if stateDir != "/tmp/crew" || webPort != 3099 {
		t.Errorf("quoted values: got (%q, %d)", stateDir, webPort)
	}
}

// Electron 的网页端口是随机的，要靠「同一进程中谁在答管理面」认出来。
// 这里钉住 lsof 输出的解析：IPv4、IPv6、重复端口都要读对。
func TestParsingLsofOutput(t *testing.T) {
	if got := firstPID("57936\n"); got != 57936 {
		t.Errorf("firstPID = %d", got)
	}
	if got := firstPID(""); got != 0 {
		t.Errorf("firstPID of nothing = %d", got)
	}
	ports := portsFromLsof("p57936\nn127.0.0.1:53925\nn192.168.31.127:43499\nn[::1]:43499\nn127.0.0.1:53925\n")
	// 去重后按出现顺序：同一个端口被绑在多个地址上也只算一次。
	if len(ports) != 2 || ports[0] != 53925 || ports[1] != 43499 {
		t.Errorf("portsFromLsof = %v", ports)
	}
	if got := portsFromLsof("p1\n"); len(got) != 0 {
		t.Errorf("no-address output = %v", got)
	}
}

// 环境变量或凭据指向本机另一支队伍时，配对目标要跟着它走。
func TestLoopbackTargetFollowsAnExplicitBase(t *testing.T) {
	target, ok := loopbackTarget("http://127.0.0.1:38162")
	if !ok || target.LanPort != 38162 || target.Base != "http://127.0.0.1:38162" {
		t.Errorf("loopbackTarget = %+v, %v", target, ok)
	}
	if target, ok := loopbackTarget("http://localhost:43499"); !ok || target.LanPort != 43499 {
		t.Errorf("localhost target = %+v, %v", target, ok)
	}
	// 公网中转地址不是本机队伍，配对仍用发现到的那个；无端口也不行。
	for _, base := range []string{"https://jarvis.kentonnie.top/crew-relay/i/kenton-mac", "http://127.0.0.1", "not a url"} {
		if _, ok := loopbackTarget(base); ok {
			t.Errorf("loopbackTarget accepted %q", base)
		}
	}
}

func TestCredentialRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "credential.json")
	want := Credential{DeviceID: "crew-desktop", Token: "secret-token", Base: "http://127.0.0.1:43499"}
	if err := saveCredential(path, want); err != nil {
		t.Fatal(err)
	}
	got, ok := loadCredential(path)
	if !ok || got != want {
		t.Fatalf("loadCredential = %+v, %v; want %+v", got, ok, want)
	}
	// 已存在的宽权限文件也要在写入时收紧：WriteFile 本身不改旧文件的 mode。
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := saveCredential(path, want); err != nil {
		t.Fatal(err)
	}
	// 凭据是能做任意请求的东西：目录与文件都不能让同机其他用户读。
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("credential mode = %o, want 600", mode)
	}
	directory, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if mode := directory.Mode().Perm(); mode != 0o700 {
		t.Errorf("directory mode = %o, want 700", mode)
	}
}

func TestLoadCredentialTreatsBrokenFilesAsUnpaired(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "credential.json")
	for _, body := range []string{
		"{", // 半截 JSON
		`{"deviceId":"a","token":"","base":"http://x"}`, // 凭据是空的
		`{"deviceId":"a","token":"t"}`,                  // 没有地址就不知道该连哪
	} {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, ok := loadCredential(path); ok {
			t.Errorf("loadCredential accepted %q", body)
		}
	}
	if _, ok := loadCredential(filepath.Join(directory, "missing.json")); ok {
		t.Error("loadCredential accepted a missing file")
	}
}

func TestDiscoverFindsProfilesAndPrefersALiveCrew(t *testing.T) {
	profiles := t.TempDir()
	write := func(name, body string) {
		directory := filepath.Join(profiles, name)
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "cordis.patch.yml"), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("web", "- id: dsh-superagent\n  config:\n    stateDir: /Users/cpuser/.dsh/state/superagent-web\n")
	write("desktop", "- id: dsh-superagent\n  config:\n    stateDir: /Users/cpuser/.dsh/state/superagent\n")
	write("headless", "- id: permission\n  config:\n    defaultPreset: danger\n")

	// 只有 desktop 那个端口有人听：它才是这次要连的。
	found := discover(profiles, func(port int) bool { return port == 43499 })
	if len(found) != 1 {
		t.Fatalf("discover found %d live crews, want 1: %+v", len(found), found)
	}
	if found[0].Profile != "desktop" || found[0].Base != "http://127.0.0.1:43499" {
		t.Errorf("picked %+v", found[0])
	}
	// 探测到活队伍之后，网页端口要按「同进程里真答管理面的那个」走；
	// 只剩 profile 里的默认值（3080）就说明没探到，导出与设备表会打错端口。
	if found[0].WebPort == 0 || found[0].WebPort == found[0].LanPort {
		t.Errorf("webPort = %d（LanPort %d）：应该解析出同进程的网页端口", found[0].WebPort, found[0].LanPort)
	}

	// 一个都不活：返回空，界面据此说「没找到在跑的队伍」。
	if all := discover(profiles, func(int) bool { return false }); len(all) != 0 {
		t.Errorf("dead crews leaked through: %+v", all)
	}
	// 两个都活：按 profile 名排，desktop 在前。
	both := discover(profiles, func(int) bool { return true })
	if len(both) != 2 || both[0].Profile != "desktop" {
		t.Errorf("order = %+v", both)
	}
}

// 发现到的队伍必须带着「真正答管理面」的那个端口。
//
// profile 里写的通常是默认 3080，而管理面在同进程的另一个端口上；不解析这一层，
// 设备表与备份就会打到一个不存在的端口上，界面上看起来是「读不到设备」。
func TestDiscoveredCrewCarriesThePortThatAnswersManagement(t *testing.T) {
	for _, target := range discover(profilesDir(), dialAlive) {
		if target.WebPort == 0 {
			t.Errorf("%s 的 WebPort 是 0", target.Profile)
		}
		if target.WebPort == target.LanPort {
			t.Errorf("%s 的 WebPort 与 LanPort 相同（%d）：管理面不在消息面那个端口上", target.Profile, target.LanPort)
		}
	}
}
