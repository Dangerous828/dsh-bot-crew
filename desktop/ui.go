// 队伍对话的窗口：左边花名册，中间对话，右边后台。
package main

import (
	"context"
	"fmt"
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
	sent chan string
	tree    chan []AgentNode
	paired  chan Credential
	// 配对失败单独一条：它不该写成「连不上队伍」，那是连接问题，不是配对问题。
	pairFailed chan string
	steps   chan workResult
	// modelList 是模型目录回来了；modelSwitched 是换成功了。
	// 两份分开：读失败和换失败要说的不是一句话。
	modelList     chan *ModelCatalog
	modelSwitched chan ModelChoice
	// modelError 与 failed 分开：模型目录/切换失败只该写在模型栏里。
	modelError chan string
	// screenNoteCh 是屏幕接口的返回：它是「暂时没有」，不是断连。
	screenNoteCh chan string
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
	// screenNote 是「看它的屏幕」给出的实话（后端还没有画面源），与连接故障分开显示。
	screenNote string
	// selectedBot 是左栏点中的那位。点它既是选人，也是回到对话主界面。
	selectedBot string
	// sidebarClosed 是左栏收起。零值 false = 默认展开，和以前一样。
	sidebarClosed bool
	// services 是 mygo 的窗口服务，后台 goroutine 靠它请求重画。
	services ui.Services
	// screenReady 是「看它的屏幕」能不能用。后端还没有这条路，先摆着。
	screenReady bool
	// backendTab 是右栏「后台」那一档里当前在看哪一页：进行中 / 待你 / 已完成。
	backendTab int
	// navTab 是左栏点开的是哪一项。默认停在「后台」，所以打开窗口看到的就是那一栏。
	navTab navItem
	// backendOpen 是右栏在不在。「后台」再点一次收起来，中间的对话就占满整扇窗。
	backendOpen bool

	// models 是能切成什么。没读过就是 nil，界面上说「正在读」而不是「没有」。
	models      *ModelCatalog
	modelsError string
	modelNote   string

	workSteps []WorkStep
	// workError 是这次读经过失败的实话。和 problem 分开：一条票读不出来
	// 不该让整个界面顶部挂一条红横幅。
	workError string
}

// workResult 是哪张票的过程。没有票号就没法判断这份结果还该不该显示。
type workResult struct {
	ticket string
	steps  []WorkStep
	err    error
}

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
		s.sent <- text // 主线程确认这句真的发出去了，再清输入框
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
	// 根容器必须自己上底色：不上就是 mygo 的默认深色，亮色主题下顶上会漏出一条黑边。
	ui.Row(c).Fill().FillWidth().FillHeight().Gap(0).Background(p.Surface).Children(func() {
		s.roster(c, p)
		s.conversationPane(c, p)
		s.backendPane(c, p)
	})
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
				s.conversation, s.problem = conversation, ""
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
		case choice := <-s.modelSwitched:
			// 换成了：目录里记下新的这一个，左栏和右栏都跟着改，不用等人再点一次刷新。
			s.applyModel(choice)
			c.Invalidate()
		case text := <-s.sent:
			// 只清掉「刚发出去的那一句」；用户在这期间又打了字就留着。
			if s.input == text {
				s.input = ""
			}
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
	ui.Column(c).Width(SidebarWidth).FillHeight().PaddingX(14).PaddingY(22).Gap(18).Background(p.Card).Children(func() {
		// 标题行：图标 + 名字 + 收起。
		ui.Row(c).FillWidth().AlignItems(ui.Center).PaddingX(8).Children(func() {
			ui.Text(c, "◎").FontSize(FontIcon).TextColor(p.Ink)
			ui.Text(c, "我的队伍").FontSize(FontTitle).FontWeight(WeightTitle).LetterSpacing(-0.15).TextColor(p.Ink)
			ui.Row(c).Grow(1)
			// 一个「«」字太小，不好点：给它一圈 padding，点击挂在整块上。
			ui.Row(c).Padding(6).Radius(RadiusButton).Background(p.Card).Cursor(ui.CursorPointer).
				OnClick(func() { s.sidebarClosed = true }).Children(func() {
				ui.Text(c, "«").FontSize(FontBodyWide).TextColor(p.Faint)
			})
		})

		ui.Column(c).FillWidth().Gap(2).Children(func() {
			if s.conversation == nil || len(s.conversation.Bots) == 0 {
				ui.Text(c, "队伍还是空的。").FontSize(FontBody).TextColor(p.Faint)
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
					// 36px 头像块，圆角 11：取名字首字。强调色与警告色交替，让人一眼分得开。
					soft, tint := p.AccentSoft2, p.Accent
					if i == 2 {
						soft, tint = p.WarnSoft2, p.Warn
					}
					ui.Column(c).Width(AvatarSmall).Radius(RadiusPane).Background(soft).
						AlignItems(ui.Center).PaddingY(8).Children(func() {
						ui.Text(c, firstRune(bot.Name)).FontSize(FontHeader).FontWeight(WeightFigure).TextColor(tint)
					})
					ui.Column(c).Grow(1).Gap(2).Children(func() {
						ui.Row(c).Gap(6).AlignItems(ui.Baseline).Children(func() {
							ui.Text(c, bot.Name).FontSize(FontName).FontWeight(WeightName).TextColor(p.Ink)
							if bot.Persona != "" {
								// 职能跟名字同一行，弱一档：它是「他是什么人」，不是状态。
								ui.Text(c, bot.Persona).FontSize(FontHairline).TextColor(p.Faint).Ellipsis("…")
							}
						})
						// 状态行：一个 5px 圆点 + 一句话。点用颜色表态，比纯文字快。
						ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
							// 5px 的圆点：用方块别用字形 —— 字形的点跟字号走，大小不受控。
							ui.Column(c).Width(5).Height(5).Radius(RadiusDot).
								Background(s.stateColor(p, bot.ID))
							ui.Text(c, s.stateOf(bot.ID)).FontSize(FontBody).TextColor(p.Muted)
						})
					})
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
		// 行距 10：一行「图标 + 13px 字」在 PaddingY 里各挣 11，合计 39；画板实测 38–39。
		ui.Column(c).FillWidth().Gap(10).PaddingY(14).Children(func() {
			for _, item := range navOrder {
				s.navRow(c, p, item)
			}
		})
	})
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
	row := ui.Row(c).FillWidth().AlignItems(ui.Center).PaddingX(8).PaddingY(9).
		Radius(RadiusItem).Gap(8).Cursor(ui.CursorPointer)
	if here {
		row = row.Background(p.SelectedAlt)
	}
	row.Children(func() {
		ui.Row(c).Width(AvatarSmall).AlignItems(ui.Center).Children(func() {
			ui.Text(c, glyph).FontSize(FontIcon).TextColor(glyphTint)
		})
		ui.Text(c, text).FontSize(FontLabel).TextColor(tint)
		ui.Row(c).Grow(1)
		// 右端那一点说明：后台是张数，模型是现在用的谁，另外两个没有。
		switch item {
		case navBackend:
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
	ui.Column(c).Grow(1).MinWidth(0).FillWidth().FillHeight().Gap(0).Background(p.Surface).Children(func() {
		if s.problem != "" {
			// 断连时先把话说清楚，别让人对着空白猜。横幅要能指路：
			// 连的是哪一支、机器上到底有没有队伍，以及下一步该点哪儿。
			ui.Column(c).FillWidth().PaddingX(22).PaddingY(8).Background(p.WarnSoft).Gap(2).Children(func() {
				where := s.endpoint
				if where == "" {
					ui.Text(c, "没找到在跑的队伍").FontSize(FontBody).TextColor(p.Danger)
				} else {
					// 连的是哪一支要说出来：保存的凭据或环境变量可能指向别处，
					// 光说「没找到在跑的队伍」会让人以为连的是本机那个。
					ui.Text(c, "连不上 "+where+"："+s.problem).FontSize(FontBody).TextColor(p.Danger)
				}
				hint := "右栏「配对手机」可以重新配一次"
				if where != "" && !s.target.Found {
					hint = "这台机器上没发现正在跑的队伍；" + hint
				}
				ui.Text(c, hint).FontSize(FontMini).TextColor(p.Muted)
			})
		}
		// 标题栏：头像 + 名字·职能 + 刷新。画板里是 718×75 的白色带，上下留白 18。
		ui.Row(c).FillWidth().PaddingX(28).PaddingY(18).Gap(11).AlignItems(ui.Center).
			Background(p.Card).Children(func() {
			ui.Column(c).Width(AvatarHdr).Radius(RadiusPane).Background(p.AccentSoft).
				AlignItems(ui.Center).PaddingY(9).Children(func() {
				ui.Text(c, firstRune(s.title())).FontSize(FontTitle).FontWeight(WeightFigure).TextColor(p.Accent)
			})
			ui.Column(c).Gap(2).Children(func() {
				ui.Text(c, s.title()).FontSize(FontHeader).FontWeight(WeightTitle).TextColor(p.Ink)
				ui.Text(c, s.subtitle()).FontSize(FontBody).TextColor(p.Faint)
				if s.screenNote != "" {
					ui.Text(c, s.screenNote).FontSize(FontMini).TextColor(p.Faint)
				}
			})
			ui.Row(c).Grow(1)
			// 「看它的屏幕」：画板 109×31、圆角 9、白底细边。
			//
			// 画板里它是一扇窗；现在后端还没有对应的接口（要接浏览器的 CDP 截图，
			// 是另一件事）。所以它只画出来、按下去给一句实话 —— 不留一个点了没动静的按钮。
			screenTint := p.Muted
			if !s.screenReady {
				screenTint = p.Hint
			}
			// 指针换手、点击接线都挂在这一层 Row 上：mygo 里 Cursor 与 OnClick 都是
			// Element 上的方法，包着字的容器挂一次就够，里面那几个字不用再接一遍。
			ui.Row(c).PaddingX(13).PaddingY(7).Radius(RadiusButton).Background(p.Card).
				BorderWidth(1).BorderColor(p.Line).Cursor(ui.CursorPointer).Children(func() {
				ui.Text(c, "▭ 看它的屏幕").FontSize(FontBodyWide).TextColor(screenTint)
			}).OnClick(func() {
				if s.screenReady {
					return
				}
				// 去问后端，而不是自己编一句「还没接上」。后端会如实回答
				// {state:"unavailable", reason:"后端还没有画面源，worker 不跑浏览器"}；
				// 这是一条功能说明，不是连接故障，绝不能写进 s.problem。
				ticketID := ""
				if s.conversation != nil && len(s.conversation.Tasks) > 0 {
					ticketID = s.conversation.Tasks[0].ID
				}
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					defer cancel()
					view, err := s.client.Screen(ctx, ticketID)
					switch {
					case err != nil:
						s.screenNoteCh <- "读不到屏幕：" + err.Error()
					case view.State == "unavailable" && view.Reason != "":
						s.screenNoteCh <- view.Reason
					default:
						s.screenNoteCh <- "屏幕暂时只有状态：" + view.State
					}
					s.wake()
				}()
			})
			ui.Row(c).PaddingX(9).PaddingY(7).Radius(RadiusButton).
				Cursor(ui.CursorPointer).Children(func() {
				ui.Text(c, "···").FontSize(FontBodyWide).TextColor(p.Faint)
			}).OnClick(s.refresh)
		})
		// 画板的 header 带一条 border-bottom。mygo 没有单边边框，用 1px 的线代替 ——
		// 少了这条，标题栏和消息区会糊成一片，暗色下尤其像「整块空的」。
		ui.Column(c).FillWidth().Height(1).Background(p.Line)
		s.stream(c, p)
		s.composer(c, p)
	})
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
	return "和 " + s.nameOf(who) + " 说话"
}

func (s *app) title() string {
	if s.conversation != nil && len(s.conversation.Messages) > 0 {
		last := s.conversation.Messages[len(s.conversation.Messages)-1]
		if last.Role == "agent" {
			return s.nameOf(last.BotID) + " 在回你"
		}
	}
	return "对话"
}

func (s *app) stream(c *ui.Context, p Palette) {
	switch {
	case s.conversation == nil:
		// Grow(1)：空态/加载态也要占住剩余高度，否则输入框会贴在标题下面，
		// 下面留一大片空白 —— 看起来像布局坏了。
		ui.Column(c).Grow(1).FillWidth().PaddingX(ContentInset).PaddingY(16).
			Children(func() { ui.Text(c, "正在读对话…").FontSize(FontBody).TextColor(p.Faint) })
	case len(s.conversation.Messages) == 0:
		// 空态：还没人说话。
		ui.Column(c).Grow(1).FillWidth().PaddingX(ContentInset).PaddingY(16).Children(func() {
			ui.Text(c, "还没有人说话。在下面写一句试试。").FontSize(FontBody).TextColor(p.Faint)
		})
	default:
		ui.Scroll(c).Grow(1).FillWidth().Children(func() {
			ui.Column(c).PaddingX(ContentInset).PaddingY(10).Gap(10).Children(func() {
				for _, message := range s.conversation.Messages {
					s.message(c, p, message)
				}
				// 子代理卡跟在这一段之后：它说的是「这段话派下去谁在跑」。
				// 设计稿把它放在消息流里，不是右栏 —— 右栏放的是工单，是另一件事。
				if tree := s.agents; len(tree) > 0 {
					s.subagentCard(c, p, tree)
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
	ui.Row(c).FillWidth().PaddingX(ContentInset).Children(func() {
		ui.Column(c).MaxWidth(ContentMax).FillWidth().Radius(RadiusPane).
			Background(p.Card).BorderWidth(1).BorderColor(p.Line).Children(func() {
			// 表头：左「N 个子代理」，右「x 在跑 · y 已完成」。
			ui.Row(c).FillWidth().Padding(12).AlignItems(ui.Center).Children(func() {
				ui.Text(c, fmt.Sprintf("%d 个子代理", total)).FontSize(FontBody).FontWeight(WeightName).TextColor(p.Muted)
				ui.Row(c).Grow(1)
				ui.Text(c, fmt.Sprintf("%d 在跑 · %d 已完成", running, done)).FontSize(FontSmall).TextColor(p.Faint)
			})
			ui.Column(c).FillWidth().Height(1).Background(p.Line)
			for _, node := range tree {
				s.subagentRow(c, p, node, 0)
			}
			ui.Column(c).FillWidth().Height(1).Background(p.Line)
			ui.Row(c).FillWidth().Padding(12).Background(p.Footer).Children(func() {
				ui.Text(c, "子代理还能再派子代理，层级在这张卡里逐层展开").
					FontSize(FontSmall).TextColor(p.Faint)
			})
		})
	})
}

// subagentRow 是卡里的一行：状态点 + 名字 + 右侧的状态与耗时。
func (s *app) subagentRow(c *ui.Context, p Palette, node AgentNode, depth int) {
	working := !agentDone(node.State)
	mark, tint := "○", p.Muted
	if !working {
		mark, tint = "✓", p.Faint
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
		ui.Text(c, name).FontSize(FontBody).TextColor(p.Muted)
		ui.Row(c).Grow(1)
		ui.Text(c, stateWord(node.State)).FontSize(FontSmall).TextColor(p.Faint)
	})
	for _, child := range node.Children {
		s.subagentRow(c, p, child, depth+1)
	}
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

func (s *app) message(c *ui.Context, p Palette, message Message) {
	fromBot := message.Role == "agent"
	// 消息落在一条左右不对称的栏里：左边距 75、右边距 36，和画板一致。
	row := ui.Row(c).FillWidth().PaddingX(36).PaddingY(9)
	if !fromBot {
		// 自己发的话靠右。
		row = row.Justify(ui.End)
	}
	row.Children(func() {
		ui.Column(c).MaxWidth(ContentMax).Gap(6).Children(func() {
			// 自己发的话不标名字：靠右对齐已经说明是谁了（画板也是这样）。
			// 只在有 Bot 或时间需要标明时才画这一行，否则会多出一条空白。
			when := shortTime(message.At)
			if fromBot || when != "" {
				ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
					if fromBot {
						ui.Text(c, s.nameOf(message.BotID)).FontSize(FontSmall).FontWeight(WeightName).TextColor(p.Accent)
					}
					if when != "" {
						ui.Text(c, when).FontSize(FontHairline).TextColor(p.Faint)
					}
				})
			}
			// 气泡：右下角收成 4px 当尖角（设计稿 `15px 15px 4px`），指向发出它的那一侧。
			//
			// 自己发的话压深底、字反白；Bot 的话在浅底上、字用正常墨色。
			// 这两件事必须一起定，分开写就会有一边读不清 —— 暗色主题下尤其明显。
			var bubble ui.Element
			textColor := p.Ink
			if fromBot {
				bubble = ui.Column(c).PaddingX(15).PaddingY(11).Radius(RadiusBubble).
					Background(p.Surface)
			} else {
				bubble = ui.Column(c).PaddingX(15).PaddingY(11).
					Radius(RadiusBubble, RadiusBubble, RadiusTail, RadiusBubble).
					Background(p.UserBubble)
				textColor = p.UserInk
			}
			bubble.Children(func() {
				ui.Text(c, message.Text).FontSize(FontText).TextColor(textColor)
			})
			// 消息带代码就画代码卡：设计稿里它挂在正文下面，和气泡同宽。
			if block := message.Code(); block != nil {
				ui.Row(c).FillWidth().Children(func() { s.codeCard(c, p, *block) })
			}
		})
	})
}

// codeCard 是消息里的代码片段：文件名 + 增删统计 + 逐行高亮。
//
// 设计稿里新增行是整行浅绿底、删除行整行浅橙底，`+` / `-` 号跟在行首。
// 只给号着色是不够的 —— 一屏代码里看不出改了哪几行。
func (s *app) codeCard(c *ui.Context, p Palette, block CodeBlock) {
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
			text, soft := "  "+line.Text, p.Card
			switch line.Kind {
			case "added":
				text, soft = "+ "+line.Text, p.AccentSoft
			case "removed":
				text, soft = "- "+line.Text, p.WarnSoft
			}
			ui.Row(c).FillWidth().PaddingX(14).PaddingY(3).Background(soft).Children(func() {
				ui.Text(c, text).FontSize(FontBody).TextColor(p.Muted)
			})
		}
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
	if botID == "" {
		return "队伍"
	}
	return botID
}

func (s *app) composer(c *ui.Context, p Palette) {
	// 排队中的消息也能看见：说了会排在后面，就得让它在这里排着，并且能撤。
	if s.conversation != nil && len(s.conversation.Queued) > 0 {
		ui.Row(c).Padding(12).Gap(8).Background(p.Surface).Children(func() {
			ui.Text(c, fmt.Sprintf("%d 条排队中，等队伍读完手上这一步", len(s.conversation.Queued))).
				FontSize(FontTiny).TextColor(p.Faint)
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
	// 输入区：画板里圆角 13、白底细边、上下留白，和消息流的左边距对齐。
	ui.Row(c).FillWidth().PaddingX(ContentInset).PaddingY(12).Gap(8).Background(p.Card).Children(func() {
		placeholder := "跟队伍说点什么"
		if s.problem != "" {
			placeholder = "连上之后才能发"
		}
		ui.Row(c).Grow(1).Radius(RadiusBig).Background(p.Surface).
			BorderWidth(1).BorderColor(p.Line).PaddingX(13).PaddingY(9).Children(func() {
			ui.TextInput(c, &s.input).Placeholder(placeholder).Grow(1).
				PlaceholderColor(p.Faint).OnSubmit(func() { s.send() })
		})
		if s.sending {
			ui.Text(c, "发送中…").FontSize(FontTiny).TextColor(p.Faint)
		} else if ui.PrimaryButton(c, "发送").Background(p.Accent).Clicked() {
			s.send()
		}
	})
}

// backendPane 是右栏：工单是唯一的工作状态主体，这里只是它的只读投影。
//
// 右栏跟着左栏点开的那一项走：「后台」是工单，「模型」是选择，「产出」「常规任务」是
// 明说的空态。每一项都画得出来，没有一项按下去是空的。
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
	ui.Column(c).Width(BackendWidth).FillHeight().PaddingX(16).PaddingY(22).Gap(14).Background(p.Surface).Children(func() {
		ui.Row(c).FillWidth().Children(func() {
			ui.Row(c).Grow(1)
			ui.Text(c, "收起 ›").FontSize(FontTiny).TextColor(p.Faint).Cursor(ui.CursorPointer).
				OnClick(func() { s.backendOpen = false })
		})
		switch s.navTab {
		case navModel:
			s.modelPane(c, p)
		case navOutput, navRoutine:
			s.emptyPane(c, p, s.navTab)
		default:
			s.workPane(c, p)
		}
		s.pairing(c, p)
	})
}

// workPane 是「后台」那一栏：栏头、三个标签、工单卡。
func (s *app) workPane(c *ui.Context, p Palette) {
	// 栏头：标题 + 张数。
	ui.Row(c).Gap(7).AlignItems(ui.Center).Children(func() {
		ui.Text(c, "后台").FontSize(FontTitle).FontWeight(WeightTitle).TextColor(p.Ink)
		if s.conversation != nil && len(s.conversation.Tasks) > 0 {
			ui.Text(c, fmt.Sprintf("%d 张", len(s.conversation.Tasks))).
				FontSize(FontTiny).TextColor(p.Faint)
		}
	})

	// 标签：进行中 / 待你 / 已完成。画板里它是一条分段控件：
	// 轨道 360×32、底色 Track、圆角 8；里面三个胶囊各 115×26、圆角 6、间隔 4，
	// 选中的那个抬成白底（暗色按画板用 Card），没选中的透明。
	// 坐标见 designs/personal-agent/桌面亮色-坐标.md「右栏」。
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
			ui.Text(c, "还没连上，读不到工单").FontSize(FontBody).TextColor(p.Faint)
		} else {
			ui.Text(c, "这一栏还是空的。").FontSize(FontBody).TextColor(p.Faint)
		}
	} else {
		ui.Scroll(c).Grow(1).FillWidth().Children(func() {
			ui.Column(c).Gap(9).Children(func() {
				for _, task := range tasks {
					s.taskCard(c, p, task)
				}
				// 他派了谁：只跟第一张在跑的工单，层级靠缩进。
				if tree := s.agents; len(tree) > 0 {
					ui.Column(c).Gap(5).PaddingY(6).Children(func() {
						ui.Text(c, "他派了谁").FontSize(FontTiny).FontWeight(WeightName).
							LetterSpacing(0.55).TextColor(p.Faint)
						for _, node := range tree {
							s.agentRow(c, p, node, 0)
						}
					})
				}
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
	cell := ui.Row(c).Width(TabWidth).Height(TabHeight).Radius(RadiusChip).
		Center().Cursor(ui.CursorPointer)
	// 底色：选中抬一层，按下去再压一层；没选中的平时透明，按住才浮起一点。
	soft, tint := ui.Transparent, p.Faint
	weight := WeightName
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
		ui.Text(c, "模型").FontSize(FontTitle).FontWeight(WeightTitle).TextColor(p.Ink)
		if s.models != nil {
			ui.Text(c, fmt.Sprintf("%d 家", len(s.models.Providers))).FontSize(FontTiny).TextColor(p.Faint)
		}
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

// modelRow 是一个能选的模型。整行都能点。
func (s *app) modelRow(c *ui.Context, p Palette, provider string, option ModelOption) {
	picked := chosenModel(s.models.Current, provider, option.ID)
	row := ui.Row(c).FillWidth().Gap(9).AlignItems(ui.Center).PaddingX(10).PaddingY(9).
		Radius(RadiusItem).Cursor(ui.CursorPointer)
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

// emptyPane 是「产出」「常规任务」那两栏。它们后端还没有数据 —— 说清楚，不留白。
func (s *app) emptyPane(c *ui.Context, p Palette, item navItem) {
	title, body := emptyCopy(item)
	_, name := navLabel(item)
	ui.Text(c, name).FontSize(FontTitle).FontWeight(WeightTitle).TextColor(p.Ink)
	ui.Column(c).FillWidth().Gap(6).Padding(14).Radius(RadiusCard).
		BorderWidth(1).BorderColor(p.Line).Background(p.Card).Children(func() {
		ui.Text(c, title).FontSize(FontBodyWide).FontWeight(WeightCard).TextColor(p.Muted)
		ui.Text(c, body).FontSize(FontSmall).TextColor(p.Faint)
	})
}

// currentModel 是「现在用的是谁」的一句话。两个来源：目录说过的（刚换完最准），
// 以及时间线带回来的那个（还没读过目录时用它）。
func (s *app) currentModel() string {
	if s.models != nil && s.models.Current != nil {
		choice := s.models.Current
		if choice.Provider != "" && choice.Provider != choice.Model {
			return choice.Model + " · " + choice.Provider
		}
		if choice.Model != "" {
			return choice.Model
		}
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
		ui.Text(c, task.Title).FontSize(FontBodyWide).FontWeight(WeightCard).TextColor(tint)

		// 状态行：谁在做 + 第几步。设计稿把这两件事压在第二行。
		detail := stateWord(task.State)
		if task.BotID != "" {
			detail += " · " + s.nameOf(task.BotID)
		}
		if step := s.stepOf(task); step != "" {
			detail += " · " + step
		}
		ui.Text(c, detail).FontSize(FontTiny).TextColor(p.Muted)
		// 进度条：画板里 2px 圆角、2px 高。
		//
		// 能不能画取决于有没有「共几步」这个分母 —— 后端目前只给已发生的经过，
		// 没有计划里的总步数。没有分母就不画，宁可空着也不画一根假的。
		if done, total := s.progressOf(task); total > 0 {
			ui.Row(c).FillWidth().Height(2).Radius(RadiusTiny).Background(p.Line).Children(func() {
				ui.Row(c).WidthPercent(float32(done) / float32(total) * 100).FillHeight().
					Radius(RadiusTiny).Background(p.Accent)
			})
		}

		if task.NeedsPerson != "" {
			// 等的原因要写明，否则「等你」不告诉人要等什么。
			ui.Text(c, task.NeedsPerson).FontSize(FontTiny).TextColor(p.Warn)
			if waited := s.waitedFor(task); waited != "" {
				ui.Text(c, "卡在等你 · 等你 "+waited).FontSize(FontHairline).TextColor(p.Warn)
			}
		}
		if task.Retryable {
			// 失败的票得有一条出路，否则只能干看着。
			ticketID := task.ID
			ui.Row(c).Gap(10).AlignItems(ui.Center).Children(func() {
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
		ui.Row(c).FillWidth().AlignItems(ui.Center).Children(func() {
			ui.Text(c, arrow).FontSize(FontTiny).TextColor(p.Accent)
			ui.Row(c).Grow(1)
			if err := s.workError; opened && err != "" {
				ui.Text(c, err).FontSize(FontHairline).TextColor(p.Danger)
			}
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
	s.modelNote = "正在换…"
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := s.client.SwitchModel(ctx, choice); err != nil {
			// 换模型失败只影响模型栏，不该冒充断连、更不该锁住输入框。
			s.modelError <- err.Error()
			s.wake()
			return
		}
		s.modelSwitched <- choice
		s.wake()
	}()
}

// applyModel 把「现在用的是谁」改成刚换上的那一个。
func (s *app) applyModel(choice ModelChoice) {
	if s.models == nil {
		s.models = &ModelCatalog{}
	}
	chosen := choice
	s.models.Current = &chosen
	s.modelNote = ""
	if s.conversation != nil {
		s.conversation.Model = choice.Model
	}
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
// 返回 (0, 0) 表示「算不出来」：后端只记录已发生的经过（steps），
// 没有计划里的总步数。拿「读到几步」当分母，进度条会永远停在 100%。
func (s *app) progressOf(task Task) (int, int) {
	if task.TotalSteps <= 0 {
		return 0, 0
	}
	return len(s.stepsFor(task.ID)), task.TotalSteps
}

// stepOf 从已读到的经过里取「第几步」，没有就说没有。
func (s *app) stepOf(task Task) string {
	steps := s.stepsFor(task.ID)
	if len(steps) == 0 {
		return ""
	}
	return fmt.Sprintf("第 %d 步", len(steps))
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
	ui.Text(c, "手机").FontSize(FontHairline).Bold().TextColor(p.Muted)
	ui.Text(c, "这一台与队伍配一次，之后两边都免配置。").FontSize(FontMini).TextColor(p.Faint)
	// 默认主色是系统蓝，和队伍配色不是一套。
	if ui.PrimaryButton(c, "配对手机").Background(p.Accent).Clicked() {
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
	if s.pairingNote != "" {
		ui.Text(c, s.pairingNote).FontSize(FontMini).TextColor(p.Faint)
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
