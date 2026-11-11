// 左栏那几个导航项背后的状态。
//
// 这里只放「按下去会变成什么样」——不改界面、不发请求，所以能直接对着它写测试。
// 谁去发请求是 ui.go 的事。
package main

// navItem 是左栏底部那几个入口。左边这个数是它点的哪一格。
type navItem int

const (
	// navBackend 是「后台」：右栏那一档，展开来看、并在三档之间换。
	navBackend navItem = iota
	// navModel 是「模型」：右栏改成一个选模型的筐，选完就换。
	navModel
	// navOutput 是「产出」：队伍交出来的文件（契约 §5.4）。点开时重读一遍 ——
	// worker 刚写完的文件不会自己长到界面上。
	navOutput
	// navRoutine 是「常规任务」：主人写下的定时账本（契约 §5.5）。点开时重读一遍 ——
	// 上次跑 / 下次跑是按时间算的，不重读就会一直停在上一次。这一轮只读，不改账。
	navRoutine
	// navMemory 是「记忆」：队伍长期记得的事（契约 §5.7）。点开时重读一遍 ——
	// 忘掉 / 改过之后，这一栏不会自己变。这一版能改能忘，不能在这儿新加一条。
	navMemory
)

// navOrder 是它们在左栏从上到下的顺序。
var navOrder = []navItem{navBackend, navModel, navOutput, navRoutine, navMemory}

// navLabel 是这一项上写的字。图标字和文字分开写：图标换字号时才不会把文字也带歪。
func navLabel(item navItem) (glyph, text string) {
	switch item {
	case navModel:
		return "◐", "模型"
	case navOutput:
		return "▢", "产出"
	case navRoutine:
		return "◷", "常规任务"
	case navMemory:
		return "❖", "记忆"
	default:
		return "▤", "后台"
	}
}

// pressNav 按下一个导航项之后的下一步。返回 true 表示要重画。
//
// 规则只有一条：点了就一定有反应，而且反应看得见。
//
// 「后台」在别处按过来，一定打开、落在「进行中」；已经停在后台时再按，是把它收起来
// （右栏折成一条，中间的对话占满），这样它不只是个跳转，还是个开关。
// 第一下永远不会是「收起」—— 这一格本来就在，按了却看见东西消失，那是另一种死。
func (s *app) pressNav(item navItem) bool {
	switch item {
	case navBackend:
		if s.backendOpen && s.navTab == navBackend {
			s.backendOpen = false
			return true
		}
		s.backendOpen = true
		// 从别处切回来时落在「进行中」：那是人最想先看的一档。
		s.backendTab = 0
		s.navTab = navBackend
		return true
	case navModel:
		s.navTab = navModel
		s.backendOpen = true
		// 每次打开都重读一遍：模型目录是宿主那边算的，机器上装了新的就会变。
		s.loadModels()
		return true
	case navOutput:
		s.navTab = item
		s.backendOpen = true
		// 每次打开都重读：产出是 worker 干活时一点点长出来的。
		s.loadOutputs()
		return true
	case navRoutine:
		s.navTab = item
		s.backendOpen = true
		// 每次打开都重读：上次跑 / 下次跑是按时间算出来的，读一次才说得准。
		s.loadRoutines()
		return true
	case navMemory:
		s.navTab = item
		s.backendOpen = true
		// 每次打开都重读：别处（手机、某个 worker 收尾）也会往账本里写。
		s.loadMemory()
		return true
	default:
		return false
	}
}

// chosenModel 是当前这一格是不是正在用的那个模型。
//
// 两边有一个空就不算：拿一个空串去和「现在用的是谁」比，比出来的是假话。
func chosenModel(current *ModelChoice, provider string, model string) bool {
	if current == nil || provider == "" || model == "" {
		return false
	}
	return current.Provider == provider && current.Model == model
}

// pickModel 是从目录里挑。找不到那一家、或那一家没有这个模型，就原样返回 false：
// 界面上不该出现一个点了没结果的选项，真到了这一步也不该谎报「换成了」。
func pickModel(catalog *ModelCatalog, provider string, model string) (ModelChoice, bool) {
	if catalog == nil {
		return ModelChoice{}, false
	}
	for _, group := range catalog.Providers {
		if group.ID != provider {
			continue
		}
		for _, option := range group.Models {
			if option.ID == model {
				return ModelChoice{Provider: provider, Model: model}, true
			}
		}
	}
	return ModelChoice{}, false
}

// modelNameOf 是给人看的那个名字：目录里有名字就用名字，没有就用 id。
func modelNameOf(option ModelOption) string {
	if option.Name != "" {
		return option.Name
	}
	return option.ID
}

// emptyCopy 是「产出」和「常规任务」两栏在空态时的原话。
//
// 两栏现在都接上了后端（产出 §5.4、常规任务 §5.5）：这里的两句只在 `state: "empty"`
// ——读得到、确实没有——时出现；「读不到」另有一句话，不借用这两句。
func emptyCopy(item navItem) (title, body string) {
	switch item {
	case navOutput:
		return "还没有产出", "队伍还没在工单里写过文件。它写过的文件会出现在这里。"
	case navRoutine:
		return "还没有常规任务", "这里是定时要做的事的账本。一条都还没有；账本里的任务到点不会自己跑 —— 后端还没有调度器。"
	case navMemory:
		return "还没有记住什么", "这里是队伍的长期记忆：你定下的规矩、工单的结论。它办完的事会一条条记在这里。"
	default:
		return "", ""
	}
}
