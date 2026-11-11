// 队伍对话的窗口：左边花名册，中间对话，右边后台。
package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

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
	// sent 把「这次发出去的原文」带回主线程：只有输入框里还是这句时才清空，
	// 否则会把用户刚打的新内容抹掉。
	sent   chan string
	tree   chan []AgentNode
	paired chan Credential
	// 配对失败单独一条：它不该写成「连不上队伍」，那是连接问题，不是配对问题。
	pairFailed chan string
	steps      chan workResult
	// modelList 是模型目录回来了；modelSwitched 是换成功了。
	// 两份分开：读失败和换失败要说的不是一句话。
	modelList     chan *ModelCatalog
	modelSwitched chan modelSwitchResult
	// efforts 是当前作用域那条路由的推理档位；effortsCh 把异步结果带回主线程。
	efforts   *EffortsView
	effortsCh chan *EffortsView
	// modelScope 是「这次换模型应用给谁」：空串是全场，否则是 bot_id。
	modelScope string
	// modelError 与 failed 分开：模型目录/切换失败只该写在模型栏里。
	modelError chan string
	// screenNoteCh 是屏幕接口的返回：它是「暂时没有」，不是断连。
	screenNoteCh chan string
	// screenCh 是读到的活动快照；主线程拿它把中间栏换成画面。
	screenCh chan *ScreenView
	// 重试失败也一样：只影响这张票，不冒充断连。
	retryErrorCh chan string
	retryError   string

	// agents 是第一张工单下的代理树。读不到就空着，不挡住对话。
	agents []AgentNode

	// 配对：主人点一下，本机出码、本机兑换，凭据写进 ~/.config 后下次启动直接用。
	pairingNote string
	// target 是自动发现到的队伍（端口与 profile）；配对要用它的出码与兑换端口。
	target crewTarget
	// endpoint 是这次实际连的地址，断连横幅要把它说出来 —— 「连不上」三个字不告诉人连的是哪。
	endpoint string

	// 打开的那张工单和它的过程。过程带着票号回来，所以点开 A 之后又点 B，A 的结果不会冒充成 B 的。
	openTicket string
	// screenNote 是「看它的屏幕」给出的实话（没有记录、读不出来），与连接故障分开显示。
	screenNote string
	// screen 非空时，中间栏显示这张票的活动快照，而不是对话。
	screen *ScreenView
	// screenFull 是屏幕模式再放大：藏起左右两栏，把整扇窗留给它在做什么。
	// 只在 screen 非空时有意义；返回对话时会一起复位。
	screenFull bool
	// selectedBot 是左栏点中的那位。点它既是选人，也是回到对话主界面。
	selectedBot string
	// sidebarClosed 是左栏收起。零值 false = 默认展开，和以前一样。
	sidebarClosed bool
	// sidebarWidth / backendWidth 是三栏现在的宽度。它们只在这次运行里记着，
	// 不落盘：拖宽了下次启动回到设计稿的宽度，不比「记住上次随手一拖」差。
	sidebarWidth float32
	backendWidth float32
	// services 是 mygo 的窗口服务，后台 goroutine 靠它请求重画。
	services ui.Services
	// backendTab 是右栏「后台」那一档里当前在看哪一页：进行中 / 待你 / 已完成。
	backendTab int
	// navTab 是左栏点开的是哪一项。默认停在「后台」，所以打开窗口看到的就是那一栏。
	navTab navItem
	// backendOpen 是右栏在不在。「后台」再点一次收起来，中间的对话就占满整扇窗。
	backendOpen bool

	// chatScroll 记着消息流滚到哪了。聊天是「越新越靠下」：
	// 每次数据回来先把 Y 顶到最底，否则打开窗口看到的是最早那几条，
	// 而人关心的是刚发生的。TrackScroll 会把它夹在内容范围内，越界无害。
	chatScroll ui.ScrollState
	// chatPinned 是「跟着底部走」。用户主动往上翻看历史时置 false，
	// 新消息就不再把视图拽回底部 —— 那会让人正在读的一段被抢走。
	chatPinned bool

	// models 是能切成什么。没读过就是 nil，界面上说「正在读」而不是「没有」。
	models      *ModelCatalog
	modelsError string
	modelNote   string

	workSteps []WorkStep
	// workError 是这次读经过失败的实话。和 problem 分开：一条票读不出来
	// 不该让整个界面顶部挂一条红横幅。
	workError string

	// 撤回排队消息。withdrawing 是正在撤的那几个请求号，防止连点发两次；
	// withdrawError 只写在排队那一块，不能冒充连接故障。
	withdrawing   map[string]bool
	withdrawError string
	withdrawn     chan withdrawResult

	// 点选「等你决定」卡上的选项。answers 是正在发的「票号|选项 id」，防止连点；
	// answerNote 只说成没成，不冒充断连横幅。answerTicket 记着这句话是哪张票的：
	// 消息流里可能同时挂着两张待决的卡，答了 A 不该在 B 上也说一句「已答」。
	// answerAsked 记着答这句话时卡上问的是哪一组（见 answerSignature）：同一张票
	// 换了个新问题，那句话就是按上一道题说的，不能挂到新问题下面。
	answers      map[string]bool
	answerNote   string
	answerTicket string
	answerAsked  string
	answered     chan answerResult

	// 插队：把排队中的一句直接交给正在跑的 worker。
	steering  map[string]bool
	steerNote string
	steerDone chan steerResult

	// 代码卡上的两个按钮。adopting 是正在「采用」的那几张卡（键是 CodeBlock.ID），挡连点；
	// adoptNotes 只写这张卡自己的结果，不冒充断连横幅 —— 采用了什么、没采用成什么，
	// 都只关系到这一段改动。adoptedOK 记着哪几张已经采用过，按钮据此换成「已采用」。
	// previewNote 是「看看改完的样子」在标题栏说的那句实话。
	adopting    map[string]bool
	adoptNotes  map[string]string
	adoptedOK   map[string]bool
	previewNote string
	adopted     chan adoptResult
	previewed   chan previewResult

	// 全部暂停：pausing 挡住连点，pauseNote 只说暂停这件事的结果，不冒充断连。
	pausing   bool
	pauseNote string
	pauseDone chan pauseResult

	// crewLoad 是执行器的槽位情况：排队几条、上限几张并发。
	// 它挂在管理面上，读不到就是 nil —— 界面据此不画「上限 N 并发」那一行，
	// 而不是写死一个 3。
	crewLoad   *CrewLoad
	crewLoadCh chan *CrewLoad

	// 已配对的设备：配对一次之后谁还能进来的清单。读不到就空着，不挡住别的。
	devices      []PairedDevice
	devicesNote  string
	devicesTried bool
	devicesCh    chan devicesResult
	revoking     map[string]bool

	// 导出备份：exporting 挡住连点，exportNote 说清存到哪了（或为什么没成）。
	exporting  bool
	exportNote string
	exportCh   chan exportResult

	// 改人设：editingBot 是打开的那一位的 bot_id（空表示没开）。
	// botForm 是编辑层里的草稿；botSaving 挡住连点，botError 只写在编辑层里。
	editingBot string
	botName    string
	botPersona string
	botSaving  bool
	botError   string
	botSaved   chan botSaveResult

	// 产出：右栏「产出」那一栏，以及消息下面那条结果条，都读同一份。
	// outputs 是整栏（最近几张票），perTicket 是按票的（结果条用）；
	// 两份分开存，结果条不该因为整栏没刷新就对不上。
	// 读不到时 outputsNote 是那句实话，不冒充「没有产出」。
	outputs     *OutputsView
	outputsNote string
	outputsCh   chan outputsResult
	// loadingOutputs 挡住连点「产出」时叠出来的几个请求。
	loadingOutputs bool
	// perTicket 的键是票号；值是 nil 表示「读过了、读不到」，据此不再每帧重发请求。
	perTicket map[string]*OutputsView
	// loadingTicket 挡住在途的重复请求：同一张票一次只发一个。
	loadingTicket map[string]bool
	ticketOut     chan ticketOutputsResult

	// 常规任务：右栏那一栏的账本（契约 §5.5）。
	// routines 为 nil 表示还没读回来；读不到时 routinesNote 是那句实话，
	// 不冒充「还没有常规任务」—— 这两句话差着一整个事实。
	routines       *RoutinesView
	routinesNote   string
	routinesCh     chan routinesResult
	loadingRoutine bool

	// 记忆：右栏那一栏的长期账本（契约 §5.7）。memory 为 nil 表示还没读回来；
	// 读不到时 memoryNote 是那句实话，不冒充「还没有记住什么」。
	memory        *MemoryView
	memoryNote    string
	memoryCh      chan memoryResult
	loadingMemory bool
}

// routinesResult 是一次读「常规任务」的结果。view 为 nil 时 note 说的是为什么读不到。
type routinesResult struct {
	view *RoutinesView
	note string
}

// memoryResult 是一次读「记忆」整栏的结果。view 为 nil 时 note 说的是为什么读不到。
type memoryResult struct {
	view *MemoryView
	note string
}

// outputsResult 是一次读「产出」整栏的结果。view 为 nil 时 note 说的是为什么读不到。
type outputsResult struct {
	view *OutputsView
	note string
}

// ticketOutputsResult 是读某一张票产出的结果；票号带回来才知道是哪条消息的结果条。
// 读不到时 view 为 nil —— 结果条据此什么都不画，也不报错。
type ticketOutputsResult struct {
	ticket string
	view   *OutputsView
}

// exportResult 是一次导出备份的结果：成功时带回写出去的路径。
type exportResult struct {
	path string
	err  error
}

// devicesResult 是一次读设备清单的结果；revoke 的结果也走这条通道。
type devicesResult struct {
	list []PairedDevice
	err  error
}

// botSaveResult 是一次改人设的结果。id 带回来才知道关的是哪一层。
type botSaveResult struct {
	id  string
	err error
}

// modelSwitchResult 带回换模型的结果和作用域：没有 botID 就是全场默认。
type modelSwitchResult struct {
	choice ModelChoice
	botID  string
}

// steerResult 是一次插队的结果；请求号带回来才知道是哪一条回来了。
type steerResult struct {
	requestID string
	err       error
}

// adoptResult 是一次「采用」的结果。key 是代码卡的 ID，带回来才知道该松开哪张卡上的按钮、
// 把回执写在哪张卡下面：同一段对话里可能并排挂着两张代码卡。
type adoptResult struct {
	key string
	err error
}

// previewResult 是一次「看看改完的样子」的结果。view 为 nil 时 reason 说的是为什么看不了 ——
// 那是这件功能的实话，不是连接故障，不能写进 s.problem。
type previewResult struct {
	key    string
	ticket string
	view   *ScreenView
	reason string
}

// pauseResult 是一次「全部暂停」的结果。
type pauseResult struct {
	err error
}

// withdrawResult 是一次撤回的结果。请求号带回来，才知道该从 withdrawing 里删哪一条。
type withdrawResult struct {
	requestID string
	err       error
}

// answerResult 是一次点选选项的结果。key 是「票号|选项 id」，带回来才知道该松开哪个按钮；
// ticket 带回来，那句话只写在它自己那张卡上；asked 是答这句话时卡上问的是哪一组，
// 结果回来时票上的问题已经变了，这句话就不该再显示。
type answerResult struct {
	key    string
	ticket string
	asked  string
	err    error
}

// workResult 是哪张票的过程。没有票号就没法判断这份结果还该不该显示。
type workResult struct {
	ticket string
	steps  []WorkStep
	err    error
}

// 三栏宽度的边界。左/右栏各有一个上下限，中栏永远吃剩下的宽度。
// 数字不是设计稿上的：设计稿只给了 329 / 393 两个落点，范围是给拖拽留的余量。
const (
	sidebarMinWidth = 220.0
	sidebarMaxWidth = 420.0
	backendMinWidth = 300.0
	backendMaxWidth = 520.0
	// middleMinWidth 是中间对话栏尽量保留的宽度。窗口太窄时先压两边的栏。
	middleMinWidth = 260.0
	// railWidth 是收起后那条窄边的宽度，和 roster/backendPane 里写的一致。
	railWidth = 30.0
	// splitLine 是 ui.Split 画的那条 1px 分隔线。
	splitLine = 1.0
	// splitFloor 是 ui.Split 自己允许的最小 pane（主题 Space(10) = 40）。
	splitFloor = 40.0

	// queuedPreviewCount 是最多列几条排队消息；queuedPreviewRunes 是一条摘要最多几个字。
	queuedPreviewCount = 3
	queuedPreviewRunes = 28
)

// wake 让窗口尽快画下一帧。后台 goroutine 把一个结果放进通道之后必须调用：
// 不调的话通道里的结果要等到用户碰一下窗口才被 drain 收走，界面就停在「正在读…」。
func (s *app) wake() { s.services.Invalidate() }

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
			s.wake()
			return
		}
		// 树跟着第一次刷新一起读。读失败不算错：对话照样能用，只是这一栏空着。
		if len(conversation.Tasks) > 0 {
			if tree, treeErr := s.client.Agents(ctx, conversation.Tasks[0].ID); treeErr == nil {
				s.tree <- tree
			}
		}
		// 槽位情况也顺手读一次：它在管理面上，读不到就留 nil，底部那一行就不画。
		// 不影响对话 —— 一个数读不到，不该让整段对话报错。
		if load, loadErr := s.client.CrewLoad(ctx); loadErr == nil {
			s.crewLoadCh <- load
		}
		s.arrived <- conversation
		s.wake()
	}()
}

func (s *app) send() {
	text := s.input
	// 连不上就别发：发出去也到不了，还让人以为发了。空消息同理。
	if text == "" || s.sending || s.problem != "" {
		return
	}
	s.sending = true
	go func() {
		defer func() { s.sending = false }()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := s.client.Send(ctx, text, mentionsIn(text, s.conversation)); err != nil {
			s.failed <- err.Error()
			s.wake()
			return
		}
		s.sent <- text   // 主线程确认这句真的发出去了，再清输入框
		s.arrived <- nil // 只用来触发一次重读，让刚发的话尽快出现
		s.wake()
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
			if len(needle) <= 1 {
				continue
			}
			// 必须命中到词的边界：队里有 a 和 ab 时，@ab 不能同时点名 a。
			for offset := 0; ; {
				index := strings.Index(text[offset:], needle)
				if index < 0 {
					break
				}
				start := offset + index
				if !continuesName(text[start+len(needle):]) {
					found = append(found, bot.ID)
					break
				}
				offset = start + 1
			}
			if len(found) > 0 && found[len(found)-1] == bot.ID {
				break
			}
		}
	}
	return found
}

// continuesName 判断 @ 后面的这个位置是否还在同一个名字里。是的话，刚才那次命中是前缀，不算。
func continuesName(rest string) bool {
	for _, r := range rest {
		return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-'
	}
	return false
}

func (s *app) view(c *ui.Context) {
	// 后台 goroutine 靠这个句柄请求下一帧；只拿到 view 里不行，它们不在 UI 线程上。
	s.services = c.Services()
	s.drain(c)
	p := ThemeColors(c.Theme())
	// 先把宽度按当前窗口尺寸收进有效范围，再建分隔条：窗口缩过之后，
	// 上次拖出来的宽度不能把中间那栏挤成负数。
	s.fitPaneWidths(c)
	// 根容器必须自己上底色：不上就是 mygo 的默认深色，亮色主题下顶上会漏出一条黑边。
	ui.Row(c).Fill().FillWidth().FillHeight().Gap(0).Background(p.Surface).Children(func() {
		// 全屏看屏幕时只剩中间这一栏：左右两栏收掉，画面拿到整扇窗。
		if s.screenFull && s.screen != nil {
			s.conversationPane(c, p)
			return
		}
		s.panes(c, p)
		// ui.Split 在构建时才把这一帧的拖拽写回宽度；再收一次，
		// 免得下一帧拿着越界的值去排版。
		s.fitPaneWidths(c)
		if s.editingBot != "" {
			s.botEditor(c, p)
		}
	})
}

// panes 是三栏本身。展开的栏之间用 ui.Split 隔开：它自带一条 1px 的线，
// 外面覆着 6px 的拖拽手柄（主题 Space(1.5)），指针是左右调整光标。
// 收起的一侧只留 railWidth 那条窄边，不参与拖拽。
func (s *app) panes(c *ui.Context, p Palette) {
	if s.sidebarClosed {
		s.roster(c, p)
		s.centerAndBackend(c, p)
		return
	}
	ui.Split(c, &s.sidebarWidth,
		func() { s.roster(c, p) },
		func() { s.centerAndBackend(c, p) },
	).Grow(1).FillHeight().SplitReset(SidebarWidth)
}

// centerAndBackend 是「中栏 + 右栏」。右栏要定宽、中栏吃剩余，
// 所以把右栏当成 Split 的第一栏，并把方向反过来（第一栏落在右侧）。
func (s *app) centerAndBackend(c *ui.Context, p Palette) {
	if !s.backendOpen {
		// 收起时两块仍然是同一条横排：不包一层 Row，中间那栏会按内容高度塌下去，
		// 输入框跑到标题下面，下方留一大片空。
		ui.Row(c).Grow(1).FillHeight().Direction(ui.LeftToRight).Children(func() {
			s.conversationPane(c, p)
			s.backendPane(c, p)
		})
		return
	}
	// 方向要在建子元素之前给：ui.Split 的拖拽方向在构建时读一次，
	// 建完再 Direction 只会把布局翻过来，拖拽仍按从左到右算（实测会拖反）。
	ui.Row(c).Direction(ui.RightToLeft).Grow(1).FillHeight().Children(func() {
		ui.Split(c, &s.backendWidth,
			func() { s.backendPane(c, p) },
			func() { s.conversationPane(c, p) },
		).Grow(1).FillHeight().SplitReset(BackendWidth)
	})
}

// fitPaneWidths 把两栏宽度夹回各自的范围，并保证两边加起来给中栏留下足够的宽度。
func (s *app) fitPaneWidths(c *ui.Context) {
	width, _ := c.Size()
	if s.sidebarWidth <= 0 {
		s.sidebarWidth = SidebarWidth
	}
	if s.backendWidth <= 0 {
		s.backendWidth = BackendWidth
	}
	if width <= 0 {
		return
	}
	// 两条分隔线都要占位；可用宽度是窗口减去它们和中栏想保住的那一份。
	available := width - middleMinWidth - 2*splitLine
	// 右栏先按最小值预留，左栏定下来之后右栏再按左栏的实际宽度算。
	// 两边都用同一个 available，不会出现「各自都以为自己放得下」而把中栏挤没。
	rightReserve := float32(backendMinWidth)
	if !s.backendOpen {
		rightReserve = railWidth
	}
	s.sidebarWidth = fitPane(s.sidebarWidth, sidebarMinWidth, sidebarMaxWidth, available-rightReserve)
	leftReserve := s.sidebarWidth
	if s.sidebarClosed {
		leftReserve = railWidth
	}
	s.backendWidth = fitPane(s.backendWidth, backendMinWidth, backendMaxWidth, available-leftReserve)
}

// fitPane 在放得下时把 v 夹在 [lo, hi]；窗口窄到连下限都放不下时，
// 先把中栏保住，把这一栏让到还剩多少就多宽（但不小于 ui.Split 的 40）。
func fitPane(v, lo, hi, room float32) float32 {
	if room < splitFloor {
		room = splitFloor
	}
	if hi > room {
		hi = room
	}
	if hi < lo {
		return room
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// drain 把后台线程交回来的结果收进状态。
//
// 每帧调用一次，把**已经到达**的结果全收掉就返回。它不能一直等：
// 它是从 view() 里调的，一帧里卡住就等于整个界面冻住。
func (s *app) drain(c *ui.Context) {
	for {
		select {
		case conversation := <-s.arrived:
			if conversation != nil {
				before := 0
				if s.conversation != nil {
					before = len(s.conversation.Messages)
				}
				s.conversation, s.problem = conversation, ""
				// 答完之后这张票可能已经换了一组新问题：刚才那句回执是按上一道题说的，
				// 不能跟到新问题下面（「已按这个答了」短暂出现在新问题卡上，就是它）。
				if s.answerNote != "" && !s.answerIsCurrent() {
					s.answerNote = ""
				}
				// 聊天是「越新越靠下」：第一次读到时直接落到最底，之后只有
				// 用户本来就在底部（没往上翻）才跟着新消息走。往上翻着读历史
				// 时把视图拽回底部，等于把人正在看的一段抢走。
				switch {
				case before == 0:
					s.chatPinned = true
					s.chatScroll.Y = math.MaxFloat32
				case len(conversation.Messages) > before && s.chatPinned:
					s.chatScroll.Y = math.MaxFloat32
				}
				// 时间线变了，产出也可能变了（worker 刚写完一个文件）。按票缓存的结果条
				// 与整栏都重读一遍；不清掉就会一直停在上一次。
				s.perTicket = map[string]*OutputsView{}
				if s.navTab == navOutput {
					s.loadOutputs()
				}
				if s.navTab == navRoutine {
					s.loadRoutines()
				}
				if s.navTab == navMemory {
					s.loadMemory()
				}
				// 数据是后台线程送回来的：不主动要一帧，界面会停在「正在读对话」。
				c.Invalidate()
			}
		case tree := <-s.tree:
			s.agents = tree
			c.Invalidate()
		case message := <-s.pairFailed:
			// 配对失败写在配对那一块，不冒充连接故障。
			s.pairingNote = "配对没成功：" + message
			c.Invalidate()
		case credential := <-s.paired:
			// 配对成功：先把凭据落到本机，再换上新的 client。存不下来也要说清楚 ——
			// 这一次能连、下次启动又要重配，是两件不同的事。
			if err := saveCredential(credentialPath(), credential); err != nil {
				s.pairingNote = "配上了，但凭据存不下来：" + err.Error()
			} else {
				s.pairingNote = "已配对，下次启动免配置直连"
			}
			s.client = New(credential.Base, credential.Token, credential.DeviceID)
			// 横幅要跟着换：连的是新地址了，再失败时不能还报旧的那个。
			s.endpoint = credential.Base
			s.problem = ""
			c.Invalidate()
			s.refresh()
		case result := <-s.steps:
			// 只有回来的正是当前打开的那张票才显示，否则写的是别人的经过。
			if result.ticket != s.openTicket {
				continue
			}
			if result.err != nil {
				s.workError = result.err.Error()
				c.Invalidate()
				continue
			}
			s.workSteps, s.workError = result.steps, ""
			c.Invalidate()
		case catalog := <-s.modelList:
			s.models, s.modelsError, s.modelNote = catalog, "", ""
			s.loadEfforts()
			c.Invalidate()
		case load := <-s.crewLoadCh:
			// 槽位情况回来了：底部「队列 · 上限 N 并发」那一行据此画。
			s.crewLoad = load
			c.Invalidate()
		case view := <-s.effortsCh:
			s.efforts = view
			c.Invalidate()
		case message := <-s.modelError:
			s.modelsError, s.modelNote = message, ""
			c.Invalidate()
		case message := <-s.retryErrorCh:
			s.retryError = message
			c.Invalidate()
		case note := <-s.screenNoteCh:
			s.screenNote = note
			c.Invalidate()
		case result := <-s.exportCh:
			s.exporting = false
			if result.err != nil {
				s.exportNote = "没导出成功：" + result.err.Error()
			} else {
				s.exportNote = "已备份到 " + result.path
			}
			c.Invalidate()
		case result := <-s.devicesCh:
			s.devicesTried = true
			s.revoking = map[string]bool{}
			if result.err != nil {
				s.devicesNote = "读不到已配对的设备：" + result.err.Error()
			} else {
				s.devices = result.list
				s.devicesNote = ""
			}
			c.Invalidate()
		case result := <-s.botSaved:
			s.botSaving = false
			if result.err != nil {
				s.botError = result.err.Error()
			} else {
				// 存住了才关层：否则人会以为改了却没生效。
				s.editingBot = ""
				s.botError = ""
				go s.refresh()
			}
			c.Invalidate()
		case result := <-s.pauseDone:
			s.pausing = false
			if result.err != nil {
				s.pauseNote = "没停下来：" + result.err.Error()
			} else {
				s.pauseNote = "已让它停一下（全局执行器，恢复要去面板）"
				go s.refresh()
			}
			c.Invalidate()
		case result := <-s.steerDone:
			delete(s.steering, result.requestID)
			if result.err != nil {
				s.steerNote = "插队没成功：" + result.err.Error()
				if errors.Is(result.err, ErrSteerTooLate) {
					go s.refresh()
				}
			} else {
				s.steerNote = "已插话，队伍做完当前这一步会先处理这句"
				go s.refresh()
			}
			c.Invalidate()
		case view := <-s.screenCh:
			s.screen = view
			s.screenNote = ""
			c.Invalidate()
		case result := <-s.modelSwitched:
			// 换成了：目录里记下新的这一个，左栏和右栏都跟着改，不用等人再点一次刷新。
			s.applyModel(result)
			c.Invalidate()
		case text := <-s.sent:
			// 只清掉「刚发出去的那一句」；用户在这期间又打了字就留着。
			if s.input == text {
				s.input = ""
			}
			c.Invalidate()
		case result := <-s.answered:
			// 发出去就重读一次：问题被答掉之后，这张卡要么换成新的一组选项，要么整张消失。
			delete(s.answers, result.key)
			s.answerTicket, s.answerAsked = result.ticket, result.asked
			if result.err != nil {
				s.answerNote = "没答上：" + result.err.Error()
			} else {
				// 只在这道题还在等、还是同一组时才说「已答」：结果回来时若已经
				// 刷新成了新问题（或者这张票走了），那句话说的就是上一道题，收起来。
				s.answerNote = ""
				if s.answerIsCurrent() {
					s.answerNote = "已按这个答了，队伍下一步会接上"
				}
				go s.refresh()
			}
			c.Invalidate()
		case result := <-s.withdrawn:
			delete(s.withdrawing, result.requestID)
			if result.err != nil {
				// 撤回失败只写在排队那一块：其他消息照样能发，不该挂断连横幅。
				// 409 多半是队伍已经答过/读走了：重读一次时间线，排队那条才不会一直挂着。
				s.withdrawError = result.err.Error()
				if errors.Is(result.err, ErrWithdrawalTooLate) {
					go s.refresh()
				}
				c.Invalidate()
				continue
			}
			s.withdrawError = ""
			c.Invalidate()
			// 撤掉了就重读一次，让那条从队列里消失；重读本身失败会走 failed，
			// 那时才轮到全局横幅说话。
			s.refresh()
		case result := <-s.adopted:
			// 一张卡只有它自己那行回执：并排两张代码卡时，A 的结果不该写到 B 上。
			delete(s.adopting, result.key)
			if s.adoptNotes == nil {
				s.adoptNotes = map[string]string{}
			}
			if s.adoptedOK == nil {
				s.adoptedOK = map[string]bool{}
			}
			if result.err != nil {
				s.adoptNotes[result.key] = "没采用成：" + result.err.Error()
			} else {
				s.adoptedOK[result.key] = true
				s.adoptNotes[result.key] = "已请它采用这段改动，下一步会按这个改"
				go s.refresh()
			}
			c.Invalidate()
		case result := <-s.previewed:
			if result.view != nil {
				// 有具体的活动快照就换中间栏：它和「看它的屏幕」是同一块画面。
				s.screen, s.screenNote, s.previewNote = result.view, "", ""
			} else {
				// 没有就说清楚为什么没有。这句话写在标题栏，不挂断连横幅。
				s.previewNote = result.reason
			}
			c.Invalidate()
		case result := <-s.outputsCh:
			s.loadingOutputs = false
			s.outputs, s.outputsNote = result.view, result.note
			c.Invalidate()
		case result := <-s.routinesCh:
			s.loadingRoutine = false
			s.routines, s.routinesNote = result.view, result.note
			c.Invalidate()
		case result := <-s.memoryCh:
			s.loadingMemory = false
			s.memory, s.memoryNote = result.view, result.note
			c.Invalidate()
		case result := <-s.ticketOut:
			delete(s.loadingTicket, result.ticket)
			if s.perTicket == nil {
				s.perTicket = map[string]*OutputsView{}
			}
			// 读不到也记一笔（值是 nil），否则每一帧都会重发一次请求。
			// 结果条据此不画：把「读不到」画成一条成果是最糟的一种假。
			s.perTicket[result.ticket] = result.view
			c.Invalidate()
		case message := <-s.failed:
			s.problem = message
			s.sending = false
			c.Invalidate()
		default:
			// 没有更多结果了：让这一帧画完，下一帧再收。
			// 这里不能阻塞 —— 它是从 view() 里调的。
			return
		}
	}
}

// roster 是左栏：谁在这个队伍里，他此刻在干什么。
func (s *app) roster(c *ui.Context, p Palette) {
	if s.sidebarClosed {
		// 左栏收起后留一条窄边，点它展开。中间的对话会自己长满。
		ui.Row(c).Width(30).FillHeight().Background(p.Card).Cursor(ui.CursorPointer).
			AlignItems(ui.Center).OnClick(func() { s.sidebarClosed = false }).Children(func() {
			ui.Column(c).Gap(4).Children(func() {
				ui.Text(c, "»").FontSize(FontBodyWide).TextColor(p.Faint)
				ui.Text(c, "队").FontSize(FontTiny).TextColor(p.Faint)
				ui.Text(c, "伍").FontSize(FontTiny).TextColor(p.Faint)
			})
		})
		return
	}
	// 只给 Width，不给 FillWidth：两个一起写是互相打架的（一个说「父容器多宽我多宽」），
	// 定宽栏要的是 Width 这一条。
	// Split 自带的 Divider 只是一条可拖的空盒子，不上色；画板里的 1px 边线得自己画。
	// 左栏在右缘画，右栏在左缘画，这样收起/展开两端边界都一样清楚。
	ui.Row(c).Width(s.sidebarWidth).FillHeight().Gap(0).Children(func() {
		ui.Column(c).Grow(1).FillHeight().PaddingX(14).PaddingY(22).Gap(18).Background(p.Card).Children(func() {
			// 标题行：图标 + 名字 + 收起。
			ui.Row(c).FillWidth().AlignItems(ui.Center).PaddingX(8).Gap(9).Children(func() {
				ui.Text(c, "◎").FontSize(FontRosterIcon).TextColor(p.Ink)
				// 标题与两个按钮抢一行：栏拖窄时标题先省略，按钮不能再被挤出去。
				ui.Text(c, "我的队伍").FontSize(FontDisplay).FontWeight(WeightTitle).LetterSpacing(-0.15).
					TextColor(p.Ink).MaxLines(1).Ellipsis("…")
				ui.Row(c).Grow(1)
				// 标题栏的「+」是加一位 Bot 的入口，和「«」并排：28×28，细边框。
				ui.Row(c).Width(28).Height(28).Radius(RadiusButton).BorderWidth(1).BorderColor(p.Line).
					AlignItems(ui.Center).Justify(ui.Center).Cursor(ui.CursorPointer).
					OnClick(func() { s.navTab = navModel }).Children(func() {
					ui.Text(c, "+").FontSize(FontBodyWide).TextColor(p.Faint)
				})
				// 一个「«」字太小，不好点：给它一圈 padding，点击挂在整块上。
				ui.Row(c).Padding(6).Radius(RadiusButton).Background(p.Card).Cursor(ui.CursorPointer).
					OnClick(func() { s.sidebarClosed = true }).Children(func() {
					ui.Text(c, "«").FontSize(FontBodyWide).TextColor(p.Faint)
				})
			})

			ui.Column(c).FillWidth().Gap(2).Children(func() {
				if s.conversation == nil || len(s.conversation.Bots) == 0 {
					ui.Column(c).FillWidth().Gap(12).Padding(11).Children(func() {
						// 画板这里是 52×52 虚线圈、圆角 16；圆角 20 那个是中栏的 64×64 空态，别混用。
						ui.Column(c).Width(52).Height(52).Radius(RadiusFolderSml).
							BorderWidth(1).BorderColor(p.EmptyEdge).Background(p.Surface).
							AlignItems(ui.Center).PaddingY(9).Children(func() {
							ui.Text(c, "+").FontSize(FontGlyph).TextColor(p.EmptyGlyph)
						})
						ui.Text(c, "队伍还是空的。").FontSize(FontBody).TextColor(p.Muted)
						ui.Text(c, "加一位 Bot，他从今天起会记住\n你们的每一次对话。").
							FontSize(FontBody).TextColor(p.Faint)
						ui.Row(c).PaddingX(12).PaddingY(7).Radius(RadiusButton).Background(p.Accent).
							Cursor(ui.CursorPointer).Children(func() {
							ui.Text(c, "加第一位").FontSize(FontBodyWide).TextColor(p.AccentInk)
						}).OnClick(func() { s.navTab = navModel })
					})
					return
				}
				for i, bot := range s.conversation.Bots {
					bot := bot
					// 选中态用底色分层，不加边框：设计稿靠色块而不是线。
					selected := s.selectedBot == bot.ID || (s.selectedBot == "" && i == 0)
					item := ui.Row(c).FillWidth().Gap(11).AlignItems(ui.Start).Padding(11).Radius(RadiusPane).
						Cursor(ui.CursorPointer)
					if selected {
						item = item.Background(p.SelectedAlt)
					}
					// 点人 = 选他 + 回到对话主界面。右栏收起，中间那栏自己长满。
					// 之前这一行没有点击，点了没反应，看起来像「回不到主界面」。
					item = item.OnClick(func() {
						s.selectedBot = bot.ID
						s.backendOpen = false
					})
					item.Children(func() {
						// 36px 头像块，圆角 11：取名字首字。选中的实心强调色，其余淡底 ——
						// 画板用实心/淡底区分「他在这」和「他在名单里」。
						soft, tint := p.AccentSoft2, p.Accent
						if selected {
							soft, tint = p.Accent, p.AccentInk
						} else if isWarnBot(bot.ID) {
							soft, tint = p.WarnSoft2, p.Warn
						}
						ui.Column(c).Width(AvatarSmall).Height(AvatarSmall).Radius(RadiusPane).Background(soft).
							AlignItems(ui.Center).PaddingY(8).Children(func() {
							ui.Text(c, firstRune(bot.Name)).FontSize(FontHeader).FontWeight(WeightFigure).TextColor(tint)
						})
						// MinWidth(0)：栏拖窄时这一列跟着缩，名字保留、人设先省略，
						// 而不是把两段字一起推到栏外被硬裁（那看起来就是「没自适应」）。
						ui.Column(c).Grow(1).MinWidth(0).Gap(2).Children(func() {
							ui.Row(c).FillWidth().Gap(6).AlignItems(ui.Baseline).Children(func() {
								ui.Text(c, strings.TrimSpace(bot.Name)).FontSize(FontName).FontWeight(WeightName).
									LineHeight(1.25).TextColor(p.Ink).NoWrap()
								ui.Row(c).Grow(1).MinWidth(0).ClipX().Children(func() {
									if bot.Persona != "" {
										// 职能跟名字同一行，弱一档：它是「他是什么人」，不是状态。
										ui.Text(c, clipRunes(bot.Persona, 12)).FontSize(FontHairline).
											LineHeight(1.25).TextColor(p.Faint).NoWrap().Ellipsis("…")
									}
								})
							})
							// 状态行：一个 5px 圆点 + 一句话。点用颜色表态，比纯文字快。
							ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
								// 5px 的圆点：用方块别用字形 —— 字形的点跟字号走，大小不受控。
								ui.Column(c).Width(5).Height(5).Radius(RadiusDot).
									Background(s.stateColor(p, bot.ID))
								// 待命是弱信息：画板里它在 Faint 一档，在跑的才用 Muted。
								stateTint := p.Muted
								if s.stateColor(p, bot.ID) == p.Hint {
									stateTint = p.Faint
								}
								ui.Text(c, s.stateOf(bot.ID)).FontSize(FontBody).LineHeight(1.3).TextColor(stateTint)
							})
						})
						// 「改」：点人不该只等于「选他」。这一格把「改这一位」从只有手机能做的事
						// 补到桌面上；它在悬停时才明显，不抢花名册本身的注意力。
						bot := bot
						ui.Row(c).PaddingX(6).PaddingY(4).Radius(RadiusChip).Cursor(ui.CursorPointer).
							Children(func() {
								ui.Text(c, "改").FontSize(FontMini).TextColor(p.Faint)
							}).OnClick(func() { s.editBot(bot) })
					})
				}
			})

			// 「今天由谁接手」：一句话说清当前这轮谁在跑。
			ui.Column(c).FillWidth().Gap(7).PaddingX(8).Children(func() {
				ui.Text(c, "今天由谁接手").FontSize(FontTiny).FontWeight(WeightName).LetterSpacing(0.55).TextColor(p.Faint)
				ui.Row(c).Gap(7).AlignItems(ui.Center).Children(func() {
					ui.Text(c, "✓").FontSize(FontLabel).TextColor(p.Accent)
					ui.Text(c, s.handover()).FontSize(FontBody).TextColor(p.Ink)
				})
			})

			// 底部导航：分隔线之上。mygo 没有单边边框，用一条 1px 的线代替。
			ui.Column(c).FillWidth().Height(1).Background(p.Line)
			// 画板四行的行距是 37–39：行本身（PaddingY 9 + 13px 字）已约 36–38 高，
			// 行与行之间只隔 2，不是再加一段 10。
			ui.Column(c).FillWidth().Gap(2).PaddingY(14).Children(func() {
				for _, item := range navOrder {
					s.navRow(c, p, item)
				}
			})
		})
		ui.Column(c).Width(1).FillHeight().Background(p.Line)
	})
}

// clipRunes 把一段话截到 n 个字以内。花名册的职能是数据里的自由文本，
// 长的会顶出栏外 —— 与其让它压住别人的一列，不如截断并留一个省略号。
func clipRunes(text string, n int) string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= n {
		return string(runes)
	}
	return string(runes[:n]) + "…"
}

// firstRune 取名字的第一个字当头像个字。「林」取「林」，英文名取首字母。
func firstRune(name string) string {
	for _, r := range name {
		return string(r)
	}
	return "?"
}

// stateColor 是这位 Bot 现在的状态色：在跑是强调色，等你决定是赭，失败是红，其余是灰。
func (s *app) stateColor(p Palette, botID string) ui.Color {
	if s.conversation == nil {
		return p.Hint
	}
	for _, task := range s.conversation.Tasks {
		if task.BotID != botID {
			continue
		}
		// NeedsPerson 的值就是等待的原因（failed/blocked/…），失败优先于普通「等你」。
		switch {
		case task.NeedsPerson == "failed":
			return p.Danger
		case task.NeedsPerson != "":
			return p.Warn
		case task.Open:
			return p.Accent
		}
	}
	return p.Hint
}

// handover 一句话说清现在谁在跑、几个人在等。
func (s *app) handover() string {
	if s.conversation == nil {
		return "还在读"
	}
	running, waiting := "", 0
	for _, task := range s.conversation.Tasks {
		if !task.Open {
			continue
		}
		if task.NeedsPerson == "" {
			if running == "" {
				running = s.nameOf(task.BotID)
			}
			continue
		}
		waiting++
	}
	if running == "" {
		if waiting == 0 {
			return "都在待命"
		}
		return fmt.Sprintf("%d 张在等", waiting)
	}
	if waiting == 0 {
		return running + " 在跑"
	}
	return fmt.Sprintf("%s 在跑，%d 位在等", running, waiting)
}

// modelName 是当前在用的模型，左栏底部那一行显示它。
//
// 图省事只读时间线是错的：刚从「模型」栏里换掉的那一个，时间线还没重读，
// 左栏会继续写着旧名字。所以目录里记的那个优先。
func (s *app) modelName() string {
	if s.models != nil && s.models.Current != nil && s.models.Current.Model != "" {
		return s.models.Current.Model
	}
	if s.conversation != nil && s.conversation.Model != "" {
		return s.conversation.Model
	}
	return "默认"
}

// navRow 是左栏底部的一项。整行都能点，不只是那几个字。
//
// mygo 的指针命中只落在标了 clickable 的元素上，所以这一行自己要有 OnClick；
// 里面那些字是画出来的，不抢指针，按哪一格都算按在这一行上。
func (s *app) navRow(c *ui.Context, p Palette, item navItem) {
	glyph, text := navLabel(item)
	here := s.navTab == item && s.backendOpen
	// 选中的那一项：底色分层 + 字样提亮，和花名册选中项同一套做法，不加边框。
	tint, glyphTint := p.Muted, p.Faint
	if here {
		tint, glyphTint = p.Ink, p.Accent
	}
	// ClipX：栏拖到最窄时，右端那点说明（张数 / 当前模型）宁可被裁掉，也不能把行撑出栏外。
	row := ui.Row(c).FillWidth().MinWidth(0).ClipX().AlignItems(ui.Center).PaddingX(8).PaddingY(9).
		Radius(RadiusItem).Gap(8).Cursor(ui.CursorPointer)
	if here {
		row = row.Background(p.SelectedAlt)
	}
	row.Children(func() {
		// 图标本身 16 宽：套一个 36 宽的空槽会把文字推到 19px 以外，和画板的两列感一样。
		ui.Row(c).Width(FontIcon).AlignItems(ui.Center).Children(func() {
			ui.Text(c, glyph).FontSize(FontIcon).TextColor(glyphTint)
		})
		ui.Text(c, text).FontSize(FontLabel).TextColor(tint)
		ui.Row(c).Grow(1)
		// 右端那一点说明：后台是未读 + 张数，模型是现在用的谁，另外两个没有。
		switch item {
		case navBackend:
			// 未读徽标（契约 §5.6）：画板手机端把同样的角标挂在「后台」上（赭底白字），
			// 桌面画板那一行右端只有张数，所以这里把它摆在张数左边 —— 同一个入口、同一种
			// 「有东西正等着你」的语义。算不出来时不画，不画成 0。
			if n, ok := s.unreadCount(); ok {
				ui.Row(c).PaddingX(6).Radius(RadiusChip).Background(p.Warn).Children(func() {
					ui.Text(c, badgeText(n)).FontSize(FontTiny).TextColor(p.WarnInk)
				})
			}
			if n := s.openCount(); n > 0 {
				ui.Row(c).PaddingX(6).Radius(RadiusChip).Background(p.AccentSoft).Children(func() {
					ui.Text(c, fmt.Sprintf("%d", n)).FontSize(FontTiny).TextColor(p.Accent)
				})
			}
		case navModel:
			ui.Text(c, s.modelName()).FontSize(FontSmall).TextColor(p.Faint).Ellipsis("…")
		}
	})
	row.OnClick(func() { s.pressNav(item) })
}

// openCount 是还没结束的工单数，左栏那个徽标用它。
func (s *app) openCount() int {
	if s.conversation == nil {
		return 0
	}
	n := 0
	for _, task := range s.conversation.Tasks {
		if task.Open {
			n++
		}
	}
	return n
}

// unreadCount 是「未读」徽标上的数，以及这个数该不该画（契约 §5.6）。
//
// 两个条件同时成立才画：这份时间线**算得出来**（后端说 live），且条数大于 0。
// 「算不出来」不是 0 —— 画一个 0 等于替网关说「都读过了」，那正是这一格不能做的事。
// 说不清时什么都不出现：宁可空着，也不造假。
func (s *app) unreadCount() (int, bool) {
	if s.conversation == nil || !s.conversation.Unread.Known() {
		return 0, false
	}
	n := s.conversation.Unread.CountOf()
	return n, n > 0
}

// badgeText 把条数压成徽标上的那点字。
//
// 两位数以上也要放得下：超过 99 说「99+」，不把行撑开 —— 徽标是个提示，不是账本。
func badgeText(n int) string {
	if n > 99 {
		return "99+"
	}
	return fmt.Sprintf("%d", n)
}

// stateOf 找这位 Bot 手上最近一张工单，用它的状态当「他在干什么」。
func (s *app) stateOf(botID string) string {
	if s.conversation != nil {
		for _, task := range s.conversation.Tasks {
			if task.BotID == botID {
				return stateWord(task.State) + " · " + task.Title
			}
		}
	}
	return "待命"
}

func stateWord(state string) string {
	switch state {
	// 进行中：后端给的是 stage（working / person / idle）。
	case "work", "working":
		return "在做"
	case "person":
		return "等你"
	case "idle":
		return "闲着"
	case "failed":
		return "失败"
	// 终态：ticket.ended.outcome 有五种。
	case "completed":
		return "已完成"
	case "merged":
		return "已合并"
	case "closed":
		return "已关闭"
	case "dropped":
		return "已放弃"
	case "stopped":
		return "已停止"
	case "done":
		return "已完成"
	default:
		return "在做"
	}
}

// conversationPane 是中间那一栏：消息、输入框、需要你拍板的卡。
func (s *app) conversationPane(c *ui.Context, p Palette) {
	// MinWidth(0)：Grow(1) 的地板默认是「内容最窄能到多少」，这一栏里有代码卡和长消息，
	// 那个值能到八九百。窗口缩窄时两侧定宽的栏就守不住了。地板给 0，缩窄由这一栏让。
	// 右栏是 RightToLeft 建的，方向会顺着继承下来；中间栏自己声明从左到右，
	// 否则标题栏、输入框、气泡两侧会整个镜像过来（按钮跑到左边，发送键在输入框左边）。
	// ClipX：中栏内容（输入框占位文案、标题栏按钮）有固有宽度，不加这一条它们会把整栏的
	// 最小宽度顶到 300+，右栏拖窄时被这一栏反向挤压 —— 看起来就是「拖了不生效、还不自适应」。
	ui.Column(c).Grow(1).MinWidth(0).FillWidth().FillHeight().Gap(0).ClipX().
		Direction(ui.LeftToRight).Background(p.Surface).Children(func() {
		if s.problem != "" {
			// 断连：一行说清现状与后果，右边给「重试」。连的是哪一支仍写出来，
			// 但不再摆成两行说教 —— 画板这里是一条能重试的横幅。
			ui.Column(c).FillWidth().Children(func() {
				// 画板：淡红底、图标与正文用更深的红（#8A4038），
				// 「重试」是主强调绿 —— 它是个能按的动作，不是又一句警告。
				ui.Row(c).FillWidth().PaddingX(28).PaddingY(9).Gap(9).
					AlignItems(ui.Center).Background(p.DangerSoft).Children(func() {
					ui.Text(c, "⚠").FontSize(FontBody).TextColor(p.Danger)
					line := "连不上队伍 —— 已经读到的消息还在，等连上了会自动续上"
					if s.endpoint != "" {
						line = "连不上 " + s.endpoint + " —— 已经读到的消息还在，等连上了会自动续上"
					}
					ui.Text(c, line).FontSize(FontBody).TextColor(p.DangerDeep)
					ui.Row(c).Grow(1)
					ui.Text(c, "重试").FontSize(FontSmall).TextColor(p.Accent).
						Cursor(ui.CursorPointer).OnClick(s.refresh)
				})
				ui.Column(c).FillWidth().Height(1).Background(p.DangerEdge)
			})
		}
		// 标题栏：头像 + 名字·职能 + 刷新。画板里是 718×75 的白色带，上下留白 18。
		ui.Row(c).FillWidth().PaddingX(28).PaddingY(18).Gap(11).AlignItems(ui.Center).
			Background(p.Card).Children(func() {
			ui.Column(c).Width(AvatarHdr).Height(AvatarHdr).Radius(RadiusPane).Background(p.Accent).
				AlignItems(ui.Center).PaddingY(9).Children(func() {
				ui.Text(c, firstRune(s.title())).FontSize(FontTitle).FontWeight(WeightFigure).TextColor(p.AccentInk)
			})
			ui.Column(c).Gap(2).Children(func() {
				ui.Text(c, s.title()).FontSize(FontHeader).FontWeight(WeightTitle).TextColor(p.Ink)
				// 状态点：在跑是强调色，其余用 Hint。点比文字更快说明「现在动没动」。
				ui.Row(c).Gap(5).AlignItems(ui.Center).Children(func() {
					dot := p.Hint
					if s.anyRunning() {
						dot = p.Accent
					}
					ui.Column(c).Width(5).Height(5).Radius(RadiusDot).Background(dot)
					ui.Text(c, s.subtitle()).FontSize(FontBody).TextColor(p.Faint)
				})
				if s.screenNote != "" {
					ui.Text(c, s.screenNote).FontSize(FontMini).TextColor(p.Faint)
				}
				// 代码卡上「看看改完的样子」没看成时，那句实话也写在这里：
				// 和「看它的屏幕」同一类说明，不是断连，不进红色横幅。
				if s.previewNote != "" {
					ui.Text(c, s.previewNote).FontSize(FontMini).TextColor(p.Faint)
				}
			})
			ui.Row(c).Grow(1)
			// 「看它的屏幕」：画板 109×31、圆角 9、白底细边。
			//
			// 画板里它是一扇窗：按下就换成这张票此刻的会话快照（命令、输出、回话）。
			// 没有记录时后端如实说原因；那是功能说明，不能写进 s.problem。
			// 指针换手、点击接线都挂在这一层 Row 上：mygo 里 Cursor 与 OnClick 都是
			// Element 上的方法，包着字的容器挂一次就够，里面那几个字不用再接一遍。
			ui.Row(c).Width(109).Height(31).Radius(RadiusButton).Background(p.Card).
				BorderWidth(1).BorderColor(p.Line).Center().Cursor(ui.CursorPointer).Children(func() {
				ui.Text(c, "▭ 看它的屏幕").FontSize(FontBodyWide).NoWrap().TextColor(p.Ink)
			}).OnClick(s.lookAtScreen)
			ui.Row(c).Width(32).Height(32).Radius(RadiusButton).Background(p.Card).
				BorderWidth(1).BorderColor(p.Line).Center().Cursor(ui.CursorPointer).Children(func() {
				ui.Text(c, "···").FontSize(FontBodyWide).TextColor(p.Faint)
			}).OnClick(s.refresh)
		})
		// 画板的 header 带一条 border-bottom。mygo 没有单边边框，用 1px 的线代替 ——
		// 少了这条，标题栏和消息区会糊成一片，暗色下尤其像「整块空的」。
		ui.Column(c).FillWidth().Height(1).Background(p.Line)
		if s.screen != nil {
			s.screenPanel(c, p)
		} else {
			s.stream(c, p)
		}
		s.composer(c, p)
	})
}

// anyRunning 是队伍里有没有还开着的票。标题栏的状态点、输入区那行说明都按它说真话。
func (s *app) anyRunning() bool {
	if s.conversation == nil {
		return false
	}
	for _, task := range s.conversation.Tasks {
		if task.Open {
			return true
		}
	}
	return false
}

// subtitle 是标题下面那行小字：谁在跑。
func (s *app) subtitle() string {
	if s.conversation == nil {
		return "正在读…"
	}
	if len(s.conversation.Bots) == 0 {
		return "队伍里还没有 Bot"
	}
	who := s.selectedBot
	if who == "" {
		who = s.conversation.DefaultBotID
	}
	return "和" + s.nameOf(who) + "说话"
}

func (s *app) title() string {
	if s.conversation != nil {
		if len(s.conversation.Messages) > 0 {
			last := s.conversation.Messages[len(s.conversation.Messages)-1]
			if last.Role == "agent" {
				return s.nameOf(last.BotID) + " 在回你"
			}
		}
		// 没有正在回话的 Bot 时写这位的名字：标题说的是「和谁」，不是「这是什么控件」。
		who := s.selectedBot
		if who == "" {
			who = s.conversation.DefaultBotID
		}
		if who != "" {
			return s.nameOf(who)
		}
	}
	return "对话"
}

// runningTicket 找一张正在跑的票：插队要交给它。
func (s *app) runningTicket() (string, bool) {
	if s.conversation == nil {
		return "", false
	}
	for _, task := range s.conversation.Tasks {
		if task.Open {
			return task.ID, true
		}
	}
	return "", false
}

// sendSteer 发送即插队：输入框里这句不进队列，直接交给正在跑的工单。
func (s *app) sendSteer(ticketID string) {
	text := s.input
	if s.client == nil || text == "" || s.sending || s.problem != "" {
		return
	}
	s.sending = true
	requestID, idErr := newRequestID()
	if idErr != nil {
		s.modelError <- "插队没成功：" + idErr.Error()
		return
	}
	go func() {
		defer func() { s.sending = false }()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := s.client.SteerText(ctx, ticketID, requestID, text); err != nil {
			s.modelError <- "插队没成功：" + err.Error()
			s.wake()
			return
		}
		s.sent <- text
		s.steerNote = "已插话，队伍做完当前这一步会先处理这句"
		s.wake()
		s.refresh()
	}()
}

// steer 把一条排队消息交给正在跑的 worker。
func (s *app) steer(requestID, ticketID string) {
	if s.client == nil || s.steering[requestID] {
		return
	}
	if s.steering == nil {
		s.steering = map[string]bool{}
	}
	s.steering[requestID] = true
	s.steerNote = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		s.steerDone <- steerResult{requestID: requestID, err: s.client.Steer(ctx, ticketID, requestID)}
		s.wake()
	}()
}

// lookAtScreen 读这张票此刻在做什么。有快照就换中间栏；没有就说清楚为什么没有。
func (s *app) lookAtScreen() {
	if s.client == nil {
		return
	}
	ticketID := ""
	if s.conversation != nil && len(s.conversation.Tasks) > 0 {
		ticketID = s.conversation.Tasks[0].ID
	}
	if ticketID == "" {
		// 手上没有票就没有可看的过程。这句话是界面状态，不是接口错误。
		s.screenNote = "现在没有在跑的工单，等它接活后这里会显示它在做什么"
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		view, err := s.client.Screen(ctx, ticketID)
		switch {
		case err != nil:
			s.screenNoteCh <- "读不到屏幕：" + err.Error()
		case view.State == "live" && len(view.Lines) > 0:
			s.screenCh <- view
		case view.Reason != "":
			s.screenNoteCh <- view.Reason
		default:
			s.screenNoteCh <- "这张工单暂时没有可显示的活动"
		}
		s.wake()
	}()
}

// screenPanel 是「看它的屏幕」的画面：它刚跑了什么、输出了什么、说了什么。
// 不是像素截帧 —— worker 干的是终端活，这里显示的是那件事本身。
func (s *app) screenPanel(c *ui.Context, p Palette) {
	view := s.screen
	ui.Column(c).Grow(1).FillWidth().MinWidth(0).Background(p.Surface).Children(func() {
		ui.Row(c).FillWidth().PaddingX(ContentInset).PaddingY(10).Gap(10).AlignItems(ui.Center).Children(func() {
			ui.Column(c).Gap(2).Children(func() {
				ui.Text(c, "它在做什么").FontSize(FontBodyWide).FontWeight(WeightName).TextColor(p.Ink)
				where := view.Cwd
				if where == "" {
					where = "执行记录"
				}
				ui.Text(c, where).FontSize(FontMini).TextColor(p.Faint)
			})
			ui.Row(c).Grow(1)
			ui.Row(c).PaddingX(9).PaddingY(5).Radius(RadiusButton).Background(p.Card).
				BorderWidth(1).BorderColor(p.Line).Cursor(ui.CursorPointer).Children(func() {
				ui.Text(c, "刷新").FontSize(FontMini).TextColor(p.Muted)
			}).OnClick(s.lookAtScreen)
			// 全屏：左右两栏收掉，画面占满窗口；再点一次放回来。
			ui.Row(c).PaddingX(9).PaddingY(5).Radius(RadiusButton).Background(p.Card).
				BorderWidth(1).BorderColor(p.Line).Cursor(ui.CursorPointer).Children(func() {
				label := "全屏"
				if s.screenFull {
					label = "退出全屏"
				}
				ui.Text(c, label).FontSize(FontMini).TextColor(p.Muted)
			}).OnClick(func() { s.screenFull = !s.screenFull })
			ui.Row(c).PaddingX(9).PaddingY(5).Radius(RadiusButton).Background(p.Card).
				BorderWidth(1).BorderColor(p.Line).Cursor(ui.CursorPointer).Children(func() {
				ui.Text(c, "返回对话").FontSize(FontMini).TextColor(p.Muted)
			}).OnClick(func() { s.screen = nil; s.screenFull = false })
		})
		ui.Column(c).FillWidth().Height(1).Background(p.Line)
		ui.Scroll(c).Grow(1).FillWidth().Children(func() {
			ui.Column(c).PaddingX(ContentInset).PaddingY(10).Gap(4).Children(func() {
				for _, line := range view.Lines {
					kindColor := p.Ink
					switch line.Kind {
					case "command":
						kindColor = p.Accent
					case "said":
						kindColor = p.Muted
					case "status":
						kindColor = p.Faint
					}
					ui.Text(c, screenTime(line.At)+"  "+line.Text).FontSize(FontMini).TextColor(kindColor)
				}
			})
		})
	})
}

// screenTime 把事件时间缩成 时:分:秒；读不出来就原样留着，不编时间。
func screenTime(at string) string {
	when, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return at
	}
	return when.Local().Format("15:04:05")
}

func (s *app) stream(c *ui.Context, p Palette) {
	switch {
	case s.conversation == nil:
		// Grow(1)：空态/加载态也要占住剩余高度，否则输入框会贴在标题下面，
		// 下面留一大片空白 —— 看起来像布局坏了。
		ui.Column(c).Grow(1).FillWidth().PaddingX(ContentInset).PaddingY(16).
			Children(func() { ui.Text(c, "正在读对话…").FontSize(FontBody).TextColor(p.Faint) })
	case len(s.conversation.Messages) == 0:
		// 空态居中：画板里它落在消息区正中，不是贴着标题栏左上角。
		ui.Column(c).Grow(1).FillWidth().Center().Gap(10).PaddingX(ContentInset).Children(func() {
			ui.Column(c).Width(64).Height(64).Radius(RadiusFolder).BorderWidth(1).
				BorderColor(p.EmptyEdge).AlignItems(ui.Center).Justify(ui.Center).Children(func() {
				ui.Text(c, "···").FontSize(FontEmptyIcon).TextColor(p.EmptyGlyph)
			})
			ui.Text(c, "还没有人说话").FontSize(FontTitle).FontWeight(WeightName).TextColor(p.Muted)
			ui.Text(c, "在下面写一句，他就会记得。").FontSize(FontLabel).TextColor(p.Hint)
			// 第一次打开的人不知道该干什么。三句话说清「这是什么、怎么开始、它会记住」，
			// 而不是让他对着一片空白猜。这不是教程，是入口本身：每句都对应界面上真有的东西。
			ui.Column(c).Gap(6).PaddingY(8).Children(func() {
				s.firstStep(c, p, "1", "在下面说一句话，或者 @ 某一位")
				s.firstStep(c, p, "2", "它接活后，右栏能看到进度，点开能看它在干什么")
				s.firstStep(c, p, "3", "它会记住你们的对话，下次接着聊")
			})
		})
	default:
		// 「跟不跟底部」按上一帧的实际位置判：离底超过一截说明用户正往上读历史，
		// 这时候新消息不该把视图拽走。顶到底时差值是 0，自然继续跟随。
		// 只在真的量到过内容高度（MaxY > 0）时才判，否则第一帧会被误判成「翻上去了」。
		if s.chatScroll.MaxY > 0 {
			s.chatPinned = s.chatScroll.MaxY-s.chatScroll.Y < 40
		}
		ui.Scroll(c).Grow(1).FillWidth().TrackScroll(&s.chatScroll).Children(func() {
			// 左右内缩都是 36，不是 75。
			//
			// 画板里 75 是**正文**的 x（404 − 329），而正文前面还有 28 的头像和
			// 11 的间距：36 + 28 + 11 = 75。之前把 75 当成了消息行的起点，
			// 于是头像和正文一起右移 39px，整片消息离栏边太远 —— 这是「看着不对」
			// 里最显眼的一处。
			// 间距 20 是画板的节奏（每条消息之间一段呼吸），单条消息自己的
			// 上下 PaddingY 只留一点点，两处都放大就会稀成一片。
			ui.Column(c).PaddingX(MessageInset).PaddingY(10).Gap(20).Children(func() {
				for index, message := range s.conversation.Messages {
					// 同一张票的票号会挂在「收到」和「报结果」两条回复上。两条各画一遍，
					// 屏幕上就是连着两条「1 个文件已放进产出」—— 看着像交了两回活。
					// 只让这张票在时间线上的最后一条回复挂结果条，见 lastOfTicket。
					s.message(c, p, message, lastOfTicket(s.conversation.Messages, index))
				}
				// 卡片的缩进已经在 message/subagentCard/pendingCard 里算好，
				// 这里不再 PaddingX —— 外面加一次、里面再加一次就是双重缩进。
				// 子代理卡跟在这一段之后：它说的是「这段话派下去谁在跑」。
				// 设计稿把它放在消息流里，不是右栏 —— 右栏放的是工单，是另一件事。
				if tree := s.agents; len(tree) > 0 {
					s.subagentCard(c, p, tree)
				}
				// 等你要拍板的活：画板把它摆在消息流末尾，是这一轮对话的落点，
				// 不是右栏的一张卡。右栏只回答「有哪些票」，这里回答「现在要你做什么」。
				for _, task := range s.pendingDecisions() {
					s.pendingCard(c, p, task)
				}
			})
		})
	}
}

// subagentCard 是「这一段拆给几个分身」那张卡：表头一行、分隔线、每个分身一行。
func (s *app) subagentCard(c *ui.Context, p Palette, tree []AgentNode) {
	total := countAgents(tree)
	// 递归数：嵌套的子代理也算，否则「已完成」把还在跑的层级也吞进去。
	running := countRunning(tree)
	done := total - running
	// 与消息对齐：stream 已经给了 36 的内缩，这里只要让出头像那一列（28 + 11）。
	//
	// 卡用 Grow(1) 而不是 FillWidth()：在 Row 里，FillWidth 的子项要等 Row
	// 先定宽才能算自己的高度，结果整张卡的高度被算成表头那一行 —— 下面的分身形
	// 全被裁掉，看起来像「只派了一个人」。
	ui.Row(c).FillWidth().PaddingStart(39).Children(func() {
		ui.Column(c).Grow(1).Radius(RadiusPane).
			Background(p.Card).BorderWidth(1).BorderColor(p.Line).Children(func() {
			// 表头：左「N 个子代理」，右「x 在跑 · y 已完成」。
			ui.Row(c).FillWidth().Padding(12).AlignItems(ui.Center).Children(func() {
				ui.Text(c, fmt.Sprintf("%d 个子代理", total)).FontSize(FontBody).FontWeight(WeightName).TextColor(p.Muted)
				ui.Row(c).Grow(1)
				ui.Text(c, fmt.Sprintf("%d 在跑 · %d 已完成", running, done)).FontSize(FontSmall).TextColor(p.Faint)
			})
			// 行间分隔比卡片边框再淡一档（画板 #F4F0EA）：一行一条线的话，
			// 用卡片边框那种色会把整张卡切成几块。
			ui.Column(c).FillWidth().Height(1).Background(p.RowRule)
			for _, node := range tree {
				s.subagentRow(c, p, node, 0)
			}
			ui.Column(c).FillWidth().Height(1).Background(p.Line)
			// 脚注底是画板的 #FDFCFA：比卡片再浅一层，收住这张卡。
			ui.Row(c).FillWidth().Padding(12).Background(p.Faintest).Children(func() {
				ui.Text(c, "子代理还能再派子代理，层级在这张卡里逐层展开").
					FontSize(FontSmall).TextColor(p.Faint)
			})
		})
	})
}

// subagentRow 是卡里的一行：状态点 + 名字 + 右侧的状态与耗时。
func (s *app) subagentRow(c *ui.Context, p Palette, node AgentNode, depth int) {
	working := !agentDone(node.State)
	// 配色照画板：在跑的那一行是强调绿、名字用主文字色；
	// 跑完了的退成弱灰，名字也退到次要文字色 —— 一眼扫过去，还在动的那个最显眼。
	mark, tint, nameTint, stateTint := "○", p.Muted, p.Ink, p.Accent
	if !working {
		mark, tint, nameTint, stateTint = "✓", p.Faint, p.Muted, p.Faint
	}
	ui.Row(c).FillWidth().PaddingX(12).PaddingY(9).Gap(9).AlignItems(ui.Center).Children(func() {
		if depth > 0 {
			ui.Column(c).Width(float32(depth) * 14)
		}
		ui.Text(c, mark).FontSize(FontSmall).TextColor(tint)
		name := node.Label
		if name == "" {
			name = node.ID
		}
		ui.Text(c, name).FontSize(FontBody).TextColor(nameTint)
		ui.Row(c).Grow(1)
		// 画板这一格是「已完成 · 42 秒」：状态与耗时连成一句，状态在前。
		// 在跑的那一行只有「在跑」，没有耗时 —— 它还没跑完，这个数此刻不成立。
		ui.Text(c, agentStatus(node, working)).FontSize(FontSmall).TextColor(stateTint)
	})
	for _, child := range node.Children {
		s.subagentRow(c, p, child, depth+1)
	}
}

// agentStatus 是一行右侧那截话：状态，跑完了的再补上耗时。
//
// 耗时只在后端真的给了才画。今天 agentTree() 不发这个字段，所以实际画出来的
// 就是「已完成」三个字 —— 这是有意的：编一个「· 42 秒」出来，屏幕上那个数
// 会被当成真的读过。后端补上 elapsed_seconds 之后，这里不用改就能画出来。
func agentStatus(node AgentNode, working bool) string {
	line := agentWord(node.State)
	// 在跑的那个没有「跑了多久」：它还没跑完，这个数此刻不成立。
	if working || node.ElapsedSeconds == nil {
		return line
	}
	// 值读坏了（负数、NaN）就整段不画：留着「已完成 · 」比不画更糟。
	if spent := elapsedSeconds(*node.ElapsedSeconds); spent != "" {
		line += " · " + spent
	}
	return line
}

// agentWord 是子代理那一行右侧的状态词。
//
// 和 stateWord 分开：工单卡上说的是「在做 · 林 · 第 2 步」（画板右栏），
// 子代理行说的是「在跑」/「已完成」（画板 Desktop.dc.html:182/185）。
// 同一件事在两个语境里不是一个词，混用会有一边不像画板。
func agentWord(state string) string {
	switch state {
	case "work", "working":
		return "在跑"
	case "completed", "done", "merged", "closed":
		return "已完成"
	case "failed", "stopped":
		return "已停下"
	case "dropped":
		return "已放弃"
	}
	return "在跑"
}

// elapsedSeconds 把秒数说成人话，量级跟画板一致（画板是「42 秒」）。
//
// 超过一分钟进到「1 分 5 秒」：一屏里出现「427 秒」没人算得过来。
// 负数、NaN、无穷这类读坏了的值一律返回空串 —— 调用方据此不画，而不是画一个假数。
// 上界也要挡住：把超大浮点转成 int 在 Go 里是未定义结果，可能转出一个负数。
func elapsedSeconds(seconds float64) string {
	if seconds != seconds || seconds < 0 || seconds > 24*60*60 { // NaN、负数、超过一天：数据坏了
		return ""
	}
	total := int(seconds + 0.5)
	if total < 60 {
		return fmt.Sprintf("%d 秒", total)
	}
	return fmt.Sprintf("%d 分 %d 秒", total/60, total%60)
}

// countAgents 数整棵树有多少个分身。
// agentDone 是一个子代理是不是已经收工。后端目前只发 working，这个集合为将来的终态留位置。
func agentDone(state string) bool {
	switch state {
	case "done", "ended", "completed", "failed", "stopped":
		return true
	}
	return false
}

// countRunning 数整棵树里还在跑的分身。
func countRunning(nodes []AgentNode) int {
	n := 0
	for _, node := range nodes {
		if !agentDone(node.State) {
			n++
		}
		n += countRunning(node.Children)
	}
	return n
}

func countAgents(tree []AgentNode) int {
	n := 0
	var walk func(nodes []AgentNode)
	walk = func(nodes []AgentNode) {
		for _, node := range nodes {
			n++
			walk(node.Children)
		}
	}
	walk(tree)
	return n
}

// pendingDecisions 是「卡在等你」的那几张票：消息流末尾要请人拍板的那些。
//
// 只取真的在等具体决定的（NeedsPerson 有值且不是失败）。失败的票是要人处理，
// 但不是「二选一」；它在右栏的失败卡里已经有自己的位置。
func (s *app) pendingDecisions() []Task {
	if s.conversation == nil {
		return nil
	}
	var out []Task
	for _, task := range s.conversation.Tasks {
		if task.Open && task.NeedsPerson != "" && task.NeedsPerson != "failed" {
			out = append(out, task)
		}
	}
	return out
}

// answer 是一条点选选项的回答。在这里就把它发出去，不经过输入框：
// 画板上那两个 A/B 按钮是「直接答」，多一步「再按发送」就不像在回答了。
//
// answers 是正在发的那几条（键是「票号|选项 id」），挡住连点；
// answerNote 只写这件事的结果，不冒充连接故障。
func (s *app) answer(task Task, option AttentionOption) {
	slot := answerSlot(task, option)
	label := strings.TrimSpace(option.Label)
	// 点名那一位，回答才落在这段对话里；没有署名对象时就不硬加一个「@队伍」。
	text := label
	if task.BotID != "" {
		text = "@" + s.nameOf(task.BotID) + " " + label
	}
	if s.client == nil || label == "" || s.answers[slot] {
		return
	}
	if s.answers == nil {
		s.answers = make(map[string]bool)
	}
	// 通道在 newApp 里 make；这里兜一下手工构造的 app，免得发送永久阻塞。
	if s.answered == nil {
		s.answered = make(chan answerResult, 4)
	}
	s.answers[slot] = true
	asked := answerSignature(task)
	s.answerNote, s.answerTicket, s.answerAsked = "", task.ID, asked
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := s.client.Send(ctx, text, mentionsIn(text, s.conversation))
		s.answered <- answerResult{key: slot, ticket: task.ID, asked: asked, err: err}
		s.wake()
	}()
}

// pendingCard 是「等你决定」：赭色边、浅暖底、两个选项 + 一句自写。
//
// 画板的意图是「后台已经在等，不是在聊天里问」—— 所以它是一个能直接答的块，
// 不是一段叙述。选项由后端随问题一起下发（契约 §5 的 question/options）：
// 有就画成 A/B 这类按钮，点一下就把那句话当回答发出去；没有就只留
// 「自己写一句」。这里不编选项 —— 后端没给，就没有第二条路。
func (s *app) pendingCard(c *ui.Context, p Palette, task Task) {
	ui.Row(c).FillWidth().Gap(11).AlignItems(ui.Start).PaddingY(6).Children(func() {
		// 与 Bot 消息同一列头像：这张卡是那位 Bot 在等你。
		s.messageAvatar(c, p, task.BotID)
		ui.Column(c).Grow(1).MinWidth(0).Gap(8).Children(func() {
			// 名字行只在有职能可写时出现：头像已经说明是谁，独占一行只会
			// 把这张卡推高，和上面几条消息的节奏对不齐。
			if role := s.roleOf(task.BotID); role != "" {
				ui.Row(c).Gap(7).AlignItems(ui.Baseline).Children(func() {
					ui.Text(c, s.nameOf(task.BotID)).FontSize(FontSmall).
						FontWeight(WeightName).TextColor(p.Ink)
					ui.Text(c, role).FontSize(FontHairline).TextColor(p.Faint)
				})
			}
			// 不加 FillWidth：在 Row 里嵌套 Column 时它会让这一列的宽度等待
			// Row 的测量结果，高度被压成一条 —— 卡里只剩下「等你决定」几个字。
			// Grow(1) 已经把这列吃满剩余宽度。
			ui.Column(c).Grow(1).Padding(13).Radius(RadiusPane).
				Background(p.WarmBase).BorderWidth(1).BorderColor(p.WarnEdge).
				Gap(9).Children(func() {
				ui.Row(c).Gap(7).AlignItems(ui.Center).Children(func() {
					// 赭色的惊叹号圆环：和左栏状态点同一种语言。
					ui.Text(c, "◷").FontSize(FontSmall).TextColor(p.Warn)
					ui.Text(c, "等你决定").FontSize(FontSmall).FontWeight(WeightFigure).
						LetterSpacing(0.35).TextColor(p.Warn)
				})
				// 后端给了问题就读问题；没给（delivery/review/blocked/failed 那几种「等你」）
				// 才退回 needs_person。needs_person 存的是类别，直接画出来是英文单词。
				if task.Question != "" {
					ui.Text(c, task.Question).FontSize(FontBodyWide).LineHeight(1.55).TextColor(p.Ink)
				} else {
					ui.Text(c, "这张票卡在等你，原因："+waitingWord(task.NeedsPerson)).
						FontSize(FontBodyWide).LineHeight(1.55).TextColor(p.Ink)
				}
				if waited := s.waitedFor(task); waited != "" {
					ui.Text(c, "已经等了 "+waited).FontSize(FontHairline).TextColor(p.Faint)
				}
				// A/B：画板里每个选项一行，左边一个序号，点一下直接答。
				for index, option := range task.Options {
					sent := s.answers[answerSlot(task, option)]
					ui.Row(c).FillWidth().PaddingX(11).PaddingY(9).Radius(RadiusItem).
						Background(p.Card).BorderWidth(1).BorderColor(p.WarnEdge).
						Gap(8).AlignItems(ui.Baseline).Cursor(ui.CursorPointer).
						Children(func() {
							mark := optionMark(index)
							if sent {
								mark = "✓"
							}
							ui.Text(c, mark).FontSize(FontBody).FontWeight(WeightFigure).TextColor(p.Accent)
							ui.Text(c, option.Label).FontSize(FontBody).LineHeight(1.45).TextColor(p.Ink)
						}).OnClick(func() { s.answer(task, option) })
				}
				// 只在这张卡自己答过之后说一句：两张待决的卡并排时，A 的结果不该写到 B 上。
				// 同一张票换了新问题也不算「这张卡答过」—— 那句话是按上一道题说的。
				if s.answerTicket == task.ID && s.answerNote != "" && s.answerAsked == answerSignature(task) {
					ui.Text(c, s.answerNote).FontSize(FontHairline).TextColor(p.Faint)
				}
				// 回一句就落在同一段对话里：直接聚焦输入框，不再多造一个输入层。
				ui.Row(c).Gap(7).Children(func() {
					ui.Row(c).Grow(1).PaddingX(11).PaddingY(8).Radius(RadiusItem).
						Background(p.Card).BorderWidth(1).BorderColor(p.WarnEdge).
						Cursor(ui.CursorPointer).OnClick(func() {
						// 点「自己写一句」= 把这句在等的话带进输入框，省得人再想上下文。
						if s.input == "" {
							s.input = "@" + s.nameOf(task.BotID) + " "
						}
						s.navTab = navBackend
					}).Children(func() {
						ui.Text(c, "自己写一句…").FontSize(FontBody).TextColor(p.Hint)
					})
					ui.Row(c).PaddingX(13).PaddingY(8).Radius(RadiusItem).
						Background(p.Warn).Cursor(ui.CursorPointer).Center().Children(func() {
						ui.Text(c, "回").FontSize(FontBody).TextColor(p.WarnInk)
					}).OnClick(func() {
						if s.input == "" {
							s.input = "@" + s.nameOf(task.BotID) + " "
						}
					})
				})
			})
		})
	})
}

// answerSlot 是「这张票上的这个选项」的标识：正在发的按钮和结果回来时按它对应上。
func answerSlot(task Task, option AttentionOption) string { return task.ID + "|" + option.ID }

// answerSignature 是这张卡此刻问的是哪一组：换了问题或换了选项，它就与旧的那组不同。
// 「已按这个答了」只对得上同一组 —— 否则那张卡上写着的是另一道题。
func answerSignature(task Task) string {
	parts := []string{task.Question}
	for _, option := range task.Options {
		parts = append(parts, option.ID+"\x00"+option.Label)
	}
	return strings.Join(parts, "\x00")
}

// answerIsCurrent 判断手里那句回执是不是还对得上现在这张卡：
// 答的那道题还在等、还是同一组问题。票走了或换了新问题，这句话就该收起来。
func (s *app) answerIsCurrent() bool {
	if s.answerTicket == "" {
		return false
	}
	for _, task := range s.pendingDecisions() {
		if task.ID != s.answerTicket {
			continue
		}
		return answerSignature(task) == s.answerAsked
	}
	return false
}

// optionMark 是选项左边那个字母：A、B、C…。超过 26 个就退回数字，
// 但后端最多给四个，这条只是兜底。
func optionMark(index int) string {
	if index >= 0 && index < 26 {
		return string(rune('A' + index))
	}
	return fmt.Sprintf("%d", index+1)
}

// waitingWord 把 needs_person 的类别说成人话。这些类别是后台的阶段动作，
// 不是给人读的句子 —— 没有问题时，卡上至少要说清在等哪一类事。
func waitingWord(action string) string {
	switch action {
	case "delivery":
		return "上一轮回话没送到，需要你处理"
	case "review":
		return "活干完了，等你过目"
	case "blocked":
		return "做不下去，要你松开"
	case "failed":
		return "跑失败了，要你处理"
	case "answer":
		return "在等你回一句话"
	}
	return "在等你回一句话"
}

// lastOfTicket 说这条消息是不是「这张票的最后一条回复」，只有它才轮到挂结果条。
//
// 同一张票的票号会挂在好几条回复上（先一句「收到」、干完再一句「报结果」），
// 每条各画一遍结果条，屏幕上就是连着两条「1 个文件已放进产出」—— 看着像交了两回活。
// 规则：同一张票号，只让时间线上最后一条带它的回复挂结果条，之前的同票号消息不画。
//
// 判法只有「从这一条往后找」一件事：后面没有第二条带同票号的回复，这一条就是最后一条。
// 不倒着排序、不按 at 比时间、更不看 id —— 顺序就是列表给的顺序，两端都照它办。
//
// 三条边界，与手机端 OutputsCopy.lastOfTicket 逐条对齐：
//   - 自己发的话不挂结果条（两端都只在 Bot 的回复下面画），所以也不算「压住上面那条」；
//   - 没有票号的这一条永远 false —— 绝不因为「前后都没票号」就替它认一张票；
//   - 越界的下标返回 false，别让调用方一处写错就炸掉整屏。
func lastOfTicket(messages []Message, index int) bool {
	if index < 0 || index >= len(messages) {
		return false
	}
	message := messages[index]
	if message.Role != "agent" {
		return false
	}
	ticket := message.ticketRef()
	if ticket == "" {
		return false
	}
	for _, later := range messages[index+1:] {
		if later.Role != "agent" {
			continue
		}
		if later.ticketRef() == ticket {
			return false
		}
	}
	return true
}

func (s *app) message(c *ui.Context, p Palette, message Message, showResult bool) {
	fromBot := message.Role == "agent"
	// 画板的中栏是「头像 + 正文」的排版，不是「一排气泡」：
	//
	//   林 [28×28 头像]  输入框间距 12px，按钮贴底……
	//                    [代码卡]
	//
	// Bot 的话没有底色也没有气泡 —— 它是一条发言，不是一张卡片。只有自己
	// 发的才做成右侧深色气泡（右下角收 4px 尖角）。以前两头都画成气泡，
	// 结果一屏全是圆角块，层级全靠底色深浅区分，读起来像两块对等的面板。
	//
	// 缩进不在这里加：stream 已经给了 MessageInset(36) 的内缩，
	// 头像 28 + 间距 11 之后正文正好落在画板的 75 上。
	row := ui.Row(c).FillWidth().Gap(11).AlignItems(ui.Start)
	if fromBot {
		row = row.PaddingY(4)
	} else {
		row = row.PaddingY(2).Justify(ui.End)
	}
	row.Children(func() {
		if fromBot {
			s.messageAvatar(c, p, message.BotID)
		}
		// 正文栏：头像 28 + 间距 11 之外，右边留 36 给栏边。
		ui.Column(c).Grow(1).MinWidth(0).Gap(9).Children(func() {
			if fromBot {
				// 画板的 Bot 发言只有「头像 + 正文」，没有名字行也没有角色行 ——
				// 头像本身已经说明了是谁。连续几段同一个人发言时，再加名字会把
				// 消息流读成一连串带标题的段落，Rhythm 就散了。
				ui.Text(c, message.Text).FontSize(FontText).LineHeight(1.6).TextColor(p.Ink)
			} else {
				// 自己发的话：右侧深色气泡，右下角收成 4px 尖角（画板 `15px 15px 4px`）。
				// 气泡独占一行、不撑满剩余宽度：MaxWidth 是测量出的上限，
				// 里面再包一层 Row(Justify End) 让短句只占自己那一截。
				ui.Row(c).FillWidth().Justify(ui.End).Children(func() {
					ui.Column(c).PaddingX(15).PaddingY(11).MaxWidthPercent(76).
						Radius(RadiusBubble, RadiusBubble, RadiusTail, RadiusBubble).
						Background(p.UserBubble).Children(func() {
						ui.Text(c, message.Text).FontSize(FontText).LineHeight(1.55).TextColor(p.UserInk)
					})
				})
			}
			// 消息带代码就画代码卡：设计稿里它挂在正文下面、与正文同宽。
			// 署名带下去：卡上的「采用」要点名写这段的那位，不能猜成默认 Bot。
			if block := message.Code(); block != nil {
				s.codeCard(c, p, *block, message.BotID)
			}
			// 结果条：这条话带票号、且那张票确实交了东西时才有（契约 §5.4）。
			// 没有票号就什么都画 —— 按时间猜一张票会把别人的成果挂到这句话下面。
			// showResult 由 lastOfTicket 判：同一张票只挂在最后一条回复上，不重复画。
			if fromBot && showResult {
				s.resultBar(c, p, message)
			}
		})
	})
}

// messageAvatar 是消息左侧那个 28×28 的方块头像。
//
// 画板里它是**实心**的：绿底白字（周是赭底白字）。淡底那种是花名册里
// 「在名单上但没选中」的表示，用在消息流里会让每一行都像未选中状态。
func (s *app) messageAvatar(c *ui.Context, p Palette, botID string) {
	fill, tint := p.Accent, p.AccentInk
	if isWarnBot(botID) {
		fill, tint = p.Warn, p.WarnInk
	}
	ui.Column(c).Width(28).Height(28).Radius(RadiusButton).Background(fill).
		AlignItems(ui.Center).Justify(ui.Center).Children(func() {
		ui.Text(c, firstRune(s.nameOf(botID))).FontSize(FontBody).FontWeight(WeightFigure).TextColor(tint)
	})
}

// roleOf 是花名册里那半句「前端 · 话少，先验再说」的前半截。
// 人设是自由文本，取第一个分隔符前的部分当职能；没有就不显示。
func (s *app) roleOf(botID string) string {
	if s.conversation == nil {
		return ""
	}
	for _, bot := range s.conversation.Bots {
		if bot.ID != botID {
			continue
		}
		persona := strings.TrimSpace(bot.Persona)
		if persona == "" {
			return ""
		}
		for _, sep := range []string{"，", ",", "。", "；", "·"} {
			if head, _, found := strings.Cut(persona, sep); found {
				head = strings.TrimSpace(head)
				if len([]rune(head)) <= 8 {
					return head
				}
			}
		}
		return clipRunes(persona, 8)
	}
	return ""
}

// isWarnBot 把某几位固定交给赭色系，用来在看代码卡、长消息时区分是谁说的。
// 画板里「周」用赭、其余用绿：这是有意的语义分色，不是随机配色。
func isWarnBot(botID string) bool {
	switch botID {
	case "zhou", "business", "market":
		return true
	}
	return false
}

// codeCard 是消息里的代码片段：文件名 + 增删统计 + 逐行高亮，下面挂两个按钮。
//
// 设计稿里新增行是整行浅绿底、删除行整行橙底，`+` / `-` 号跟在行首。
// 只给号着色是不够的 —— 一屏代码里看不出改了哪几行。
//
// 画板在这张卡下面还有「采用」「看看改完的样子」两个按钮，之前没接，
// 桌面端就只剩一段只读的代码。两个按钮都不新开后端接口：
//   - 采用：走已有的消息通道（POST /api/mobile/send），把「采用这段改动」这句
//     当普通回答发出去，点名写这段的那位 Bot。它本来就是一次对话里的表态，
//     和「等你决定」卡上点选选项是同一条路。
//   - 看看改完的样子：走已有的 GET /api/mobile/screen?ticket=…（client.Screen，契约 §5.1），
//     读这段改动所属工单的活动快照。快照里就是它改完跑了什么、输出什么。
//
// 两件事都得先说清「对谁做」：没有票号或没有署名对象时，按钮照样在，
// 但按下去只会得到一句实话，而不是静默不动或改到别的工单上。
func (s *app) codeCard(c *ui.Context, p Palette, block CodeBlock, botID string) {
	key := block.ID
	busy, done := s.adopting[key], s.adoptedOK[key]
	ui.Column(c).FillWidth().Radius(RadiusPane).Background(p.Card).
		BorderWidth(1).BorderColor(p.Line).Children(func() {
		// 表头：左边文件名，右边 +N −M。
		ui.Row(c).FillWidth().PaddingX(14).PaddingY(9).AlignItems(ui.Center).Children(func() {
			ui.Text(c, block.Path).FontSize(FontBody).TextColor(p.Muted)
			ui.Row(c).Grow(1)
			if block.Added > 0 {
				ui.Text(c, fmt.Sprintf("+%d", block.Added)).FontSize(FontBody).TextColor(p.Accent)
			}
			if block.Removed > 0 {
				ui.Text(c, fmt.Sprintf(" -%d", block.Removed)).FontSize(FontBody).TextColor(p.Warn)
			}
		})
		ui.Column(c).FillWidth().Height(1).Background(p.Line)
		for _, line := range block.Lines {
			// 行首那两格跟着整行走（"  " 上下文 / "+ " 新增 / "- " 删除），
			// 画板里 `+` / `-` 号就在这一列。
			prefix, soft, base := "  ", p.Card, p.Faint
			// 上下文行与改动行是两种画法：改动行整行一个颜色，不拆词；
			// 上下文行才分词着色（画板 Desktop.dc.html:133 —— 整行暖灰，
			// 只有值 `12px` 是赭色）。行内再给改动行分色，反而看不出哪一行变了。
			highlight := true
			switch line.Kind {
			case "added":
				prefix, soft, base, highlight = "+ ", p.AccentSoft, p.Accent, false
			case "removed":
				prefix, soft, base, highlight = "- ", p.WarnSoft, p.Warn, false
			}
			ui.Row(c).FillWidth().PaddingX(14).PaddingY(3).Background(soft).Children(func() {
				// 分段铺：一段一个 Text，颜色各自带。拼回去与原文逐字相同，
				// 这一点由 syntax_test.go 钉住 —— 高亮可以少，不能吃掉字符。
				for _, segment := range codeSegments(prefix, line.Text, base, p.Warn, highlight) {
					if segment.Text == "" {
						continue
					}
					ui.Text(c, segment.Text).FontSize(FontBody).TextColor(segment.Color)
				}
			})
		}
		// 按钮行与卡片同宽，紧贴在代码下面：采用是主强调的实心按钮，
		// 「看看改完的样子」是白底细边的次按钮 —— 画板里就是这一主一次。
		ui.Row(c).FillWidth().PaddingX(10).PaddingY(9).Gap(7).AlignItems(ui.Center).Children(func() {
			s.adoptButton(c, p, block, botID, busy, done)
			s.previewButton(c, p, block)
		})
		// 回执只写在它自己这张卡下面：同一段对话里并排两张卡时，不串台。
		if note := s.adoptNotes[key]; note != "" {
			ui.Row(c).FillWidth().PaddingX(10).PaddingY(9).Children(func() {
				ui.Text(c, note).FontSize(FontHairline).TextColor(p.Faint)
			})
		}
	})
}

// adoptButton 是代码卡上的「采用」。
func (s *app) adoptButton(c *ui.Context, p Palette, block CodeBlock, botID string, busy, done bool) {
	label, fill, tint := "采用", p.Accent, p.AccentInk
	switch {
	case done:
		label, fill = "✓ 已采用", p.AccentSoft
		tint = p.Accent
	case busy:
		label = "采用中…"
	}
	button := ui.Row(c).PaddingX(14).PaddingY(7).Radius(RadiusButton).Background(fill).Center().Children(func() {
		ui.Text(c, label).FontSize(FontBodyWide).FontWeight(WeightCard).TextColor(tint)
	})
	// 已经采用过、或者这条正在发：按钮还在（布局不跳），但不再接第二下，
	// 指针也不变手 —— 一个按下去没反应的手型指针，比一个普通指针更让人以为坏了。
	if busy || done {
		return
	}
	button.Cursor(ui.CursorPointer).OnClick(func() { s.adopt(block, botID) })
}

// previewButton 是代码卡上的「看看改完的样子」。
func (s *app) previewButton(c *ui.Context, p Palette, block CodeBlock) {
	ui.Row(c).PaddingX(14).PaddingY(7).Radius(RadiusButton).Background(p.Card).
		BorderWidth(1).BorderColor(p.Line).Center().Cursor(ui.CursorPointer).Children(func() {
		ui.Text(c, "看看改完的样子").FontSize(FontBodyWide).TextColor(p.Ink)
	}).OnClick(func() { s.preview(block) })
}

// adopt 采用这段改动。它不新开接口：把这句话当一条普通消息发给队伍，点名写它的那位 Bot。
//
// 为什么不是「直接改文件」：这段代码是 worker 在自己的会话里写出来的，宿主机上没有
// 一条能把某一行的增删重新应用回工作区的通道；凭空造一条，就等于让前台绕过
// worker 去动它的工作目录。走消息通道，采用变成一次明确的表态，由队伍自己接下一步。
func (s *app) adopt(block CodeBlock, botID string) {
	key := block.ID
	if s.client == nil || s.adopting[key] || s.adoptedOK[key] {
		return
	}
	if s.conversation == nil {
		s.noteAdopt(key, "还没读到对话，先刷新一下再采用")
		return
	}
	text := adoptText(block, botID, s.nameOf(botID))
	if s.adopting == nil {
		s.adopting = map[string]bool{}
	}
	if s.adopted == nil {
		s.adopted = make(chan adoptResult, 4)
	}
	s.adopting[key] = true
	delete(s.adoptNotes, key)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := s.client.Send(ctx, text, mentionsIn(text, s.conversation))
		s.adopted <- adoptResult{key: key, err: err}
		s.wake()
	}()
}

// noteAdopt 把一句实话写在某张卡下面。
func (s *app) noteAdopt(key, note string) {
	if s.adoptNotes == nil {
		s.adoptNotes = map[string]string{}
	}
	s.adoptNotes[key] = note
}

// adoptText 是「采用」发出去的那句话：点名写这段的 Bot，带上文件名，
// 再说清采用的是哪一段改动。
func adoptText(block CodeBlock, botID, botName string) string {
	file := strings.TrimSpace(block.Path)
	if file == "" {
		file = "这段改动"
	}
	where := ""
	if botID != "" {
		// 点名用 bot_id：名字可以被改，id 不会。nameOf 给的是人看的名字，两处都要有。
		where = "@" + botID
		if botName != "" && botName != botID {
			where += "（" + botName + "）"
		}
		where += " "
	}
	summary := changeSummary(block)
	if summary != "" {
		summary = "，" + summary
	}
	// 没有文件名时 file 已经是「这段改动」，再跟一句就成了同一个词说两遍。
	target := file
	if file != "这段改动" {
		target = file + " 这段改动"
	}
	return where + "采用 " + target + summary + "，按这个改。"
}

// changeSummary 把增删行数说成人话；没有统计就什么也不说 —— 不编一个「加 0 行」。
func changeSummary(block CodeBlock) string {
	switch {
	case block.Added > 0 && block.Removed > 0:
		return fmt.Sprintf("加 %d 行、删 %d 行", block.Added, block.Removed)
	case block.Added > 0:
		return fmt.Sprintf("加 %d 行", block.Added)
	case block.Removed > 0:
		return fmt.Sprintf("删 %d 行", block.Removed)
	}
	return ""
}

// preview 看看改完的样子：读这段改动所属这张票的活动快照。
//
// 票号只认代码块自己带的那个。没有就如实说 —— 拿第一张在跑的票顶替，
// 就是把 A 的活显示成 B 的结果，比不给看更糟。
func (s *app) preview(block CodeBlock) {
	ticket := strings.TrimSpace(block.TicketRef)
	key := block.ID
	if s.client == nil {
		return
	}
	if ticket == "" {
		s.previewNote = "这段改动没带工单号，看不到它改完的样子；让它再报一次就能看了"
		return
	}
	if s.previewed == nil {
		s.previewed = make(chan previewResult, 4)
	}
	// 上一张卡留下的那句实话先擦掉：新的一次请求还没回来，标题栏不该挂着旧的结论。
	s.previewNote = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		view, err := s.client.Screen(ctx, ticket)
		result := previewResult{key: key, ticket: ticket}
		switch {
		case err != nil:
			result.reason = "读不到「改完的样子」：" + err.Error()
		case view != nil && view.State == "live" && len(view.Lines) > 0:
			result.view = view
		case view != nil && view.Reason != "":
			result.reason = view.Reason
		default:
			result.reason = "这张工单暂时没有可显示的活动"
		}
		s.previewed <- result
		s.wake()
	}()
}

func (s *app) nameOf(botID string) string {
	if s.conversation != nil {
		for _, bot := range s.conversation.Bots {
			if bot.ID == botID {
				return strings.TrimSpace(bot.Name)
			}
		}
	}
	if botID == "" {
		return "队伍"
	}
	return botID
}

// queuedPreview 是排队中的一条消息。请求号用来撤回，正文从时间线里按 request_id 对回来。
type queuedPreview struct {
	RequestID string
	Text      string
}

// queuedPreviews 把 conversation.Queued 里的请求号对回正文，最多取最近 limit 条。
//
// Queued 只给请求号；正文在 items 里（同一条消息带着 request_id 和 text）。
// 所以这里不改后端协议，只在客户端把两张表接起来。对不上的就留空，
// 由 queuedSummary 说「还没读回来」，而不是编一句假话。
func queuedPreviews(conversation *Conversation, limit int) []queuedPreview {
	if conversation == nil || len(conversation.Queued) == 0 {
		return nil
	}
	textOf := make(map[string]string, len(conversation.Messages))
	for _, message := range conversation.Messages {
		if message.RequestID == "" {
			continue
		}
		// 同一次发送可能被读到不止一次；先读到的那条就是原文。
		if _, seen := textOf[message.RequestID]; !seen {
			textOf[message.RequestID] = message.Text
		}
	}
	ids := conversation.Queued
	if limit > 0 && len(ids) > limit {
		ids = ids[len(ids)-limit:]
	}
	out := make([]queuedPreview, 0, len(ids))
	for _, id := range ids {
		out = append(out, queuedPreview{RequestID: id, Text: textOf[id]})
	}
	return out
}

// queuedSummary 把一条排队消息压成一行字。换行与连续空白先抹平，
// 太长才截断 —— 摘要只用来认出是哪一句，完整正文还在消息流里。
func queuedSummary(text string, limit int) string {
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return "（正文还没读回来）"
	}
	runes := []rune(text)
	if limit > 0 && len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return text
}

// withdraw 撤回一条还没被读到的排队消息。结果走通道回主线程，
// 不在工作线程上碰 s.withdrawError / s.withdrawing。
func (s *app) withdraw(requestID string) {
	requestID = strings.TrimSpace(requestID)
	if s.client == nil || requestID == "" || s.withdrawing[requestID] {
		return
	}
	if s.withdrawing == nil {
		s.withdrawing = make(map[string]bool)
	}
	// 通道在 newApp 里 make；这里兜一下手工构造的 app，免得发送永久阻塞。
	if s.withdrawn == nil {
		s.withdrawn = make(chan withdrawResult, 4)
	}
	s.withdrawing[requestID] = true
	s.withdrawError = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.withdrawn <- withdrawResult{requestID: requestID, err: s.client.Withdraw(ctx, requestID)}
		s.wake()
	}()
}

func (s *app) composer(c *ui.Context, p Palette) {
	// 排队中的消息也能看见：说了会排在后面，就得让人认得出排的是哪几句，并且能撤。
	if previews := queuedPreviews(s.conversation, queuedPreviewCount); len(previews) > 0 {
		ui.Column(c).FillWidth().PaddingX(ContentInset).PaddingY(8).Gap(6).Children(func() {
			ui.Text(c, fmt.Sprintf("%d 条排队中，等队伍读完手上这一步", len(s.conversation.Queued))).
				FontSize(FontTiny).TextColor(p.Faint)
			for _, preview := range previews {
				preview := preview
				ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(8).PaddingX(10).PaddingY(5).
					Radius(RadiusItem).Background(p.Surface).Children(func() {
					ui.Text(c, queuedSummary(preview.Text, queuedPreviewRunes)).
						FontSize(FontTiny).TextColor(p.Muted)
					ui.Row(c).Grow(1)
					// 插队只在有工单正在跑时才有意义：它把话交给那位 worker 的下一步。
					if ticketID, ok := s.runningTicket(); ok && !s.steering[preview.RequestID] {
						ui.Row(c).PaddingX(8).PaddingY(3).Radius(RadiusChip).Background(p.AccentSoft).
							Cursor(ui.CursorPointer).Children(func() {
							ui.Text(c, "插队").FontSize(FontTiny).TextColor(p.Accent)
						}).OnClick(func() { s.steer(preview.RequestID, ticketID) })
					}
					ui.Row(c).PaddingX(8).PaddingY(3).Radius(RadiusChip).Background(p.Card).
						BorderWidth(1).BorderColor(p.Line).Cursor(ui.CursorPointer).
						Children(func() {
							ui.Text(c, "撤回").FontSize(FontTiny).TextColor(p.Warn)
						}).OnClick(func() { s.withdraw(preview.RequestID) })
				})
			}
		})
	}
	// 撤回失败的话独立一行：409 之后时间线会重读，排队块可能已经空了，
	// 但那句「没撤成」还得让人看见。
	if s.withdrawError != "" {
		ui.Row(c).FillWidth().PaddingX(28).PaddingY(2).Children(func() {
			ui.Text(c, "撤回没成功："+s.withdrawError).FontSize(FontTiny).TextColor(p.Danger)
		})
	}
	if s.steerNote != "" {
		ui.Row(c).FillWidth().PaddingX(28).PaddingY(2).Children(func() {
			ui.Text(c, s.steerNote).FontSize(FontTiny).TextColor(p.Faint)
		})
	}
	// 读过但不动手的那几条也要说一声，否则屏幕上只有自己说的话，分不清「还在想」和「不会回」。
	if s.conversation != nil && len(s.conversation.Declined) > 0 {
		declined := s.conversation.Declined[len(s.conversation.Declined)-1]
		ui.Row(c).FillWidth().PaddingX(ContentInset).PaddingY(8).Children(func() {
			ui.Text(c, "有一条队伍看过了没动手："+declined.Reason).
				FontSize(FontTiny).TextColor(p.Faint)
		})
	}
	// 输入区：画板里整块落在页面底上（不是另一条横带），左右各内缩 28；
	// 输入卡圆角 13、白底细边，发送键是框内右端 32×32 的圆角按钮。
	ui.Column(c).FillWidth().PaddingX(28).PaddingY(20).Gap(7).Background(p.Surface).Children(func() {
		placeholder := "跟队伍说点什么，或者交给别人"
		if s.problem != "" {
			placeholder = "连上之后才能发"
		}
		ui.Row(c).FillWidth().Radius(RadiusBig).Background(p.Card).
			BorderWidth(1).BorderColor(p.Line).PaddingX(13).PaddingY(9).Gap(8).
			AlignItems(ui.Center).Children(func() {
			// 输入框也得自己定字色与底：mygo 的默认色跟着系统外观走，
			// 而这扇窗的主题可以由 CREW_THEME 覆盖 —— 系统是暗、窗口是亮时，
			// 默认色会把输入框画成一整块黑底（实测过，亮色主题下很扎眼）。
			ui.TextInput(c, &s.input).Placeholder(placeholder).Grow(1).
				PlaceholderColor(p.Faint).TextColor(p.Ink).CaretColor(p.Accent).
				SelectionColor(p.AccentSoft).Background(p.Card).OnSubmit(func() { s.send() })
			if s.sending {
				ui.Text(c, "发送中…").FontSize(FontTiny).TextColor(p.Faint)
			} else {
				// 有工单在跑时，还多一条「插队」：这句不等排队，直接交给它下一步。
				if s.input != "" {
					if ticketID, ok := s.runningTicket(); ok {
						ui.Row(c).PaddingX(9).Height(32).Radius(RadiusCard).Background(p.AccentSoft).
							Center().Cursor(ui.CursorPointer).Children(func() {
							ui.Text(c, "插队").FontSize(FontSmall).TextColor(p.Accent)
						}).OnClick(func() { s.sendSteer(ticketID) })
					}
				}
				ui.Row(c).Width(32).Height(32).Radius(RadiusCard).Background(p.Accent).
					Center().Cursor(ui.CursorPointer).Children(func() {
					ui.Text(c, "↑").FontSize(FontGlyph).TextColor(p.AccentInk)
				}).OnClick(s.send)
			}
		})
		// 这句说明的是异步队伍的语义：你现在发的话排在哪。
		ui.Row(c).Gap(5).AlignItems(ui.Center).Children(func() {
			ui.Column(c).Width(5).Height(5).Radius(RadiusDot).
				Background(func() ui.Color {
					if s.anyRunning() {
						return p.Accent
					}
					return p.Hint
				}())
			ui.Text(c, s.queueLine()).FontSize(FontTiny).TextColor(p.Faint)
		})
	})
}

// queueLine 说清这句话会插队还是排队。
func (s *app) queueLine() string {
	if s.conversation == nil {
		return "正在读队伍的状态"
	}
	if s.conversation.Status.Paused {
		return "队伍已暂停，发出去的话会先排队"
	}
	for _, task := range s.conversation.Tasks {
		if task.Open {
			return s.nameOf(task.BotID) + "在跑，你现在发的话会排在它这一步之后"
		}
	}
	return "都在待命，发出去就会接上"
}

// pauseAll 停整个执行器。现在手机面只有这一种暂停，按钮上写「全部」而不是「这一张」。
// editBot 打开某一位的编辑层，草稿从当前的名单里取。
func (s *app) editBot(bot BotCard) {
	s.editingBot = bot.ID
	s.botName = strings.TrimSpace(bot.Name)
	s.botPersona = bot.Persona
	s.botError = ""
	s.botSaving = false
}

// saveBot 把编辑层里的名字与人设发出去。成功后才关层；失败原样写在层里。
func (s *app) saveBot() {
	if s.client == nil || s.botSaving || s.editingBot == "" {
		return
	}
	name := strings.TrimSpace(s.botName)
	if name == "" {
		s.botError = "名字不能为空"
		return
	}
	s.botSaving = true
	s.botError = ""
	id, persona := s.editingBot, strings.TrimSpace(s.botPersona)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		s.botSaved <- botSaveResult{id: id, err: s.client.EditBot(ctx, id, name, persona)}
		s.wake()
	}()
}

func (s *app) pauseAll() {
	if s.client == nil || s.pausing {
		return
	}
	s.pausing = true
	s.pauseNote = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		s.pauseDone <- pauseResult{err: s.client.Pause(ctx)}
		s.wake()
	}()
}

// lastStepHint 是这张票最后发生的一件事，用来填卡片底部左边那句现状。
// 没读过经过就返回空串 —— 卡片上留白比写一句猜的强。
func (s *app) lastStepHint(task Task) string {
	steps := s.stepsFor(task.ID)
	if len(steps) == 0 {
		return ""
	}
	return clipRunes(steps[len(steps)-1].Text, 18)
}

// taskDotColor 是工单卡标题左侧那个 5px 点的颜色：
// 在跑绿、等你赭、失败红，其余（已完成/未知）灰。
func (s *app) taskDotColor(p Palette, task Task) ui.Color {
	switch {
	case task.NeedsPerson == "failed" || task.Retryable:
		return p.Danger
	case task.NeedsPerson != "":
		return p.Warn
	case task.Open:
		return p.Accent
	}
	return p.Faint
}

// taskCountLine 是右栏栏头那一行：永远有张数，有票时再补在跑/失败。
func (s *app) taskCountLine() string {
	total, running, failed := 0, 0, 0
	if s.conversation != nil {
		total = len(s.conversation.Tasks)
		for _, task := range s.conversation.Tasks {
			if task.Open {
				running++
			}
			if task.NeedsPerson == "failed" {
				failed++
			}
		}
	}
	if total == 0 {
		return "0 张"
	}
	line := fmt.Sprintf("%d 张", total)
	if running > 0 {
		line += fmt.Sprintf(" · %d 在跑", running)
	}
	if failed > 0 {
		line += fmt.Sprintf(" · %d 失败", failed)
	}
	return line
}

// backendPane 是右栏：工单是唯一的工作状态主体，这里只是它的只读投影。
//
// 右栏跟着左栏点开的那一项走：「后台」是工单，「模型」是选择，「产出」是文件，
// 「常规任务」是那张定时账本。每一项都画得出来，没有一项按下去是空的。
func (s *app) backendPane(c *ui.Context, p Palette) {
	if !s.backendOpen {
		// 收起来不是消失：留一条窄边，点它就能再展开。
		// 只靠「再按一次后台」不够——人不知道那一格是开关。
		ui.Row(c).Width(30).FillHeight().Background(p.Card).Cursor(ui.CursorPointer).
			AlignItems(ui.Center).OnClick(func() { s.backendOpen = true; s.backendTab = 0 }).Children(func() {
			ui.Column(c).Gap(4).Children(func() {
				ui.Text(c, "‹").FontSize(FontBodyWide).TextColor(p.Faint)
				ui.Text(c, "后").FontSize(FontTiny).TextColor(p.Faint)
				ui.Text(c, "台").FontSize(FontTiny).TextColor(p.Faint)
			})
		})
		return
	}
	// 右栏左缘那条线：方向是 RightToLeft，外层再明确一次从左到右，线才落在左缘。
	// 宽度交给 ui.Split 给的 pane，不再写一次 Width：两处都写时，Split 夹过之后的值
	// 和这里写的值会差几像素，内容右对齐到栏外，看起来就是「拖窄后不跟着自适应」。
	ui.Row(c).FillWidth().FillHeight().Direction(ui.LeftToRight).Gap(0).Children(func() {
		ui.Column(c).Width(1).FillHeight().Background(p.Line)
		ui.Column(c).Grow(1).FillHeight().PaddingX(16).PaddingY(22).Gap(14).Background(p.Raised).Children(func() {
			switch s.navTab {
			case navModel:
				s.modelPane(c, p)
			case navOutput:
				s.outputsPane(c, p)
			case navRoutine:
				s.routinesPane(c, p)
			case navMemory:
				s.memoryPane(c, p)
			default:
				s.workPane(c, p)
			}
			s.pairing(c, p)
			// 底部那块贴底：整队是否在跑、队列多长、一键停。数据都来自同一份时间线。
			ui.Row(c).Grow(1)
			ui.Column(c).FillWidth().Gap(8).Children(func() {
				ui.Text(c, s.crewStateLine()).FontSize(FontSmall).TextColor(p.Muted)
				// 画板底部是一组「名目 —— 值」：
				//   运行状态   ● 就绪
				//   队列       0 等待 · 上限 3 并发
				// 上限那三个字的出处是管理面的 maxWorkers（policy.ts 的默认 3），
				// 不是写死在界面里的常数；读不到就整行不画，见 loadRow。
				if load := s.crewLoad; load != nil {
					s.loadRow(c, p, "队列", fmt.Sprintf("%d 等待 · 上限 %d 并发", load.Queued, load.MaxWorkers))
				}
				if s.pauseNote != "" {
					ui.Text(c, s.pauseNote).FontSize(FontTiny).TextColor(p.Faint)
				}
				paused := s.conversation != nil && s.conversation.Status.Paused
				label := "全部暂停"
				if paused {
					label = "已暂停（去面板恢复）"
				}
				ui.Row(c).FillWidth().Height(32).Radius(RadiusItem).Background(p.Card).
					BorderWidth(1).BorderColor(p.Line).Center().
					Cursor(ui.CursorPointer).Children(func() {
					ui.Text(c, label).FontSize(FontBodyWide).TextColor(p.Muted)
				}).OnClick(s.pauseAll)
			})
		})
	})
}

// loadRow 是右栏底部「名目 —— 值」的一行（画板：队列 / 0 等待 · 上限 3 并发）。
//
// 名目在左、值在右，中间一个 Grow 撑开：右栏拖宽拖窄时值始终贴着右边。
func (s *app) loadRow(c *ui.Context, p Palette, name, value string) {
	ui.Row(c).FillWidth().MinWidth(0).AlignItems(ui.Center).Children(func() {
		ui.Text(c, name).FontSize(FontSmall).TextColor(p.Muted)
		ui.Row(c).Grow(1)
		ui.Text(c, value).FontSize(FontSmall).TextColor(p.Faint).MaxLines(1).Ellipsis("…")
	})
}

// crewStateLine 是右栏底部那行状态：整队在不在跑、手上几件、排了几条。
func (s *app) crewStateLine() string {
	if s.conversation == nil {
		return "正在读队伍的状态"
	}
	if s.conversation.Status.Paused {
		return "队伍已暂停 · 恢复要去面板"
	}
	open := 0
	for _, task := range s.conversation.Tasks {
		if task.Open {
			open++
		}
	}
	line := "队伍就绪 · 空闲"
	if open > 0 {
		line = fmt.Sprintf("队伍就绪 · %d 张在跑", open)
	}
	if queued := len(s.conversation.Queued); queued > 0 {
		line += fmt.Sprintf(" · %d 条排队", queued)
	}
	return line
}

// emptyTabTitle 说清是「这一档没有」，而不是「一张工单都没有」。
func (s *app) emptyTabTitle() string {
	switch s.backendTab {
	case 1:
		return "没有等你的工单。"
	case 2:
		return "还没有完成的工单。"
	default:
		return "进行中没有工单。"
	}
}

// collapseButton 是右栏标题行右端的「收起 ›」：收起不是消失，留一条窄边能再展开。
func (s *app) collapseButton(c *ui.Context, p Palette) {
	ui.Text(c, "收起 ›").FontSize(FontTiny).TextColor(p.Faint).Cursor(ui.CursorPointer).
		OnClick(func() { s.backendOpen = false })
}

// workPane 是「后台」那一栏：栏头、三个标签、工单卡。
func (s *app) workPane(c *ui.Context, p Palette) {
	// 栏头：标题 + 张数。
	ui.Row(c).Gap(7).AlignItems(ui.Center).Children(func() {
		ui.Text(c, "后台").FontSize(FontBodyWide).FontWeight(WeightTitle).TextColor(p.Ink)
		// 张数一直在，哪怕 0 张：空栏也要说「0 张」，不留一块来历不明的空白。
		// 有票时再补「x 在跑 · y 失败」——画板用这一行当栏头的第二层信息，
		// 而且靠右对齐：Grow 放在标题与它之间，不是放在它和收起之间。
		ui.Row(c).Grow(1)
		ui.Text(c, s.taskCountLine()).FontSize(FontSmall).TextColor(p.Faint)
		s.collapseButton(c, p)
	})

	// 标签：进行中 / 待你 / 已完成。画板里它是一条分段控件：
	// 轨道 360×32、底色 Track、圆角 8；里面三个胶囊各 115×26、圆角 6、间隔 4，
	// 选中的那个抬成白底（暗色按画板用 Card），没选中的透明。
	// 坐标见 designs/personal-agent/桌面亮色-坐标.md「右栏」。
	// 每个页签吃等分的宽度：栏被拖窄时固定 115 会顶出栏外，右端那个字被窗口裁掉。
	ui.Row(c).FillWidth().Height(TabHeight).Padding(TabBarInset).Gap(TabGap).
		AlignItems(ui.Center).Radius(RadiusItem).Background(p.Track).Children(func() {
		for i, label := range []string{"进行中", "待你", "已完成"} {
			index := i
			s.backendTabCell(c, p, label, s.backendTab == index, func() {
				s.backendTab = index
			})
		}
	})

	if s.retryError != "" {
		ui.Text(c, "重试没成功："+s.retryError).FontSize(FontTiny).TextColor(p.Danger)
	}

	tasks := s.shownTasks()
	if len(tasks) == 0 {
		// 空和读不到是两件事：断连时列表同样是空的，那时候写「这一栏还是空的」
		// 等于告诉人「没有工单」，可数据根本还没回来。分清楚再说。
		if s.problem != "" {
			ui.Column(c).FillWidth().Grow(1).Center().Children(func() {
				ui.Text(c, "还没连上，读不到工单").FontSize(FontBody).TextColor(p.Faint)
			})
		} else {
			ui.Column(c).FillWidth().Grow(1).Center().Gap(8).Children(func() {
				ui.Column(c).Width(22).Height(22).Radius(RadiusItem).BorderWidth(1).
					BorderColor(p.EmptyEdge).AlignItems(ui.Center).PaddingY(2).Children(func() {
					ui.Text(c, "▤").FontSize(FontBody).TextColor(p.EmptyGlyphSoft)
				})
				ui.Text(c, s.emptyTabTitle()).FontSize(FontLabel).FontWeight(WeightName).TextColor(p.Muted)
				ui.Text(c, "队伍接到的活会出现在这里。").FontSize(FontBody).TextColor(p.Hint)
			})
		}
	} else {
		ui.Scroll(c).Grow(1).FillWidth().Children(func() {
			ui.Column(c).Gap(9).Children(func() {
				for _, task := range tasks {
					s.taskCard(c, p, task)
				}
				// 这里不再画「他派了谁」：画板的右栏只有工单卡。子代理树属于
				// 「这段话派下去谁在跑」，归消息流里那张卡；两处都画一遍，
				// 右栏就变成第二份工单详情，和「一张票 = 一行」的密度对不上了。
			})
		})
	}
}

// backendTabCell 是分段控件里的一个页签。
//
// 它外层是一层 Row：mygo 的指针命中只落在自己接了点击的元素上，而 Cursor 只在
// 这一层生效 —— 之前把 OnClick 挂在里面的 Text 上，悬停时指针不变手，
// 看上去就是「这三个字不能点」。现在两者挂在同一层上，按下去另有底色回应。
//
// 画板给的数：胶囊 115×26、圆角 6、选中白底、未选中透明、字 11.5。
func (s *app) backendTabCell(c *ui.Context, p Palette, label string, active bool, press func()) {
	// 轨道本身 32 高、上下各 3 的衬：胶囊只有 26，不跟着轨道长满。
	// 宽度按等分吃满轨道：定宽 115 在窗口拖窄（或右栏拖窄）时会把三个字一起顶出栏外，
	// 连带把整列内容撑宽，右栏看起来就「没有自适应」。
	// MinWidth(0)：等分时不能被「进行中」这三个字的固有宽度顶住。
	cell := ui.Row(c).Grow(1).MinWidth(0).Height(TabHeight - 2*TabBarInset).Radius(RadiusChip).
		Center().ClipX().Cursor(ui.CursorPointer)
	// 底色：选中抬一层，按下去再压一层；没选中的平时透明，按住才浮起一点。
	soft, tint := ui.Transparent, p.Faint
	// 未选中是常规字重（400）；只有选中那个才加粗，画板用这一档区分。
	weight := 400
	switch {
	case active && cell.Pressed():
		soft, tint, weight = p.Pressed, p.Ink, WeightLabel
	case active:
		soft, tint, weight = p.Card, p.Ink, WeightLabel
	case cell.Pressed():
		soft = p.PressedSoft
	}
	cell.Background(soft).Children(func() {
		ui.Text(c, label).FontSize(FontSmall).FontWeight(weight).TextColor(tint)
	}).OnClick(press)
}

// modelPane 是「模型」那一栏：现在用的是谁，以及能换成谁。
//
// 只列读过目录的那几家。读不出来的一家单独列一行（只写名字），
// 免得人以为它本来就没有模型。
func (s *app) modelPane(c *ui.Context, p Palette) {
	ui.Row(c).Gap(7).AlignItems(ui.Center).Children(func() {
		ui.Text(c, "模型").FontSize(FontBodyWide).FontWeight(WeightTitle).TextColor(p.Ink)
		if s.models != nil {
			ui.Text(c, fmt.Sprintf("%d 家", len(s.models.Providers))).FontSize(FontTiny).TextColor(p.Faint)
		}
		ui.Row(c).Grow(1)
		s.collapseButton(c, p)
	})

	// 正在用的是谁，摆在最上面：换模型之前先得知道现在是什么。
	if current := s.currentModel(); current != "" {
		ui.Column(c).FillWidth().Gap(3).Padding(12).Radius(RadiusCard).
			Background(p.AccentSoft).Children(func() {
			ui.Text(c, "正在用").FontSize(FontTiny).TextColor(p.Faint)
			ui.Text(c, current).FontSize(FontBodyWide).FontWeight(WeightName).TextColor(p.Accent)
		})
	}
	if s.modelNote != "" {
		ui.Text(c, s.modelNote).FontSize(FontMini).TextColor(p.Faint)
	}
	// 这次换模型应用给谁：全员默认，或者某一位成员。
	ui.Column(c).FillWidth().Gap(5).Children(func() {
		ui.Text(c, "应用给").FontSize(FontTiny).FontWeight(WeightName).LetterSpacing(0.55).TextColor(p.Faint)
		// 换行排：栏拖窄时作用域 chip 会换到下一行，而不是一起挤出栏外。
		ui.Row(c).FillWidth().Wrap().Gap(6).Children(func() {
			s.scopeChip(c, p, "全员", "")
			if s.modelScope != "" {
				// 这一位有自己的路由时，给一条退回全场默认的路。
				if _, own := s.modelsForScope(); own {
					s.scopeChip(c, p, "跟随全员", s.modelScope+"-clear")
				}
			}
			if s.conversation != nil {
				for _, bot := range s.conversation.Bots {
					s.scopeChip(c, p, strings.TrimSpace(bot.Name), bot.ID)
				}
			}
		})
	})
	// 推理档位：路由支持什么就问什么，不摆一排猜出来的按钮。
	ui.Column(c).FillWidth().Gap(5).Children(func() {
		ui.Text(c, "推理档位").FontSize(FontTiny).FontWeight(WeightName).LetterSpacing(0.55).TextColor(p.Faint)
		switch {
		case s.efforts == nil:
			ui.Text(c, "正在读这条路由支持的档位…").FontSize(FontTiny).TextColor(p.Faint)
		case len(s.efforts.Efforts) == 0:
			ui.Text(c, "这条路由没有可选档位。").FontSize(FontTiny).TextColor(p.Faint)
		default:
			ui.Row(c).FillWidth().Wrap().Gap(6).Children(func() {
				current := s.routeForScope().ReasoningEffort
				if current == "" {
					current = s.efforts.Default
				}
				for _, effort := range s.efforts.Efforts {
					s.effortChip(c, p, effort, effort.ID == current)
				}
			})
		}
	})
	switch {
	case s.models == nil:
		ui.Text(c, "正在读能选哪些…").FontSize(FontBody).TextColor(p.Faint)
		return
	case len(s.models.Providers) == 0:
		ui.Text(c, "一家都没有读到。").FontSize(FontBody).TextColor(p.Faint)
		return
	}

	ui.Scroll(c).Grow(1).FillWidth().Children(func() {
		ui.Column(c).Gap(14).Children(func() {
			for _, group := range s.models.Providers {
				ui.Column(c).FillWidth().Gap(3).Children(func() {
					// 一家一组：组名在上，点它不切（它不是一个模型）。
					ui.Text(c, group.Name).FontSize(FontTiny).FontWeight(WeightName).
						LetterSpacing(0.55).TextColor(p.Faint)
					for _, option := range group.Models {
						s.modelRow(c, p, group.ID, option)
					}
				})
			}
			// 读不出来的那几家：只说名字。失败原因里可能有内网地址，不上屏。
			for _, failure := range s.models.Failures {
				ui.Text(c, failure.Name+" 读不出来").FontSize(FontHairline).TextColor(p.Warn)
			}
		})
	})
}

// scopeChip 是「这次换模型应用给谁」的一个选择。
func (s *app) scopeChip(c *ui.Context, p Palette, label, botID string) {
	active := s.modelScope == botID
	// 未选中也要有实底：透明背景不会进入命中链，点上去没有反应。
	soft, tint := p.Card, p.Muted
	if active {
		soft, tint = p.AccentSoft, p.Accent
	}
	ui.Row(c).PaddingX(10).PaddingY(5).Radius(RadiusChip).Background(soft).
		Cursor(ui.CursorPointer).Children(func() {
		ui.Text(c, label).FontSize(FontSmall).TextColor(tint)
	}).OnClick(func() {
		if strings.HasSuffix(botID, "-clear") {
			scope := strings.TrimSuffix(botID, "-clear")
			s.modelScope = scope
			s.switchTo(ModelChoice{})
			s.wake()
			return
		}
		if s.modelScope == botID {
			return
		}
		s.modelScope = botID
		s.modelNote = ""
		s.loadEfforts()
		s.wake()
		s.wake()
	})
}

// effortChip 是一个推理档位。点它就用这条路由 + 这个档位重新提交。
func (s *app) effortChip(c *ui.Context, p Palette, effort EffortOption, active bool) {
	soft, tint := p.Card, p.Muted
	if active {
		soft, tint = p.AccentSoft, p.Accent
	}
	ui.Row(c).PaddingX(10).PaddingY(5).Radius(RadiusChip).
		BorderWidth(1).BorderColor(p.Line).Background(soft).
		Cursor(ui.CursorPointer).Children(func() {
		ui.Text(c, effort.Name).FontSize(FontSmall).TextColor(tint)
	}).OnClick(func() {
		if s.routeForScope().ReasoningEffort == effort.ID {
			return
		}
		choice := s.routeForScope()
		if choice.Provider == "" || choice.Model == "" {
			return
		}
		choice.ReasoningEffort = effort.ID
		s.switchTo(choice)
		s.wake()
	})
}

// modelRow 是一个能选的模型。整行都能点。
func (s *app) modelRow(c *ui.Context, p Palette, provider string, option ModelOption) {
	route := s.routeForScope()
	picked := route.Provider == provider && route.Model == option.ID
	// 每行都有实底：透明行不在命中链里，点模型会没反应。
	row := ui.Row(c).FillWidth().Gap(9).AlignItems(ui.Center).PaddingX(10).PaddingY(9).
		Radius(RadiusItem).Background(p.Card).Cursor(ui.CursorPointer)
	if picked {
		row = row.Background(p.SelectedAlt)
	}
	row.Children(func() {
		// 左边一个小圆点：正在用的那个是实心强调色，其余是空的。比一个勾安静。
		ui.Row(c).Width(5).Height(5).Radius(RadiusDot).Background(func() ui.Color {
			if picked {
				return p.Accent
			}
			return p.Line
		}())
		ui.Column(c).Grow(1).Gap(2).Children(func() {
			tint := p.Muted
			if picked {
				tint = p.Ink
			}
			ui.Text(c, modelNameOf(option)).FontSize(FontBodyWide).TextColor(tint).Ellipsis("…")
			if option.Description != "" {
				ui.Text(c, option.Description).FontSize(FontHairline).TextColor(p.Faint).Ellipsis("…")
			}
		})
	})
	if picked {
		// 已经是这一个了：点了也不该再发一次换模型，那只是白跑一趟。
		return
	}
	row.OnClick(func() {
		if choice, ok := pickModel(s.models, provider, option.ID); ok {
			s.switchTo(choice)
		}
	})
}

// outputsPane 是右栏「产出」那一栏：有产出就列出来，没有就说明为什么没有。
//
// 三种情况分开说（契约 §5.4 的 state）：
// - live：逐条画。文件名 + 它是哪张票交的 + 写过几次；图片那类多一个标记。
// - empty：读得到、确实没有 —— 画原有的空态，不补假条目。
// - unavailable / 读失败：说「读不到」，绝不说「没有」。这两句话差着一整个事实。
func (s *app) outputsPane(c *ui.Context, p Palette) {
	_, name := navLabel(navOutput)
	ui.Text(c, name).FontSize(FontTitle).FontWeight(WeightTitle).TextColor(p.Ink)

	view := s.outputs
	if view == nil {
		// 还没读回来。断连时先说断连：那时候「正在读」是句假话。
		line := "正在读产出…"
		if s.outputsNote != "" {
			line = s.outputsNote
		} else if s.problem != "" {
			line = "还没连上，读不到产出"
		}
		ui.Column(c).FillWidth().Gap(6).Padding(14).Radius(RadiusCard).
			BorderWidth(1).BorderColor(p.Line).Background(p.Card).Children(func() {
			ui.Text(c, line).FontSize(FontSmall).TextColor(p.Faint)
		})
		return
	}

	if view.State != "live" || len(view.Items) == 0 {
		// empty / unavailable 都在这里。reason 是后端给的那句实话；
		// 它没给（老后端）时才退回空态原话，绝不在这里自己编一个理由。
		title, body := emptyCopy(navOutput)
		if view.Reason != "" && view.State != "empty" {
			// 读不到不是空态：标题也得跟着说「读不到」，不能借「还没有产出」的壳。
			title, body = "读不到产出", view.Reason
		} else if view.Reason != "" {
			body = view.Reason
		}
		ui.Column(c).FillWidth().Gap(6).Padding(14).Radius(RadiusCard).
			BorderWidth(1).BorderColor(p.Line).Background(p.Card).Children(func() {
			ui.Text(c, title).FontSize(FontBodyWide).FontWeight(WeightCard).TextColor(p.Muted)
			ui.Text(c, body).FontSize(FontSmall).TextColor(p.Faint)
		})
		return
	}

	// 栏头那行小结：几张文件、几张图片。用后端的 counts，不自己数一遍
	// —— 两处算法一旦分叉，人看到的数字就会和列表条数对不上。
	ui.Text(c, outputSummary(*view)).FontSize(FontSmall).TextColor(p.Faint)
	ui.Scroll(c).Grow(1).FillWidth().Children(func() {
		ui.Column(c).Gap(6).Children(func() {
			for _, item := range view.Items {
				s.outputRow(c, p, item)
			}
		})
	})
}

// outputSummary 是「产出」栏头那行字：几张文件、几张图片。都为 0 时返回空串。
func outputSummary(view OutputsView) string {
	parts := []string{}
	if view.Counts.File > 0 {
		parts = append(parts, fmt.Sprintf("%d 个文件", view.Counts.File))
	}
	if view.Counts.Image > 0 {
		parts = append(parts, fmt.Sprintf("%d 张图片", view.Counts.Image))
	}
	return strings.Join(parts, " · ")
}

// outputRow 是「产出」里的一条。画板里这是「文件名 + 一句来源」的一行，
// 没有缩略图可画：后台给的是路径，不是像素。
func (s *app) outputRow(c *ui.Context, p Palette, item OutputItem) {
	glyph := "▢"
	if item.Kind == "image" {
		glyph = "▣"
	}
	ui.Row(c).FillWidth().Padding(10).Gap(9).Radius(RadiusItem).
		BorderWidth(1).BorderColor(p.Line).Background(p.Card).AlignItems(ui.Center).Children(func() {
		ui.Text(c, glyph).FontSize(FontLabel).TextColor(p.Accent)
		ui.Column(c).Grow(1).MinWidth(0).Gap(2).Children(func() {
			// 文件名是这一行最要紧的字；路径整条放在后面当副行，太长就省略。
			ui.Text(c, item.Title).FontSize(FontBodyWide).FontWeight(WeightCard).TextColor(p.Ink).
				MaxLines(1).Ellipsis("…")
			detail := item.Path
			if item.Writes > 1 {
				detail += fmt.Sprintf(" · 写了 %d 次", item.Writes)
			}
			if item.TicketTitle != "" {
				detail += " · " + item.TicketTitle
			}
			ui.Text(c, detail).FontSize(FontHairline).TextColor(p.Faint).MaxLines(1).Ellipsis("…")
		})
	})
}

// routinesPane 是右栏「常规任务」那一栏（契约 §5.5）。
//
// 三种情况分开说（state）：
// - live：逐条画。标题、周期、谁负责、开关、上次跑 / 下次跑的时间。
// - empty：读得到、确实没有 —— 画空态，并说明这里放的是什么，不编一条假任务。
// - unavailable / 读失败：说「读不到」，绝不说「没有」。这两句话差着一整个事实。
func (s *app) routinesPane(c *ui.Context, p Palette) {
	_, name := navLabel(navRoutine)
	ui.Text(c, name).FontSize(FontTitle).FontWeight(WeightTitle).TextColor(p.Ink)

	view := s.routines
	if view == nil {
		// 还没读回来。断连时先说断连：那时候「正在读」是句假话。
		line := "正在读常规任务…"
		if s.routinesNote != "" {
			line = s.routinesNote
		} else if s.problem != "" {
			line = "还没连上，读不到常规任务"
		}
		ui.Column(c).FillWidth().Gap(6).Padding(14).Radius(RadiusCard).
			BorderWidth(1).BorderColor(p.Line).Background(p.Card).Children(func() {
			ui.Text(c, line).FontSize(FontSmall).TextColor(p.Faint)
		})
		return
	}

	if view.State != "live" || len(view.Items) == 0 {
		// empty / unavailable 都在这里。reason 是后端给的那句实话；
		// 它没给（老后端）时才退回空态原话，绝不在这里自己编一个理由。
		title, body := emptyCopy(navRoutine)
		if view.State != "empty" {
			title = "读不到常规任务"
			body = view.Reason
			if body == "" {
				body = "后端没有说原因，这一栏现在是空的"
			}
		} else if view.Reason != "" {
			body = view.Reason
		}
		ui.Column(c).FillWidth().Gap(6).Padding(14).Radius(RadiusCard).
			BorderWidth(1).BorderColor(p.Line).Background(p.Card).Children(func() {
			ui.Text(c, title).FontSize(FontBodyWide).FontWeight(WeightCard).TextColor(p.Muted)
			ui.Text(c, body).FontSize(FontSmall).TextColor(p.Faint)
			if view.State == "empty" {
				// 空态也要说清这里放的是什么、会不会自己跑：让人以为放着它就会跑，比空着更糟。
				ui.Text(c, noSchedulerNote).FontSize(FontTiny).TextColor(p.Faint)
			}
		})
		return
	}

	// 栏头那行小结：开着几条、关掉几条。用后端的 counts，不自己数一遍。
	ui.Text(c, routineSummary(*view)).FontSize(FontSmall).TextColor(p.Faint)
	ui.Scroll(c).Grow(1).FillWidth().Children(func() {
		ui.Column(c).Gap(6).Children(func() {
			for _, item := range view.Items {
				s.routineRow(c, p, item)
			}
		})
	})
	// 这一栏只列账，不装作会到点就跑：后端说 runner 是 none 时就把这句话写出来。
	// 认不出的 runner（老后端、新值）也一样说 —— 说多了只是保守，说少了是假装有人会跑。
	if view.Runner != "live" {
		ui.Text(c, noSchedulerNote).FontSize(FontTiny).TextColor(p.Faint)
	}
}

// loadMemory 读一遍右栏「记忆」。记忆会被别人写：手机上的「忘掉」、某个 worker 收尾时的结论。
// 打开这一栏和整栏刷新时都重读一次；在途时不叠第二个请求。
func (s *app) loadMemory() {
	if s.client == nil {
		s.memoryNote = "还没连上队伍，读不到记忆"
		return
	}
	if s.loadingMemory {
		return
	}
	s.loadingMemory = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		view, err := s.client.Memory(ctx, "")
		result := memoryResult{view: view}
		if err != nil {
			// 读失败与「没有记忆」是两件事：这条 note 会原样显示，别写成「还没有」。
			result.note = "读不到记忆：" + err.Error()
		}
		s.memoryCh <- result
		s.wake()
	}()
}

// forgetMemory 让队伍忘掉一条，然后重读。忘掉只翻状态，不删行 —— 所以这里没有「撤销」，
// 但账本里那条还在，说得出「它曾经这么以为了」。
func (s *app) forgetMemory(name string) {
	if s.client == nil || name == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := s.client.ForgetMemory(ctx, name); err != nil {
			s.memoryCh <- memoryResult{note: "忘掉没成功：" + err.Error()}
			s.wake()
			return
		}
		s.loadMemory()
	}()
}

// memoryPane 是右栏「记忆」那一栏（契约 §5.7）。
//
// 三种情况分开说，与产出、常规任务同一套：
// - live：逐条画。标题、正文首段、谁记得 · 来源 · 何时，以及「忘掉」。
// - empty：读得到、确实没有 —— 画空态，不编一条假记忆。
// - unavailable / 读失败：说「读不到」，绝不说「没有」。
func (s *app) memoryPane(c *ui.Context, p Palette) {
	_, name := navLabel(navMemory)
	ui.Text(c, name).FontSize(FontTitle).FontWeight(WeightTitle).TextColor(p.Ink)

	view := s.memory
	if view == nil {
		line := "正在读记忆…"
		if s.memoryNote != "" {
			line = s.memoryNote
		} else if s.problem != "" {
			line = "还没连上，读不到记忆"
		}
		ui.Column(c).FillWidth().Gap(6).Padding(14).Radius(RadiusCard).
			BorderWidth(1).BorderColor(p.Line).Background(p.Card).Children(func() {
			ui.Text(c, line).FontSize(FontSmall).TextColor(p.Faint)
		})
		return
	}

	if view.State != "live" || len(view.Items) == 0 {
		title, body := emptyCopy(navMemory)
		if view.State != "empty" {
			title = "读不到记忆"
			body = view.Reason
			if body == "" {
				body = "后端没有说原因，这一栏现在是空的"
			}
		} else if view.Reason != "" {
			body = view.Reason
		}
		ui.Column(c).FillWidth().Gap(6).Padding(14).Radius(RadiusCard).
			BorderWidth(1).BorderColor(p.Line).Background(p.Card).Children(func() {
			ui.Text(c, title).FontSize(FontBodyWide).FontWeight(WeightCard).TextColor(p.Muted)
			ui.Text(c, body).FontSize(FontSmall).TextColor(p.Faint)
		})
		return
	}

	ui.Text(c, memorySummary(*view)).FontSize(FontSmall).TextColor(p.Faint)
	ui.Scroll(c).Grow(1).FillWidth().Children(func() {
		ui.Column(c).Gap(6).Children(func() {
			for _, item := range view.Items {
				s.memoryRow(c, p, item)
			}
		})
	})
	// 脚注钉在列表下面：它说的不是某一条，是整本账的性质。
	ui.Text(c, memoryNote).FontSize(FontTiny).TextColor(p.Faint)
}

// memoryNote 是这一栏必须说的那句实话：忘掉不删行，只是不再进它下一次开口的上下文。
const memoryNote = "忘掉的条目不删，只是不再进它下一次开口时的上下文。"

// memorySummary 是栏头那行字：记得几条、忘掉几条、被替代几条。都在用的时候只写第一条。
func memorySummary(view MemoryView) string {
	parts := []string{}
	if view.Counts.Active > 0 {
		parts = append(parts, "记得 "+strconv.Itoa(view.Counts.Active)+" 条")
	}
	if view.Counts.Forgotten > 0 {
		parts = append(parts, "忘掉 "+strconv.Itoa(view.Counts.Forgotten))
	}
	if view.Counts.Superseded > 0 {
		parts = append(parts, "被替代 "+strconv.Itoa(view.Counts.Superseded))
	}
	return strings.Join(parts, " · ")
}

// memoryRow 画一条记忆。忘掉的整行压暗并标「已忘掉」：它们仍在账本里，只是不再被用。
func (s *app) memoryRow(c *ui.Context, p Palette, item MemoryItem) {
	faded := !item.Active()
	ink, body := p.Ink, p.Muted
	if faded {
		ink, body = p.Faint, p.Faint
	}
	ui.Column(c).FillWidth().Gap(4).Padding(12).Radius(RadiusCard).
		BorderWidth(1).BorderColor(p.Line).Background(p.Card).Children(func() {
		ui.Row(c).FillWidth().Children(func() {
			ui.Text(c, memoryTitle(item)).FontSize(FontBodyWide).FontWeight(WeightCard).TextColor(ink).Grow(1)
			if faded {
				ui.Text(c, "已忘掉").FontSize(FontTiny).TextColor(p.Faint)
			}
		})
		if brief := memoryBrief(item.Body); brief != "" {
			ui.Text(c, brief).FontSize(FontSmall).TextColor(body)
		}
		ui.Row(c).FillWidth().Children(func() {
			ui.Text(c, memoryDetail(item)).FontSize(FontTiny).TextColor(p.Faint).Grow(1)
			if item.Active() {
				// 忘掉不可撤销（不删行、但不再用），所以它是一次就生效的按钮，不做二次确认的假把式。
				ui.Button(c, "忘掉").OnClick(func() { s.forgetMemory(item.Name) })
			}
		})
	})
}

// memoryTitle 是这一条的抬头：描述，没有描述就用正文第一句，再没有就用名字。
func memoryTitle(item MemoryItem) string {
	if strings.TrimSpace(item.Description) != "" {
		return item.Description
	}
	if brief := memoryBrief(item.Body); brief != "" {
		return brief
	}
	return item.Name
}

// memoryBrief 取正文第一段：卡片上给的是「它记住了什么」，不是让人读文档。
func memoryBrief(body string) string {
	for _, part := range strings.Split(body, "\n\n") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			if r := []rune(trimmed); len(r) > 120 {
				return string(r[:120]) + "…"
			}
			return trimmed
		}
	}
	return ""
}

// memoryDetail 是副行：谁记得、谁写的、记于何时。缺失的项不占位。
func memoryDetail(item MemoryItem) string {
	who := item.BotID
	if who == "" {
		who = "全队"
	}
	from := "队伍记的"
	switch {
	case strings.HasPrefix(item.Origin, "person:"):
		from = "你说的"
	case strings.HasPrefix(item.Origin, "ticket:"):
		from = "工单结论"
	}
	parts := []string{who, from}
	if item.Updated > 0 {
		parts = append(parts, time.Unix(item.Updated, 0).Format("1 月 2 日"))
	}
	return strings.Join(parts, " · ")
}

// noSchedulerNote 是这一栏必须说的那句实话：账是账，没有人会按点去跑它。
const noSchedulerNote = "这些账到点不会自己跑：后端还没有调度器，逾期只是提醒。"

// routineSummary 是「常规任务」栏头那行字：开着几条、关掉几条。都为 0 时返回空串。
func routineSummary(view RoutinesView) string {
	parts := []string{}
	if view.Counts.Enabled > 0 {
		parts = append(parts, fmt.Sprintf("%d 条开着", view.Counts.Enabled))
	}
	if view.Counts.Paused > 0 {
		parts = append(parts, fmt.Sprintf("%d 条关着", view.Counts.Paused))
	}
	return strings.Join(parts, " · ")
}

// cycleName 是周期的中文说法。认不出的原词原样显示：不猜成「每天」。
func cycleName(cycle string) string {
	switch cycle {
	case "hourly":
		return "每小时"
	case "daily":
		return "每天"
	case "weekly":
		return "每周"
	default:
		return cycle
	}
}

// routineRow 是「常规任务」里的一条：标题一行，周期 + 负责人 + 开关一行，上次 / 下次一行。
//
// 「上次跑」没有就是没有 —— 只写「还没跑过」，不填日期；「下次跑」由后端按周期算，
// 逾期时写「该跑了」而不是「下一次」，因为后端确实没有人会去跑它。
func (s *app) routineRow(c *ui.Context, p Palette, item RoutineItem) {
	ui.Column(c).FillWidth().Padding(10).Gap(4).Radius(RadiusItem).
		BorderWidth(1).BorderColor(p.Line).Background(p.Card).Children(func() {
		ui.Row(c).FillWidth().Gap(6).AlignItems(ui.Center).Children(func() {
			// 标题占满剩下的宽度再省略：不定宽、不裁，长标题会把「逾期」顶出这一行。
			ui.Column(c).Grow(1).MinWidth(0).ClipX().Children(func() {
				ui.Text(c, item.Title).FontSize(FontBodyWide).FontWeight(WeightCard).TextColor(p.Ink).
					MaxLines(1).Ellipsis("…")
			})
			if item.Overdue && item.Enabled {
				ui.Text(c, "逾期").FontSize(FontHairline).TextColor(p.Warn)
			}
		})
		head := cycleName(item.Cycle)
		if item.BotID != "" {
			head += " · " + item.BotID + " 负责"
		}
		if !item.Enabled {
			head += " · 已关掉"
		}
		ui.Text(c, head).FontSize(FontHairline).TextColor(p.Faint).MaxLines(1).Ellipsis("…")
		// 上次：有才写日期；没有就直说「还没跑过」。
		ran := "还没跑过"
		if when := routineTime(item.LastRun); when != "" {
			ran = "上次 " + when
		}
		// 「下次」这一格：时间读不出来就整格不说，别把原始串甩给人看；
		// 关掉的那条不算「下一次」，否则关着也像随时会跑。
		nearest := ""
		if when := routineTime(item.NextRun); when != "" {
			nearest = "按周期算下一次 " + when
			if item.Overdue && item.Enabled {
				nearest = "该跑了（" + when + "）"
			}
		}
		if !item.Enabled {
			nearest = "关着，不算下一次"
		}
		ui.Text(c, routineWhenLine(ran, nearest)).FontSize(FontHairline).TextColor(p.Faint).MaxLines(1).Ellipsis("…")
	})
}

// routineWhenLine 把「上次」「下一次」拼成一行。两截都不说时（时间都读不出来）返回空串，
// 由调用方整行不画 —— 一行只有「 · 」比没有更难读。
func routineWhenLine(ran, nearest string) string {
	switch {
	case ran == "" && nearest == "":
		return ""
	case nearest == "":
		return ran
	case ran == "":
		return nearest
	default:
		return ran + " · " + nearest
	}
}

// routineTime 把后端的时间裁成「01-02 15:04」；认不出来就返回空串，别把原始串甩给人看。
func routineTime(at string) string {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if parsed, err := time.Parse(layout, at); err == nil {
			return parsed.Local().Format("01-02 15:04")
		}
	}
	return ""
}

// resultBar 是挂在一条消息下面那行「✓ 两张图片已放进产出」（契约 §5.4 末节）。
//
// 只有这条消息带 ticket_ref、且那张票确实有产出时才画。没有票号就不画 ——
// 按时间猜一张票，等于把 A 的成果挂到 B 的话下面。读不到也不画：
// 结果条只在「有事发生」时出现，把故障画成一条成果是最糟的一种假。
func (s *app) resultBar(c *ui.Context, p Palette, message Message) {
	ticket := strings.TrimSpace(message.ticketRef())
	if ticket == "" {
		return
	}
	// 没读过就先要一份；读完之前不画，免得先闪一条空的再变成有内容的。
	// 记着「试过了」：结果条按票缓存，读不到的那张不会每帧重发请求。
	if _, tried := s.perTicket[ticket]; !tried {
		s.loadTicketOutputs(ticket)
		return
	}
	view := s.perTicket[ticket]
	if view == nil || view.State != "live" || len(view.Items) == 0 {
		return
	}
	line := outputResultLine(*view)
	if line == "" {
		return
	}
	ui.Row(c).PaddingX(12).PaddingY(9).Gap(8).Radius(RadiusItem).
		BorderWidth(1).BorderColor(p.Line).Background(p.Card).AlignItems(ui.Center).Children(func() {
		ui.Text(c, "✓").FontSize(FontLabel).TextColor(p.Accent)
		ui.Text(c, line).FontSize(FontSmall).TextColor(p.Muted)
	})
}

// outputResultLine 是结果条上那句话：「N 张图片已放进产出」/「N 个文件已放进产出」。
// 两类都有时说全，只数一类时只说那一类；一条都没有就返回空串（调用方据此不画）。
func outputResultLine(view OutputsView) string {
	file, image := view.Counts.File, view.Counts.Image
	switch {
	case file > 0 && image > 0:
		return fmt.Sprintf("%d 个文件 · %d 张图片已放进产出", file, image)
	case image > 0:
		return fmt.Sprintf("%d 张图片已放进产出", image)
	case file > 0:
		return fmt.Sprintf("%d 个文件已放进产出", file)
	default:
		return ""
	}
}

// currentModel 是「现在用的是谁」的一句话。两个来源：目录说过的（刚换完最准），
// 以及时间线带回来的那个（还没读过目录时用它）。
func (s *app) currentModel() string {
	if choice := s.routeForScope(); choice.Model != "" {
		line := choice.Model
		if choice.Provider != "" && choice.Provider != choice.Model {
			line += " · " + choice.Provider
		}
		if choice.ReasoningEffort != "" {
			line += " · " + choice.ReasoningEffort
		}
		return line
	}
	if s.conversation != nil && s.conversation.Model != "" {
		return s.conversation.Model
	}
	return ""
}

func (s *app) taskCard(c *ui.Context, p Palette, task Task) {
	// 三种状态三种语气：等你决定是赭、失败是红、其余是普通卡。
	soft, tint, edge := p.Card, p.Ink, p.Line
	switch {
	case task.NeedsPerson != "":
		soft, tint, edge = p.WarnSoft, p.Warn, p.WarnEdge
	case task.NeedsPerson == "failed":
		soft, tint, edge = p.DangerSoft, p.Danger, p.DangerEdge
	}
	// 整张卡就是入口：按在标题、状态行、空白处都算按在这一张上。
	// 原来只有「看它怎么做 →」那七个字接得住，卡片其余部分是死的 —— 看着像能点，
	// 按下去什么都不发生。指针在卡上时换手型，先把「这里能按」说清楚。
	ticketID := task.ID
	opened := s.openTicket == ticketID
	// 画板：卡片宽 360、内边距 25（1089 − 1064）、圆角 10。
	card := ui.Column(c).FillWidth().PaddingX(25).PaddingY(12).Gap(4).Radius(RadiusCard).
		Background(soft).BorderWidth(1).BorderColor(edge).Cursor(ui.CursorPointer)
	card.Children(func() {
		// 标题行：左边一个 5px 的状态点，右边标题。画板用这个点代替任何色块，
		// 一列卡扫一眼就能看出哪张在跑、哪张卡住、哪张失败了。
		ui.Row(c).FillWidth().Gap(7).AlignItems(ui.Start).Children(func() {
			// 点对齐到第一行字的中线附近：margin-top 5 是画板给的那个值。
			ui.Column(c).Width(5).Height(5).Radius(RadiusDot).Margin(0, 5, 0, 0).
				Background(s.taskDotColor(p, task))
			ui.Text(c, task.Title).FontSize(FontBodyWide).FontWeight(WeightCard).
				LineHeight(1.45).TextColor(tint).Grow(1).MinWidth(0)
		})

		// 状态行：谁在做 + 第几步。设计稿把这两件事压在第二行，
		// 并且缩进 17 避开上面那个状态点（卡片左边距 25 → 状态行 42）。
		detail := stateWord(task.State)
		if task.BotID != "" {
			detail += " · " + s.nameOf(task.BotID)
		}
		if step := s.stepOf(task); step != "" {
			detail += " · " + step
		}
		ui.Row(c).FillWidth().PaddingStart(12).Children(func() {
			ui.Text(c, detail).FontSize(FontTiny).TextColor(p.Muted)
		})
		// 进度条：画板里 2px 圆角、2px 高，但只在有「共几步」这个分母时才画。
		// 分母来自后端下发的计划（worker 自己的待办清单）；没有计划就不画，
		// 宁可空着也不画一根永远停在 100% 的假条。
		//
		// 零步走完时只画轨道、不画那一格强调色：宽度 0 的格子有些引擎仍会画出一个点，
		// 看上去像「已经走了一步」。
		if done, total := s.progressOf(task); total > 0 {
			filled := done > 0
			ui.Row(c).FillWidth().PaddingStart(12).Height(3).Radius(RadiusTiny).
				Background(p.Track).Children(func() {
				if !filled {
					return
				}
				ui.Row(c).WidthPercent(float32(done) / float32(total) * 100).FillHeight().
					Radius(RadiusTiny).Background(p.Accent)
			})
		}

		if task.NeedsPerson != "" {
			// 等的原因要写明，否则「等你」不告诉人要等什么。
			ui.Row(c).FillWidth().PaddingStart(12).Children(func() {
				ui.Text(c, task.NeedsPerson).FontSize(FontTiny).TextColor(p.Warn)
			})
			if waited := s.waitedFor(task); waited != "" {
				ui.Row(c).FillWidth().PaddingStart(12).Children(func() {
					ui.Text(c, "卡在等你 · 等你 "+waited).FontSize(FontHairline).TextColor(p.Warn)
				})
			}
		}
		if task.Retryable {
			// 失败的票得有一条出路，否则只能干看着。画板里这一行右对齐。
			ticketID := task.ID
			ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
				ui.Row(c).Grow(1)
				// 这一行自己接点击：重试是另一件事，不能让它顺手把卡片也展开了。
				ui.Text(c, "重试 →").FontSize(FontTiny).TextColor(p.Accent).Cursor(ui.CursorPointer).OnClick(func() {
					go func() {
						ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
						defer cancel()
						if err := s.client.Retry(ctx, ticketID); err != nil {
							// 重试失败只影响这张票，不能写成全局断连把发送也锁住。
							s.retryErrorCh <- err.Error()
							s.wake()
							return
						}
						s.arrived <- nil
						s.wake()
						s.refresh()
					}()
				})
			})
		}
		// 执行经过：整张卡都能展开，收起来再点一次。
		//
		// 这一行只是把「点哪儿都行」写出来给人看，自己不再接点击 ——
		// 接了就成了卡里的一块死区：点在字上有效，点在字旁边没效。
		arrow := "看它怎么做 →"
		if opened {
			arrow = "收起 ↑"
		}
		// 画板里这一行是「左边一句现状、右边一个入口」，入口靠右贴着卡边。
		// 左边那句放这张票最后发生的动作（有的话），没有就让它空着，
		// 不编一句「正在处理」来充数。
		ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(8).Children(func() {
			if opened {
				if err := s.workError; err != "" {
					ui.Text(c, err).FontSize(FontHairline).TextColor(p.Danger)
				}
			} else if hint := s.lastStepHint(task); hint != "" {
				ui.Text(c, hint).FontSize(FontTiny).TextColor(p.Hint).MaxLines(1).Ellipsis("…")
			}
			ui.Row(c).Grow(1)
			ui.Text(c, arrow).FontSize(FontTiny).TextColor(p.Accent)
		})

		// 读到的每一步：谁做的、做了什么、成没成。层级靠缩进。
		if opened {
			for _, step := range s.stepsFor(ticketID) {
				s.workRow(c, p, step)
			}
		}
	})
	card.OnClick(func() { s.openWork(ticketID) })
}

// openWork 去读一张票的执行经过。同一时刻只读一张，所以先记下是哪张。
func (s *app) openWork(ticketID string) {
	if s.openTicket == ticketID {
		// 再点一次是收起来。
		s.openTicket, s.workSteps = "", nil
		return
	}
	s.openTicket, s.workSteps, s.workError = ticketID, nil, ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		steps, err := s.client.Work(ctx, ticketID)
		s.steps <- workResult{ticket: ticketID, steps: steps, err: err}
		s.wake()
	}()
}

// loadOutputs 读一遍右栏「产出」。整栏读不到只说这一栏的事，不冒充断连。
// 在途时不再发第二个：连点这一格不该叠出几个一模一样的请求。
func (s *app) loadOutputs() {
	if s.client == nil || s.loadingOutputs {
		return
	}
	s.loadingOutputs = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		view, err := s.client.Outputs(ctx, "")
		result := outputsResult{view: view}
		if err != nil {
			// 读失败与「没有产出」是两件事：这条 note 会原样显示，别写成「还没有产出」。
			result.note = "读不到产出：" + err.Error()
		}
		s.outputsCh <- result
		s.wake()
	}()
}

// loadRoutines 读一遍右栏「常规任务」。账本是一条条主人写下的账，不随工单变，
// 但「上次跑 / 下次跑」是按时间算的，所以打开这一栏与整栏刷新时都重读一次。
// 在途时不再发第二个：连点这一格不该叠出几个一样的请求。
func (s *app) loadRoutines() {
	if s.client == nil {
		// 没有客户端就发不出请求：那就直说，别让这一栏永远停在「正在读」。
		s.routinesNote = "还没连上队伍，读不到常规任务"
		return
	}
	if s.loadingRoutine {
		return
	}
	s.loadingRoutine = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		view, err := s.client.Routines(ctx)
		result := routinesResult{view: view}
		if err != nil {
			// 读失败与「没有常规任务」是两件事：这条 note 会原样显示，别写成「还没有」。
			result.note = "读不到常规任务：" + err.Error()
		}
		s.routinesCh <- result
		s.wake()
	}()
}

// loadTicketOutputs 读某一张票的产出，给消息下面那条结果条用。
// 同一张票只读一次：结果条按票号缓存，翻上翻下不该每帧都发一个请求。
func (s *app) loadTicketOutputs(ticket string) {
	if s.client == nil || ticket == "" {
		return
	}
	if s.perTicket == nil {
		s.perTicket = map[string]*OutputsView{}
	}
	if s.loadingTicket == nil {
		s.loadingTicket = map[string]bool{}
	}
	if _, seen := s.perTicket[ticket]; seen {
		return
	}
	// 这一张已经发过请求、还没回来：别再发第二个。
	if s.loadingTicket[ticket] {
		return
	}
	s.loadingTicket[ticket] = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		view, err := s.client.Outputs(ctx, ticket)
		// 读失败就是「这张没有可画的产出」：结果条不画，也不冒充断连。
		// 具体为什么读不到，右栏「产出」那一栏会说（它读的是同一份接口）。
		if err != nil {
			view = nil
		}
		s.ticketOut <- ticketOutputsResult{ticket: ticket, view: view}
		s.wake()
	}()
}

// loadModels 重读一遍能切成什么。读失败说实话，不把上一次的目录当这一次的。
func (s *app) loadModels() {
	if s.client == nil {
		return
	}
	s.modelNote = "正在读模型…"
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		catalog, err := s.client.Models(ctx)
		if err != nil {
			// 模型目录读不到不是连接故障：不能写进 s.problem，那会把发送也一起锁死。
			s.modelError <- "读不到模型目录：" + err.Error()
			s.wake()
			return
		}
		s.modelList <- catalog
		s.wake()
	}()
}

// switchTo 换模型。选中的那一个立刻标出来，真换成了再进 applyModel 落定。
func (s *app) switchTo(choice ModelChoice) {
	if s.client == nil {
		return
	}
	scope := s.modelScope
	s.modelNote = "正在换…"
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := s.client.SwitchModel(ctx, choice, scope); err != nil {
			// 换模型失败只影响模型栏，不该冒充断连、更不该锁住输入框。
			s.modelError <- err.Error()
			s.wake()
			return
		}
		s.modelSwitched <- modelSwitchResult{choice: choice, botID: scope}
		s.wake()
	}()
}

// loadEfforts 问当前作用域那条路由支持哪些推理档位。换作用域/换模型后都要重读。
func (s *app) loadEfforts() {
	route := s.routeForScope()
	if s.client == nil || route.Provider == "" || route.Model == "" {
		s.efforts = nil
		return
	}
	s.efforts = nil
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		view, err := s.client.Efforts(ctx, route.Provider, route.Model)
		if err != nil {
			s.modelError <- "读不到推理档位：" + err.Error()
			s.wake()
			return
		}
		s.effortsCh <- view
		s.wake()
	}()
}

// modelsForScope 报告这个成员有没有自己的一条路由。
func (s *app) modelsForScope() (ModelChoice, bool) {
	if s.models == nil || s.modelScope == "" {
		return ModelChoice{}, false
	}
	choice, ok := s.models.BotModels[s.modelScope]
	return choice, ok && choice.Model != ""
}

// routeForScope 是这个作用域此刻在用的模型：成员有自己的路由用它，否则回到全场默认。
func (s *app) routeForScope() ModelChoice {
	if s.models != nil {
		if s.modelScope != "" {
			if choice, ok := s.models.BotModels[s.modelScope]; ok {
				return choice
			}
		}
		if s.models.Current != nil {
			return *s.models.Current
		}
	}
	return ModelChoice{}
}

// applyModel 把「现在用的是谁」改成刚换上的那一个。
func (s *app) applyModel(result modelSwitchResult) {
	if s.models == nil {
		s.models = &ModelCatalog{}
	}
	chosen := result.choice
	if result.botID != "" && chosen.Model == "" {
		// 空模型 = 跟随全员：删掉这一位自己的路由。
		delete(s.models.BotModels, result.botID)
	} else if result.botID != "" {
		if s.models.BotModels == nil {
			s.models.BotModels = map[string]ModelChoice{}
		}
		s.models.BotModels[result.botID] = chosen
	} else {
		s.models.Current = &chosen
		if s.conversation != nil {
			s.conversation.Model = chosen.Model
		}
	}
	s.modelNote = ""
	s.loadEfforts()
}

// shownTasks 是当前标签下的工单。
func (s *app) shownTasks() []Task {
	if s.conversation == nil {
		return nil
	}
	out := make([]Task, 0, len(s.conversation.Tasks))
	for _, task := range s.conversation.Tasks {
		needsPerson := task.NeedsPerson != ""
		switch s.backendTab {
		case 1: // 待你
			if needsPerson {
				out = append(out, task)
			}
			continue
		case 2: // 已完成
			if !task.Open {
				out = append(out, task)
			}
			continue
		}
		// 进行中：还没结束，且不是「等你决定」的。
		if task.Open && !needsPerson {
			out = append(out, task)
		}
	}
	return out
}

// progressOf 是这张票走到第几步 / 共几步。
//
// 分子分母都来自后端下发的计划（worker 自己写的待办清单）：StepsDone 与 TotalSteps。
// 不拿「读到几步」当分子：那张过程只在卡片展开时才读，收起来的卡会显示 0，
// 而且它记的是「有几次汇报」，不是「计划里走完了几步」—— 两回事。
//
// 返回 (0, 0) 表示「算不出来」：这张票没有计划（后端没下发 TotalSteps），
// 没有分母就不画进度条，宁可空着也不画一根永远 100% 的假条。
func (s *app) progressOf(task Task) (int, int) {
	if task.TotalSteps <= 0 {
		return 0, 0
	}
	done := task.StepsDone
	if done < 0 {
		done = 0
	}
	// 走完的步数不可能超过总数：后端若给了个自相矛盾的值（计划改小了），进度条也不该溢出。
	if done > task.TotalSteps {
		done = task.TotalSteps
	}
	return done, task.TotalSteps
}

// stepOf 从后端的计划里取「第几步」，没有就说没有。
//
// 这一行走在概览行上，不靠卡片展开：计划随票一起下发，不需要为它多拉一次经过。
// 没有计划时不编一句「第 N 步」出来 —— 那个 N 没有出处。
func (s *app) stepOf(task Task) string {
	done, total := s.progressOf(task)
	if total <= 0 {
		return ""
	}
	// 已经走完的按总步数算：卡片停在「共 3 步」上，而不是「第 2 步」。
	step := done
	if step > 0 {
		return fmt.Sprintf("第 %d 步 / 共 %d 步", step, total)
	}
	return fmt.Sprintf("共 %d 步", total)
}

// stepsFor 是这个 app 上记着的某张票的经过。同一时刻只展示一张。
func (s *app) stepsFor(ticketID string) []WorkStep {
	if s.openTicket != ticketID {
		return nil
	}
	return s.workSteps
}

// waitedFor 把等待时长说成「8 分钟」这种人话。
func (s *app) waitedFor(task Task) string {
	if task.UpdatedAt == "" {
		return ""
	}
	at, err := time.Parse(time.RFC3339, task.UpdatedAt)
	if err != nil {
		return ""
	}
	d := time.Since(at)
	if d < time.Minute {
		return "刚一会儿"
	}
	if d < time.Hour {
		return fmt.Sprintf("%d 分钟", int(d.Minutes()))
	}
	return fmt.Sprintf("%d 小时", int(d.Hours()))
}

func (s *app) agentRow(c *ui.Context, p Palette, node AgentNode, depth int) {
	if depth > 6 {
		// 再深就不画了：缩进已经读不出层级，而接口那边也最多走 8 层。
		return
	}
	mark := "·"
	tint := p.Ink
	if agentDone(node.State) {
		mark, tint = "✓", p.Faint
	}
	// 有标签就用标签：`a1-1` 这种内部编号对人没有意义。
	name := node.Label
	if name == "" {
		name = node.ID
	}
	ui.Text(c, strings.Repeat("  ", depth)+mark+" "+name).FontSize(FontHairline).TextColor(tint)
	for _, child := range node.Children {
		s.agentRow(c, p, child, depth+1)
	}
}

// pairing 是后台栏底下那一块：这台电脑连上队伍，之后手机也能连。
//
// 点一下全自动：本机出一支码，立刻用码换凭据，凭据写进 ~/.config 后下次启动直接读。
// 不再要求人去别处看图念数字，也不再要求先设三个环境变量。
func (s *app) pairing(c *ui.Context, p Palette) {
	// 打开这一栏就读一次设备清单：配过谁、谁还能进来，是这一块的另一半。
	s.loadDevices()
	// 第一行：手机状态 + 一个按钮。配对不是右栏的主角，模型列表要留出高度。
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Column(c).Grow(1).Gap(2).Children(func() {
			ui.Text(c, "手机").FontSize(FontHairline).Bold().TextColor(p.Muted)
			note := s.pairingNote
			if note == "" {
				note = "这一台与队伍配一次，之后两边都免配置。"
			}
			ui.Text(c, note).FontSize(FontMini).TextColor(p.Faint)
		})
		ui.Row(c).PaddingX(10).PaddingY(6).Radius(RadiusChip).Background(p.Card).
			BorderWidth(1).BorderColor(p.Line).Cursor(ui.CursorPointer).Children(func() {
			ui.Text(c, "配对手机").FontSize(FontSmall).TextColor(p.Muted)
		}).OnClick(s.pairNow)
	})
	// 已配对的设备：每台一行，右端一个「撤掉」。手机丢了就用它 —— 之前这份清单只在
	// 客户端里有方法、界面上从来没露过面，等于没有。
	if s.devicesNote != "" {
		ui.Text(c, s.devicesNote).FontSize(FontMini).TextColor(p.Danger)
	}
	// 导出备份：一份配置与历史，落到桌面上，人可以自己收着。
	ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(8).PaddingY(4).Children(func() {
		label := "导出备份"
		if s.exporting {
			label = "导出中…"
		}
		ui.Row(c).PaddingX(10).PaddingY(5).Radius(RadiusChip).Background(p.Card).
			BorderWidth(1).BorderColor(p.Line).Cursor(ui.CursorPointer).Children(func() {
			ui.Text(c, label).FontSize(FontMini).TextColor(p.Muted)
		}).OnClick(s.exportRecords)
	})
	if s.exportNote != "" {
		ui.Text(c, s.exportNote).FontSize(FontMini).TextColor(p.Faint).NoWrap().Ellipsis("…")
	}
	for _, device := range s.devices {
		device := device
		ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(8).PaddingY(5).Children(func() {
			ui.Column(c).Grow(1).MinWidth(0).Gap(1).Children(func() {
				ui.Text(c, device.Name).FontSize(FontMini).TextColor(p.Muted).NoWrap().Ellipsis("…")
				detail := device.Platform
				if device.PairedAt != "" {
					if at, err := time.Parse(time.RFC3339, device.PairedAt); err == nil {
						detail += " · " + at.Local().Format("01-02 15:04")
					}
				}
				ui.Text(c, detail).FontSize(FontMini).TextColor(p.Faint).NoWrap()
			})
			label := "撤掉"
			if s.revoking[device.DeviceID] {
				label = "撤销中…"
			}
			ui.Row(c).PaddingX(8).PaddingY(4).Radius(RadiusChip).Background(p.Card).
				BorderWidth(1).BorderColor(p.Line).Cursor(ui.CursorPointer).Children(func() {
				ui.Text(c, label).FontSize(FontMini).TextColor(p.Danger)
			}).OnClick(func() { s.revokeDevice(device.DeviceID) })
		})
	}
}

// pairNow 走一次配对；按钮那一行只管外观，动作在这里。
func (s *app) pairNow() {
	{
		if s.target.LanPort == 0 {
			s.pairingNote = "没找到在跑的队伍：先把它启动起来再点"
			return
		}
		s.pairingNote = "正在配对…"
		// 目标在启动时定下、之后不再改，goroutine 里读它是安全的。
		target := s.target
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			// Electron 内置 dsh 的网页端口是启动时随机分配的，profile 里没有；
			// 从 lan 端口的进程反查它，找不到才用 profile 里写的那个。
			target.WebPort = webPortNear(target.LanPort, target.WebPort)
			credential, err := pairDevice(ctx, target, defaultDeviceID, "crew-desktop", "macos", nil)
			if err != nil {
				// 配对失败的原因（码过期、策略拒绝、队伍没起来）原样交回去，不吞成一个「失败」。
				s.pairFailed <- err.Error()
				s.wake()
				return
			}
			s.paired <- credential
			s.wake()
		}()
	}
}

func (s *app) statusLine() string {
	status := s.conversation.Status
	switch {
	case status.Paused:
		return "已暂停"
	case status.Ready():
		return "就绪 · 队列空闲"
	default:
		return "状态：" + status.Runtime
	}
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

// workRow 画一步执行经过：时刻、做了什么的字，左边一个小圆点区分种类。
//
// 种类只决定点的颜色，不改文字 —— 读的人要的是「它做了什么」，
// 不是一串状态码。
func (s *app) workRow(c *ui.Context, p Palette, step WorkStep) {
	dot := p.Faint
	switch step.Kind {
	case "tool":
		dot = p.Accent
	case "error":
		dot = p.Danger
	case "say":
		dot = p.Warn
	}
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Start).PaddingY(3).Children(func() {
		ui.Row(c).Width(5).Height(5).Radius(RadiusDot).Background(dot)
		ui.Column(c).Grow(1).Gap(2).Children(func() {
			ui.Text(c, step.Text).FontSize(FontSmall).TextColor(p.Muted)
			if step.At != "" {
				ui.Text(c, clockOf(step.At)).FontSize(FontHairline).TextColor(p.Faint)
			}
		})
	})
}

// clockOf 把 ISO 时刻压成 HH:MM。读经过时看的是先后顺序，日期在这里是噪音。
func clockOf(at string) string {
	// 后端时间戳是 UTC 的 toISOString；直接截字符串会在东八区差出 8 小时。
	// 与消息时间用同一个解析、同一个本地化。
	if shown := shortTime(at); shown != "" {
		return shown
	}
	if i := strings.IndexByte(at, 'T'); i >= 0 && len(at) >= i+6 {
		return at[i+1 : i+6]
	}
	return at
}

// botEditor 是改人设的那一层：名字、人设、保存/取消。
//
// 盖在整扇窗上（Absolute + Fill），背后压一层半透明底，点击底板等于取消。
// 写的是真接口：成功才关，失败原样写在层里，不假装保存过。
func (s *app) botEditor(c *ui.Context, p Palette) {
	bot := s.botNamed(s.editingBot)
	ui.Column(c).Absolute().FillWidth().FillHeight().Left(0).Top(0).
		Background(p.Surface.Alpha(0.55)).
		Center().Children(func() {
		ui.Column(c).Width(420).Gap(11).Padding(20).Radius(RadiusFolder).
			Background(p.Card).BorderWidth(1).BorderColor(p.Line).Children(func() {
			ui.Text(c, "改这一位").FontSize(FontHeader).FontWeight(WeightTitle).TextColor(p.Ink)
			ui.Text(c, "bot/"+s.editingBot).FontSize(FontMini).TextColor(p.Faint)

			ui.Text(c, "名字").FontSize(FontTiny).FontWeight(WeightName).TextColor(p.Faint)
			ui.TextInput(c, &s.botName).FillWidth().FontSize(FontBodyWide).
				TextColor(p.Ink).CaretColor(p.Accent).SelectionColor(p.AccentSoft).Background(p.Card)

			ui.Text(c, "人设（他怎么说话、擅长什么）").FontSize(FontTiny).FontWeight(WeightName).TextColor(p.Faint)
			ui.Column(c).FillWidth().Height(96).Padding(9).Radius(RadiusItem).
				BorderWidth(1).BorderColor(p.Line).Background(p.Surface).Children(func() {
				ui.TextInput(c, &s.botPersona).FillWidth().FontSize(FontBodyWide).
					TextColor(p.Ink).CaretColor(p.Accent).SelectionColor(p.AccentSoft).Background(p.Card)
			})
			ui.Text(c, "留空就是没有特别的人设，他会照队伍默认的方式说话。").
				FontSize(FontMini).TextColor(p.Faint)

			if s.botError != "" {
				ui.Row(c).FillWidth().Padding(8).Radius(RadiusItem).Background(p.DangerSoft).Children(func() {
					ui.Text(c, "没改成功："+s.botError).FontSize(FontMini).TextColor(p.Danger)
				})
			}
			ui.Row(c).FillWidth().Gap(7).Children(func() {
				ui.Row(c).PaddingX(14).PaddingY(9).Radius(RadiusButton).Background(p.Card).
					BorderWidth(1).BorderColor(p.Line).Center().Cursor(ui.CursorPointer).
					OnClick(func() { s.editingBot = ""; s.botError = "" }).Children(func() {
					ui.Text(c, "取消").FontSize(FontBodyWide).TextColor(p.Muted)
				})
				ui.Row(c).Grow(1).Height(36).Radius(RadiusButton).Background(p.Accent).
					Center().Cursor(ui.CursorPointer).OnClick(s.saveBot).Children(func() {
					label := "保存"
					if s.botSaving {
						label = "保存中…"
					}
					ui.Text(c, label).FontSize(FontBodyWide).FontWeight(WeightName).TextColor(p.AccentInk)
				})
			})
		})
	})
	_ = bot
}

// botNamed 按 id 找花名册里的那一位；找不到返回零值（编辑层照样能开，只是名字空着）。
func (s *app) botNamed(id string) BotCard {
	if s.conversation == nil {
		return BotCard{ID: id}
	}
	for _, bot := range s.conversation.Bots {
		if bot.ID == id {
			return bot
		}
	}
	return BotCard{ID: id}
}

// loadDevices 读一次已配对的设备。只读一次：它是一份快照，不是每秒要刷的状态。
func (s *app) loadDevices() {
	if s.client == nil || s.devicesTried {
		return
	}
	s.devicesTried = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		list, err := s.client.Devices(ctx)
		s.devicesCh <- devicesResult{list: list, err: err}
		s.wake()
	}()
}

// revokeDevice 撤掉一台设备。撤掉之后它那份凭据立刻作废，手机丢了就用它。
func (s *app) revokeDevice(deviceID string) {
	if s.client == nil || s.revoking[deviceID] {
		return
	}
	if s.revoking == nil {
		s.revoking = map[string]bool{}
	}
	s.revoking[deviceID] = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.client.Revoke(ctx, deviceID); err != nil {
			s.devicesCh <- devicesResult{err: err}
			s.wake()
			return
		}
		// 撤成功之后重读一遍：清单要和后端一致，不能靠本地删一行猜。
		list, err := s.client.Devices(ctx)
		s.devicesCh <- devicesResult{list: list, err: err}
		s.wake()
	}()
}

// firstStep 是空态里的引导一行：一个序号 + 一句话。
func (s *app) firstStep(c *ui.Context, p Palette, step, text string) {
	ui.Row(c).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Column(c).Width(18).Height(18).Radius(RadiusDot).Background(p.AccentSoft).
			AlignItems(ui.Center).Justify(ui.Center).Children(func() {
			ui.Text(c, step).FontSize(FontHairline).TextColor(p.Accent)
		})
		ui.Text(c, text).FontSize(FontBody).TextColor(p.Faint)
	})
}

// exportRecords 导一份备份到 ~/Desktop（没有 Desktop 就落主目录）。
//
// 导出走管理面，只在本机可用：备份是一整份配置与历史，不该能从手机那一侧拉走。
// 写不成就照实说，不假装存过。
func (s *app) exportRecords() {
	if s.client == nil || s.exporting {
		return
	}
	s.exporting = true
	s.exportNote = ""
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		raw, err := s.client.ExportRecords(ctx)
		if err != nil {
			s.exportCh <- exportResult{err: err}
			s.wake()
			return
		}
		home, homeErr := os.UserHomeDir()
		if homeErr != nil {
			s.exportCh <- exportResult{err: homeErr}
			s.wake()
			return
		}
		dir := filepath.Join(home, "Desktop")
		if info, statErr := os.Stat(dir); statErr != nil || !info.IsDir() {
			dir = home
		}
		name := "crew-backup-" + time.Now().Format("20060102-150405") + ".json"
		path := filepath.Join(dir, name)
		if writeErr := os.WriteFile(path, raw, 0o600); writeErr != nil {
			s.exportCh <- exportResult{err: writeErr}
			s.wake()
			return
		}
		s.exportCh <- exportResult{path: path}
		s.wake()
	}()
}
