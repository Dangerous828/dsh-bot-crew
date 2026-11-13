// board.go —— 聊天模式右栏的事务板。
//
// 数据源是「当前这一段会话」的 Conversation（conversations[currentSession] 的视图）：
// 切到别的会话时这块板跟着换缓存，绝不把另一段的 tasks[] / Queued 摆出来。
// tasks[] 是事务，Queued 是「已接受、还没回复、还能撤回」的请求号，不是任务集。
// 所以「还没回的话」这组按 request_id 反查 items 里的原话，不伪装成工单。
// 反编造：查不到正文就跳过、分组为空就不画该组、没有计划就不画进度条。
package main

import (
	"fmt"

	"github.com/egoist/mygo/ui"
)

// boardGroups 把一次时间线分成事务板的四组。纯函数：不碰界面、不发请求。
//
// 三组工单只按后端给的字段判：办完 !Open、等你拍板 NeedsPerson 非空、在跑 Open 且不等人。
// 一组 Task 只进一个分组，不会在两处重复出现。
func boardGroups(conversation *Conversation) (queued []queuedPreview, running, waiting, done []Task) {
	if conversation == nil {
		return nil, nil, nil, nil
	}
	// limit=0 表示全取；queuedPreviews 已按 request_id 对回正文。
	// 对不上的那条只有请求号，画出来会变成一句没有出处的话，跳过。
	for _, preview := range queuedPreviews(conversation, 0) {
		if preview.Text == "" {
			continue
		}
		queued = append(queued, preview)
	}
	for _, task := range conversation.Tasks {
		switch {
		case !task.Open:
			done = append(done, task)
		case task.NeedsPerson != "":
			waiting = append(waiting, task)
		default:
			running = append(running, task)
		}
	}
	return queued, running, waiting, done
}

// boardTimeOf 是一条工单能写出来的时间：先更新时间、再创建时间。
// 两个都认不出（或超过一天）就交回空串，不补一个猜的分钟数。
func boardTimeOf(task Task) string {
	for _, at := range []string{task.UpdatedAt, task.CreatedAt} {
		if label := elapsedLabel(at); label != "" {
			return label
		}
	}
	return ""
}

// boardPane 是右栏那一块紧凑列表。四个分组，空组整组不画。
func (s *app) boardPane(c *ui.Context, p Palette) {
	ui.Row(c).Gap(7).AlignItems(ui.Center).Children(func() {
		ui.Text(c, "事务板").FontSize(FontBodyWide).FontWeight(WeightTitle).TextColor(p.Ink)
		ui.Row(c).Grow(1)
		s.collapseButton(c, p)
	})

	if s.conversation == nil {
		// 「读不到」和「确实没有」不是一句话。时间线还没回来时一条都不画，
		// 也不写「0 条」—— 那会替后端说队伍里没有事。
		ui.Column(c).FillWidth().Grow(1).Children(func() {
			line := "正在读事务…"
			if s.problem != "" {
				line = "还没连上，读不到事务"
			}
			ui.Text(c, line).FontSize(FontBody).TextColor(p.Faint)
		})
		return
	}

	queued, running, waiting, done := boardGroups(s.conversation)
	if len(queued)+len(running)+len(waiting)+len(done) == 0 {
		// 读得到、确实一条都没有：这才是 empty。
		ui.Column(c).FillWidth().Grow(1).Gap(6).Children(func() {
			ui.Text(c, "还没有事务").FontSize(FontBody).TextColor(p.Muted)
			ui.Text(c, "丢进来的话和派下去的活会出现在这里。").FontSize(FontSmall).TextColor(p.Faint)
		})
		return
	}

	ui.Scroll(c).Grow(1).FillWidth().Children(func() {
		ui.Column(c).Gap(12).Children(func() {
			if len(queued) > 0 {
				s.boardSection(c, p, "还没回的话", len(queued), func() {
					for _, item := range queued {
						s.boardQueuedRow(c, p, item)
					}
				})
			}
			if len(running) > 0 {
				s.boardSection(c, p, "在跑", len(running), func() {
					for _, task := range running {
						s.boardTaskRow(c, p, task)
					}
				})
			}
			if len(waiting) > 0 {
				s.boardSection(c, p, "等你拍板", len(waiting), func() {
					for _, task := range waiting {
						s.boardTaskRow(c, p, task)
					}
				})
			}
			if len(done) > 0 {
				s.boardSection(c, p, "办完", len(done), func() {
					for _, task := range done {
						s.boardTaskRow(c, p, task)
					}
				})
			}
		})
	})
}

// boardSection 是一个分组：标题 + 条数 + 紧凑的几行。调用方保证 rows 非空，
// 空组不画 —— 不摆一个写着 0 的空标题充数。
func (s *app) boardSection(c *ui.Context, p Palette, title string, count int, rows func()) {
	ui.Column(c).FillWidth().Gap(5).Children(func() {
		ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
			ui.Text(c, title).FontSize(FontSmall).FontWeight(WeightLabel).TextColor(p.Muted)
			ui.Row(c).Grow(1)
			ui.Text(c, fmt.Sprintf("%d", count)).FontSize(FontTiny).TextColor(p.Faint)
		})
		rows()
	})
}

// boardTaskRow 是一条工单：状态点 + 标题 + 谁 + 时间，有计划才补一根进度条。
// 点一下走的是既有「选中票」逻辑（openWork / openTicket），与后台那张卡同一个入口。
func (s *app) boardTaskRow(c *ui.Context, p Palette, task Task) {
	ticketID := task.ID
	soft := p.Card
	if s.openTicket == ticketID {
		soft = p.SelectedAlt
	}
	ui.Column(c).FillWidth().PaddingX(10).PaddingY(7).Gap(4).Radius(RadiusItem).
		Background(soft).BorderWidth(1).BorderColor(p.Line).Cursor(ui.CursorPointer).Children(func() {
		ui.Row(c).FillWidth().Gap(7).AlignItems(ui.Start).Children(func() {
			ui.Column(c).Width(5).Height(5).Radius(RadiusDot).Margin(0, 5, 0, 0).
				Background(s.taskDotColor(p, task))
			ui.Text(c, task.Title).FontSize(FontBodyWide).TextColor(p.Ink).
				Grow(1).MinWidth(0).MaxLines(1).Ellipsis("…")
		})
		detail := ""
		if task.BotID != "" {
			detail = s.nameOf(task.BotID)
		}
		if when := boardTimeOf(task); when != "" {
			if detail != "" {
				detail += " · "
			}
			detail += when
		}
		if detail != "" {
			ui.Row(c).FillWidth().PaddingStart(12).Children(func() {
				ui.Text(c, detail).FontSize(FontTiny).TextColor(p.Muted).MaxLines(1).Ellipsis("…")
			})
		}
		// 分母来自后端下发的计划。没有计划（TotalSteps<=0）就整根不画，
		// 零步走完只画轨道、不画那一格强调色。口径与 ui.go 的 progressOf 一致。
		if done, total := s.progressOf(task); total > 0 {
			ui.Row(c).FillWidth().PaddingStart(12).Height(3).Radius(RadiusTiny).
				Background(p.Track).Children(func() {
				if done <= 0 {
					return
				}
				ui.Row(c).WidthPercent(float32(done) / float32(total) * 100).FillHeight().
					Radius(RadiusTiny).Background(p.Accent)
			})
		}
	}).OnClick(func() { s.openWork(ticketID) })
}

// boardQueuedRow 是「还没回的话」里的一条。它不是工单，是 Queued 的请求号
// 对回的原话。没有票可展开，就不接一个点了没反应的点击。
func (s *app) boardQueuedRow(c *ui.Context, p Palette, item queuedPreview) {
	ui.Row(c).FillWidth().PaddingX(10).PaddingY(7).Gap(7).Radius(RadiusItem).
		Background(p.Card).BorderWidth(1).BorderColor(p.Line).AlignItems(ui.Start).Children(func() {
		ui.Column(c).Width(5).Height(5).Radius(RadiusDot).Margin(0, 5, 0, 0).Background(p.Faint)
		ui.Text(c, queuedSummary(item.Text, 42)).FontSize(FontBody).TextColor(p.Ink).
			Grow(1).MinWidth(0).MaxLines(1).Ellipsis("…")
	})
}
