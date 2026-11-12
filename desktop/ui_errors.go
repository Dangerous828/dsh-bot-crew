package main

import (
	"log"
	"strings"
	"unicode"
)

// actionNote 把动作失败的原始错误翻成给人看的一句话。
// 后端给的是中文人话（契约 §5 的 reason）就原样显示，那是给人看的；
// 撞上英文内部错误才翻成中文人话，未知的一律兜底。原文只进日志。
func actionNote(prefix string, err error) string {
	raw := ""
	if err != nil {
		raw = err.Error()
	}
	if raw != "" {
		log.Printf("%s（原始错误）：%s", prefix, raw)
	}
	return prefix + "：" + actionErrorHuman(raw)
}

// actionErrorHuman 是错误映射表：中文 reason 原样回，英文内部错误按形状翻，
// 命中不了就统一兜底。不把后端内部字符串甩给用户。
func actionErrorHuman(raw string) string {
	if raw == "" {
		return "这次没成功，稍后再试"
	}
	if hasHan(raw) {
		return raw
	}
	lower := strings.ToLower(raw)
	switch {
	case strings.Contains(lower, "text is required"), strings.Contains(lower, "text required"):
		return "少了要念的文字"
	case strings.Contains(lower, "no speech provider"), strings.Contains(lower, "no provider"):
		return "没找到可用的语音服务"
	case strings.Contains(lower, "permission denied"), strings.Contains(lower, "not authorized"):
		return "麦克风没授权，去系统设置里打开"
	case strings.Contains(lower, "connection refused"),
		strings.Contains(lower, "no such host"),
		strings.Contains(lower, "timeout"),
		strings.Contains(lower, "deadline exceeded"),
		strings.Contains(lower, "connection reset"):
		return "没连上队伍，稍后再试"
	case strings.Contains(lower, "afplay"):
		return "声音没放出来，稍后再试"
	case strings.Contains(lower, "wav"), strings.Contains(lower, "16k"):
		return "录音格式不合要求，重录一次"
	default:
		return "这次没成功，稍后再试"
	}
}

// hasHan 判断这句 reason 是不是中文人话：后端写给人看的原因按契约原样显示。
func hasHan(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}
