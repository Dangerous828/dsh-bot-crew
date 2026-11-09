// 队伍对话的窗口：上面是消息，下面是输入框，底下一排 Bot 名片。
package main

import (
	"context"
	"fmt"
	"time"

	"github.com/egoist/mygo/ui"
)

// app 是这个窗口的全部状态。它只在主线程上改。
type app struct {
	client *Client
	input  string

	conversation *Conversation
	problem      string
	sending      bool

	// refreshing 挡住并发刷新，省得每次调用都开一个请求。
	refreshing bool
	// 后台线程把结果放这里，主线程在下一帧取走，避免跨线程碰同一份状态。
	arrived chan *Conversation
	failed  chan string
}

func (s *app) refresh() {
	if s.client == nil || s.refreshing {
		return
	}
	s.refreshing = true
	go func() {
		defer func() { s.refreshing = false }()
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		conversation, err := s.client.Timeline(ctx)
		if err != nil {
			s.failed <- err.Error()
			return
		}
		s.arrived <- conversation
	}()
}

func (s *app) send() {
	text := s.input
	if text == "" || s.sending {
		// 空消息不发：点了也什么都不发生，比发出去一条空白更好。
		return
	}
	s.sending = true
	go func() {
		defer func() { s.sending = false }()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		mentions := mentionsIn(text, s.conversation)
		if _, err := s.client.Send(ctx, text, mentions); err != nil {
			s.failed <- err.Error()
			return
		}
		s.arrived <- &Conversation{} // 空结果只用来触发一次重读，让刚发的话尽快出现
		s.refresh()
	}()
}

// mentionsIn 找出消息里 @ 到的 Bot。点名是纯文本，客户端只负责把它认出来随消息一起送。
func mentionsIn(text string, conversation *Conversation) []string {
	if conversation == nil {
		return nil
	}
	var found []string
	for _, bot := range conversation.Bots {
		for _, needle := range []string{"@" + bot.ID, "@" + bot.Name} {
			if len(needle) > 1 && contains(text, needle) {
				found = append(found, bot.ID)
				break
			}
		}
	}
	return found
}

func contains(haystack, needle string) bool {
	if len(needle) > len(haystack) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func (s *app) view(c *ui.Context) {
	s.drain()
	t := c.Theme()
	ui.Column(c).Fill().Gap(0).Children(func() {
		s.header(c, t)
		s.messages(c, t)
		s.composer(c, t)
		s.roster(c, t)
	})
}

// drain 把后台线程交回来的结果收进状态，并请求下一帧。
func (s *app) drain() {
	for {
		select {
		case conversation := <-s.arrived:
			if conversation != nil && (conversation.Messages != nil || conversation.Bots != nil) {
				s.conversation, s.problem = conversation, ""
			}
		case message := <-s.failed:
			s.problem = message
			s.sending = false
		default:
			return
		}
	}
}

func (s *app) header(c *ui.Context, t *ui.Theme) {
	ui.Row(c).Padding(16).Gap(10).Children(func() {
		ui.Text(c, "Bot 队伍").FontSize(20).Bold()
		if s.conversation != nil && len(s.conversation.Bots) > 0 {
			ui.Text(c, fmt.Sprintf("%d 位", len(s.conversation.Bots))).FontSize(12).TextColor(t.TextMuted)
		}
		ui.Button(c, "刷新").OnClick(s.refresh)
	})
}

func (s *app) messages(c *ui.Context, t *ui.Theme) {
	if s.problem != "" {
		ui.Row(c).Padding(16).Children(func() {
			// 后端不可达时说人话，别留白屏。
			ui.Text(c, "连不上队伍："+s.problem).FontSize(13).TextColor(t.Danger)
		})
	}
	switch {
	case s.conversation == nil:
		ui.Row(c).Padding(16).Children(func() { ui.Text(c, "正在读对话…").FontSize(13).TextColor(t.TextMuted) })
	case len(s.conversation.Messages) == 0:
		ui.Row(c).Padding(16).Children(func() { ui.Text(c, "还没有人说话。在下面写一句试试。").FontSize(13).TextColor(t.TextMuted) })
	default:
		ui.Scroll(c).Grow(1).Children(func() {
			ui.Column(c).Padding(16).Gap(12).Children(func() {
				for _, message := range s.conversation.Messages {
					s.message(c, t, message)
				}
			})
		})
	}
}

func (s *app) message(c *ui.Context, t *ui.Theme, message Message) {
	fromBot := message.Role == "agent"
	ui.Column(c).Gap(3).Children(func() {
		ui.Row(c).Gap(6).Children(func() {
			if fromBot {
				ui.Text(c, s.nameOf(message.BotID)).FontSize(12).Bold()
			} else {
				ui.Text(c, "我").FontSize(12).TextColor(t.TextMuted)
			}
			if when := shortTime(message.At); when != "" {
				ui.Text(c, when).FontSize(11).TextColor(t.TextMuted)
			}
		})
		ui.Text(c, message.Text).FontSize(14)
	})
}

func (s *app) nameOf(botID string) string {
	if s.conversation != nil {
		for _, bot := range s.conversation.Bots {
			if bot.ID == botID {
				return bot.Name
			}
		}
	}
	return botID
}

func (s *app) composer(c *ui.Context, t *ui.Theme) {
	ui.Row(c).Padding(16).Gap(10).Children(func() {
		ui.TextInput(c, &s.input).Placeholder("写一句，回车发送").Grow(1).OnSubmit(func() {
			s.send()
		})
		if s.sending {
			ui.Text(c, "发送中…").FontSize(12).TextColor(t.TextMuted)
		} else if ui.PrimaryButton(c, "发送").Clicked() {
			s.send()
		}
	})
}

func (s *app) roster(c *ui.Context, t *ui.Theme) {
	if s.conversation == nil || len(s.conversation.Bots) == 0 {
		return
	}
	ui.Row(c).Padding(16).Gap(8).Children(func() {
		for _, bot := range s.conversation.Bots {
			bot := bot
			label := "@" + bot.Name
			if bid := ui.Button(c, label); bid.Clicked() {
				// 点名片把 @名字 插进输入框，省得手打。
				if s.input != "" && s.input[len(s.input)-1] != ' ' {
					s.input += " "
				}
				s.input += "@" + bot.Name + " "
			}
		}
		ui.Text(c, "点名片可以 @ 他").FontSize(11).TextColor(t.TextMuted)
	})
}

// shortTime 把后端的时间裁成时分；认不出来就不显示，别把原始串甩给人看。
func shortTime(at string) string {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z"} {
		if parsed, err := time.Parse(layout, at); err == nil {
			return parsed.Local().Format("15:04")
		}
	}
	return ""
}
