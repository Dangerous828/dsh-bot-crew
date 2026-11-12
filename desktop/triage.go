// triage.go —— 分拣台的中栏：收件筐 → 大哥在分 → 各人的活儿。
//
// 这一轮只做三段骨架：都从一次 /timeline 读回来的 Conversation 取数，
// 没有数据就只写一句实话，不摆假纸条。纸感是分拣台自己的局部色，
// 不进 Palette —— 聊天模式的暗色体系一个字都不动。
package main

import (
	"fmt"

	"github.com/egoist/mygo/ui"
)

// 案头用的几层局部色：亚麻纸底、纸条、墨、朱红。只在 triagePane 里用。
var (
	triagePaper = ui.Hex("#F1EADC")
	triageCard  = ui.Hex("#FBF7F0")
	triageInk   = ui.Hex("#2F2A24")
	triageMuted = ui.Hex("#5B5247")
	triageLine  = ui.Hex("#D6CBB9")
	triageSeal  = ui.Hex("#A6473B")
)

// triageInboxLimit 是收件筐里露出来的最近几张纸条。
const triageInboxLimit = 5

// triagePile 是「各人的活儿」里某一位的那一堆。
type triagePile struct {
	BotID string
	Tasks []Task
}

// triageGroups 是三段的数据。纯函数：不碰界面、不发请求。
//
// 收件筐取 role=user 的最近几条（最新在最上，像刚扔进去的）；
// 「大哥在分」是等你拍板的票 + 刚派下去的（Open 且有 BotID）；
// 「各人的活儿」按 BotID 分堆，堆的顺序是第一次出现的顺序，不按字母猜。
// BotID 为空的票不编一个人出来接它。
func triageGroups(conversation *Conversation, inboxLimit int) ([]Message, []Task, []triagePile) {
	if conversation == nil {
		return nil, nil, nil
	}
	var inbox []Message
	for i := len(conversation.Messages) - 1; i >= 0 && inboxLimit > 0 && len(inbox) < inboxLimit; i-- {
		message := conversation.Messages[i]
		if message.Role != "user" || message.Text == "" {
			continue
		}
		inbox = append(inbox, message)
	}
	var sorting []Task
	for _, task := range conversation.Tasks {
		if task.NeedsPerson != "" || (task.Open && task.BotID != "") {
			sorting = append(sorting, task)
		}
	}
	var piles []triagePile
	indexOf := map[string]int{}
	for _, task := range conversation.Tasks {
		if task.BotID == "" {
			continue
		}
		at, ok := indexOf[task.BotID]
		if !ok {
			at = len(piles)
			indexOf[task.BotID] = at
			piles = append(piles, triagePile{BotID: task.BotID})
		}
		piles[at].Tasks = append(piles[at].Tasks, task)
	}
	return inbox, sorting, piles
}

// triageCountLine 是底部那条计数带。每个数都从时间线里现算，不写死一个 7。
func triageCountLine(conversation *Conversation) string {
	if conversation == nil {
		return ""
	}
	inbox, running, waiting, done := 0, 0, 0, 0
	for _, message := range conversation.Messages {
		if message.Role == "user" {
			inbox++
		}
	}
	for _, task := range conversation.Tasks {
		switch {
		case !task.Open:
			done++
		case task.NeedsPerson != "":
			waiting++
		default:
			running++
		}
	}
	return fmt.Sprintf("收进 %d · 在跑 %d · 等你拍板 %d · 办完 %d", inbox, running, waiting, done)
}

// triagePane 是中栏的三段骨架。mode==modeTriage 时才画。
func (s *app) triagePane(c *ui.Context, _ Palette) {
	// 纸感是这一层自己的局部色，不用聊天模式的 Palette。
	ui.Column(c).Grow(1).MinWidth(0).FillWidth().FillHeight().Gap(0).ClipX().
		Background(triagePaper).Children(func() {
		ui.Row(c).FillWidth().PaddingX(24).PaddingY(13).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "分拣台").FontSize(FontTitle).FontWeight(WeightTitle).TextColor(triageInk)
			ui.Row(c).Grow(1)
			ui.Text(c, "收进 → 分配 → 办完").FontSize(FontSmall).TextColor(triageMuted)
		})
		ui.Column(c).FillWidth().Height(1).Background(triageLine)

		if s.conversation == nil {
			// 读不到就是读不到：不摆空纸条凑成一张「案头」。
			ui.Column(c).Grow(1).FillWidth().PaddingX(24).PaddingY(18).Children(func() {
				line := "正在读队伍的状态…"
				if s.problem != "" {
					line = "还没连上，读不到队伍的状态"
				}
				ui.Text(c, line).FontSize(FontBody).TextColor(triageMuted)
			})
			return
		}

		inbox, sorting, piles := triageGroups(s.conversation, triageInboxLimit)
		ui.Scroll(c).Grow(1).FillWidth().Children(func() {
			ui.Column(c).FillWidth().PaddingX(24).PaddingY(18).Gap(18).Children(func() {
				// 一、收件筐：最近丢进来的几句话。
				s.triageSection(c, "收件筐", func() {
					if len(inbox) == 0 {
						ui.Text(c, "筐里还没有东西").FontSize(FontSmall).TextColor(triageMuted)
						return
					}
					for _, message := range inbox {
						s.triageNote(c, queuedSummary(message.Text, 48))
					}
				})
				// 二、大哥在分：等你拍板的、刚派下去的。
				s.triageSection(c, "大哥在分", func() {
					if len(sorting) == 0 {
						ui.Text(c, "还没有要分的活儿").FontSize(FontSmall).TextColor(triageMuted)
						return
					}
					for _, task := range sorting {
						s.triageTaskNote(c, task)
					}
				})
				// 三、各人的活儿：按 BotID 分堆。
				s.triageSection(c, "各人的活儿", func() {
					if len(piles) == 0 {
						ui.Text(c, "还没有派给谁").FontSize(FontSmall).TextColor(triageMuted)
						return
					}
					for _, pile := range piles {
						ui.Column(c).FillWidth().Gap(6).Children(func() {
							ui.Text(c, "→ "+s.nameOf(pile.BotID)).FontSize(FontSmall).
								FontWeight(WeightLabel).TextColor(triageMuted)
							for _, task := range pile.Tasks {
								s.triageTaskNote(c, task)
							}
						})
					}
				})
			})
		})
		ui.Row(c).FillWidth().PaddingX(24).PaddingY(10).Background(triageCard).Children(func() {
			ui.Text(c, triageCountLine(s.conversation)).FontSize(FontSmall).TextColor(triageMuted)
		})
	})
}

// triageSection 是一段的标题 + 内容。空段只写一句实话，不画假纸条。
func (s *app) triageSection(c *ui.Context, title string, body func()) {
	ui.Column(c).FillWidth().Gap(8).Children(func() {
		ui.Text(c, title).FontSize(FontLabel).FontWeight(WeightName).TextColor(triageInk)
		ui.Column(c).FillWidth().Gap(6).Children(body)
	})
}

// triageNote 是一张纸条（一句话）。骨架阶段不接点击，不画一个按下去没反应的入口。
func (s *app) triageNote(c *ui.Context, text string) {
	ui.Row(c).FillWidth().PaddingX(14).PaddingY(10).Radius(RadiusItem).
		Background(triageCard).BorderWidth(1).BorderColor(triageLine).Children(func() {
		ui.Text(c, text).FontSize(FontBody).TextColor(triageInk).MaxLines(2).Ellipsis("…")
	})
}

// triageTaskNote 是一张写着派单的纸条：标题 + 派给谁，有计划才补进度条。
func (s *app) triageTaskNote(c *ui.Context, task Task) {
	ui.Column(c).FillWidth().PaddingX(14).PaddingY(10).Gap(5).Radius(RadiusItem).
		Background(triageCard).BorderWidth(1).BorderColor(triageLine).Children(func() {
		ui.Row(c).FillWidth().Gap(7).AlignItems(ui.Start).Children(func() {
			ui.Column(c).Width(5).Height(5).Radius(RadiusDot).Margin(0, 5, 0, 0).
				Background(triageSeal)
			ui.Text(c, task.Title).FontSize(FontBody).TextColor(triageInk).
				Grow(1).MinWidth(0).MaxLines(1).Ellipsis("…")
		})
		if task.BotID != "" {
			ui.Row(c).FillWidth().PaddingStart(12).Children(func() {
				ui.Text(c, "→ "+s.nameOf(task.BotID)).FontSize(FontTiny).TextColor(triageMuted)
			})
		}
		if done, total := s.progressOf(task); total > 0 {
			ui.Row(c).FillWidth().PaddingStart(12).Height(3).Radius(RadiusTiny).
				Background(triageLine).Children(func() {
				if done <= 0 {
					return
				}
				ui.Row(c).WidthPercent(float32(done) / float32(total) * 100).FillHeight().
					Radius(RadiusTiny).Background(triageSeal)
			})
		}
	})
}
