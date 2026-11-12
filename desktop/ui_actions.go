// 桌面四个动作入口：改记忆、听播报、接手工单、语音输入。
//
// 状态都收在 actionState 里：后台线程只把结果放进 results，主线程在 drain 里应用，
// 和这个窗口其它异步动作同一套规矩（不跨线程碰同一份状态）。
package main

import (
	"context"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
)

// actionResult 是一次动作的结果。kind 决定改哪一块状态，name 是记忆名或票号，
// text 是识别出来的文字，note 是给人看的那句回执，state 是录音的下一步状态。
type actionResult struct {
	kind  string
	name  string
	text  string
	note  string
	state string
	ok    bool
}

type actionState struct {
	results chan actionResult

	// 改记忆：editingMemory 空表示编辑层没开。
	editingMemory     string
	memoryDescription string
	memoryBody        string
	memorySaving      bool
	memoryEditError   string

	// 听播报：一次只念一条，失败与成功都写在这一行。
	speaking  bool
	speakNote string

	// 接手：回执按票记，卡片只显示自己那张。
	takeoverBusy map[string]bool
	takeoverNote map[string]string

	// 语音输入：voiceState 是 "" / starting / recording / working。
	voiceState string
	voiceNote  string
	// 录音动作的 seam：默认就是 record.go 的 mic（AVFoundation），
	// 测试里换成写固定 WAV 字节的假实现，不必真的开麦克风。
	recorder voiceRecorder
}

func newActionState() *actionState {
	return &actionState{
		results:      make(chan actionResult, 8),
		takeoverBusy: map[string]bool{},
		takeoverNote: map[string]string{},
		recorder:     &mic,
	}
}

// deliver 把后台结果交回主线程，并催一帧：不催的话界面会停在「正在…」。
func (s *app) deliver(r actionResult) {
	s.actions.results <- r
	s.wake()
}

// applyAction 只由主线程（drain）调用。所有跨线程的状态变更都收在这里。
func (s *app) applyAction(r actionResult) {
	a := s.actions
	if a == nil {
		return
	}
	switch r.kind {
	case "memory":
		// 换了另一条再收到旧回执：那句话不该写到新开的编辑层上。
		if r.name != a.editingMemory {
			return
		}
		a.memorySaving = false
		if !r.ok {
			a.memoryEditError = r.note
			return
		}
		a.editingMemory, a.memoryDescription, a.memoryBody, a.memoryEditError = "", "", "", ""
		s.loadMemory()
	case "speak":
		a.speaking = false
		a.speakNote = r.note
	case "takeover":
		delete(a.takeoverBusy, r.name)
		a.takeoverNote[r.name] = r.note
		if r.ok {
			s.refresh()
		}
	case "voice":
		a.voiceState, a.voiceNote = r.state, r.note
		// 识别出来的字只进草稿。发出去是「↑」那一下，不是录音结束那一下。
		if r.ok && r.text != "" {
			s.input = mergeDraft(s.input, r.text)
		}
	}
}

// mergeDraft 把识别文字接到已有草稿后面。空识别不动草稿；已有内容不以空格收尾时补一个，
// 免得两句粘在一起。它只拼字符串，不发送。
func mergeDraft(existing, recognized string) string {
	text := strings.TrimSpace(recognized)
	if text == "" {
		return existing
	}
	if existing == "" {
		return text
	}
	if strings.HasSuffix(existing, " ") || strings.HasSuffix(existing, "\n") || strings.HasSuffix(existing, "，") {
		return existing + text
	}
	return existing + " " + text
}

// ---------- 入口 1：改一条记忆 ----------

// editMemory 打开编辑层，草稿填的是账本里现在的值。
func (s *app) editMemory(item MemoryItem) {
	a := s.actions
	if a == nil || item.Name == "" {
		return
	}
	a.editingMemory = item.Name
	a.memoryDescription = item.Description
	a.memoryBody = item.Body
	a.memoryEditError = ""
	a.memorySaving = false
}

// cancelMemoryEdit 关掉编辑层。取消不写账本，草稿一起丢掉。
func (s *app) cancelMemoryEdit() {
	a := s.actions
	if a == nil {
		return
	}
	a.editingMemory, a.memoryDescription, a.memoryBody = "", "", ""
	a.memoryEditError, a.memorySaving = "", false
}

// saveMemory 把编辑层里的标题与正文交给 Client.EditMemory。
// 成功才关层并重读；失败把后端那句 reason 原样留在层里。
func (s *app) saveMemory() {
	a := s.actions
	if a == nil || s.client == nil || a.memorySaving || a.editingMemory == "" {
		return
	}
	name, description, body := a.editingMemory, a.memoryDescription, a.memoryBody
	a.memorySaving, a.memoryEditError = true, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		err := s.client.EditMemory(ctx, name, description, body)
		result := actionResult{kind: "memory", name: name, ok: err == nil}
		if err != nil {
			result.note = err.Error()
		}
		s.deliver(result)
	}()
}

// memoryEditor 是「改这条记忆」的浮层，与改人设那一层同一套排版。
func (s *app) memoryEditor(c *ui.Context, p Palette) {
	a := s.actions
	ui.Column(c).Absolute().FillWidth().FillHeight().Left(0).Top(0).
		Background(p.Surface.Alpha(0.55)).Center().Children(func() {
		ui.Column(c).Width(420).Gap(11).Padding(20).Radius(RadiusFolder).
			Background(p.Card).BorderWidth(1).BorderColor(p.Line).Children(func() {
			ui.Text(c, "改这条记忆").FontSize(FontHeader).FontWeight(WeightTitle).TextColor(p.Ink)
			ui.Text(c, a.editingMemory).FontSize(FontMini).TextColor(p.Faint)

			ui.Text(c, "标题").FontSize(FontTiny).FontWeight(WeightName).TextColor(p.Faint)
			ui.TextInput(c, &a.memoryDescription).FillWidth().FontSize(FontBodyWide).
				TextColor(p.Ink).CaretColor(p.Accent).SelectionColor(p.AccentSoft).Background(p.Card)

			ui.Text(c, "正文").FontSize(FontTiny).FontWeight(WeightName).TextColor(p.Faint)
			ui.Column(c).FillWidth().Height(120).Padding(9).Radius(RadiusItem).
				BorderWidth(1).BorderColor(p.Line).Background(p.Surface).Children(func() {
				ui.TextInput(c, &a.memoryBody).FillWidth().FontSize(FontBodyWide).
					TextColor(p.Ink).CaretColor(p.Accent).SelectionColor(p.AccentSoft).Background(p.Card)
			})

			if a.memoryEditError != "" {
				ui.Row(c).FillWidth().Padding(8).Radius(RadiusItem).Background(p.DangerSoft).Children(func() {
					ui.Text(c, "没改成功："+a.memoryEditError).FontSize(FontMini).TextColor(p.Danger)
				})
			}
			ui.Row(c).FillWidth().Gap(7).Children(func() {
				ui.Row(c).PaddingX(14).PaddingY(9).Radius(RadiusButton).Background(p.Card).
					BorderWidth(1).BorderColor(p.Line).Center().Cursor(ui.CursorPointer).
					OnClick(s.cancelMemoryEdit).Children(func() {
					ui.Text(c, "取消").FontSize(FontBodyWide).TextColor(p.Muted)
				})
				ui.Row(c).Grow(1).Height(36).Radius(RadiusButton).Background(p.Accent).
					Center().Cursor(ui.CursorPointer).OnClick(s.saveMemory).Children(func() {
					label := "保存"
					if a.memorySaving {
						label = "保存中…"
					}
					ui.Text(c, label).FontSize(FontBodyWide).FontWeight(WeightName).TextColor(p.AccentInk)
				})
			})
		})
	})
}
