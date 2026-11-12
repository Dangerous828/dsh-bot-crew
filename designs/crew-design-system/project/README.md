# Crew

Bot 队伍的设计系统。**目标态**：`tokens.json` 是修订后的值，`desktop/theme.go`、`ui.go` 的字号常量、`app/.../CrewUi.kt` 目前仍是旧值，尚未同步。落地位置见 [落地映射.md](落地映射.md)。

## 气质

暖白底、低饱和、一个绿。靠**结构**分层——间距、分隔线、字重——不靠「再淡一档的灰」。

暖白与主题绿是识别，不动。语义色（赭「等你决定」、红「失败」）只做状态，不做装饰。暗色不是亮色反相：强调必须提亮，淡底必须重算。

---

## 一、为什么原来的界面看着灰、糊、碎

不是审美问题，是数值问题。以下全部按 WCAG 相对亮度公式实算（`desktop/contrast_test.go:15-34` 同一套算法）：

| 旧 token | 值 | on Surface | 问题 |
|---|---|---|---|
| `hint` | `#A9A294` | **2.41:1** | 被用作空态说明正文（`ui.go:1501`、`:2730`），新用户第一次打开时唯一的指路信息 |
| `faint` | `#8A8377` | **3.57:1** | 弱文字档，未过 AA |
| `emptyGlyph` | `#B8B1A5` | **2.02:1** | 空态唯一图形提示 |
| `emptyGlyphSoft` | `#C9C2B6` | **1.68:1** | 基本不存在 |
| `line` | `#EDE8E1` | 与底色亮度差 **13.8%** | 分隔线肉眼近乎不可见 |
| `selected` | `#F3F0EA` | 与底色亮度差 **7.6%** | 选中态看不出来 |

**因果链**：层次全靠 1~2% 的亮度差 → 屏幕上等于没有层次 → 只好加文字解释来区分 → 界面变吵。这解释了 [#7](https://github.com/Dangerous828/dsh-bot-crew/issues/7) 里「解释太多」的根因，也解释了为什么 `contrast_test.go` 没拦住：它测了 Ink / Muted / UserInk / Accent，**唯独没测 Hint 这一档**，Faint 只测 `on Card` 且门槛松到 2.5。

另外两个放大器：

- **字号 19 档**，桌面 10.5→17，相邻档差 0.5px（11 / 11.5 / 12 / 12.5 / 13 / 13.5）。肉眼分不出，只增加阅读成本。`CrewUi.kt` 里 11sp 用了 64 处，其中不少是状态行、任务详情、时间戳这类真信息。
- **圆角 15 档**（2/4/5/6/8/9/10/11/13/14/15/16/20/50%），同屏出现五种，节奏散。

**九种近白面**（`surface` / `card` / `raised` / `faintSurface` / `warmWhite` / `selected` / `dividerSoft` / `line` / `aliasSurface`）是「暖白底、靠留白说话」走到极端的副作用：它们彼此差 1~3%，在屏幕上不构成层级。

---

## 二、四条修订原则

1. **灰阶收成三档**：`ink` / `muted` / `tertiary`。每一档都过 AA 4.5:1，亮暗两套都过。删掉 `inkStrong`（与 ink 差 8/255）、`faint`、`hint`、`emptyGlyphSoft`。
2. **面收成四个**：`surface` / `card` / `selected` / `line`。`selected` 与 `line` 要真的看得见，不再用近白做层。
3. **层次交给结构**：间距（`space-1/2/4/6`）、字重（400 / 500 / 640）、分隔线，而不是再淡一档。层次看得见之后，界面上那些解释句就有了删掉的条件。
4. **刻度收敛**：字号 19 → 6 档，圆角 15 → 4 档，间距 4 档。**信息文本最低 12px**，徽标才用 11px。

---

## 三、色板

### 亮色

| Token | 值 | on Surface | 用途 |
|---|---|---|---|
| `surface` | `#FBF9F6` | — | 页面底（保留） |
| `card` | `#FFFFFF` | — | 卡片、栏（保留） |
| `selected` | `#EDE7DC` | 差 14.6% | 选中项底 |
| `line` | `#DDD6CA` | 差 27.2% | 分隔与边框 |
| `ink` | `#1F1D1A` | 16.00:1 | 主文字（保留） |
| `muted` | `#57524A` | 7.37:1 | 次要（保留） |
| `tertiary` | `#6F6A60` | **5.12:1** | 占位、时间戳、状态行、空态说明 |
| `accent` | `#3E6B62` | 5.74:1 | 主强调（保留） |
| `warn` | `#96603A` | 4.96:1 | 等你决定（保留） |
| `danger` | `#A84444` | 5.87:1 on Card | 失败（压深，留余量） |
| `empty-glyph` | `#8E877A` | 3.39:1 | 空态图形（过 3:1 UI 组件门槛） |

### 暗色

| Token | 值 | on Surface | 说明 |
|---|---|---|---|
| `surface` | `#17161A` | — | 保留 |
| `card` | `#232228` | — | 保留 |
| `selected` | `#343139` | 差 2.4% | 提亮，选中态可辨 |
| `line` | `#413E48` | 差 4.2% | 提亮，分隔线可辨 |
| `ink` | `#F2EFEA` | 15.70:1 | 保留 |
| `muted` | `#C4BFB6` | 9.84:1 | 保留 |
| `tertiary` | `#9A938A` | **5.93:1** | 取代 `faint` 5.40 / `hint` 3.27 两档 |
| `accent` | `#5FBFA8` | 8.15:1 | 保留（比亮色提亮一档） |
| `empty-glyph` | `#756E65` | 3.58:1 | 与亮色 3.39 对齐，不再差 2.7 倍 |

**逐项验收见 [优化对照.md](优化对照.md)**：14 组配对全部 PASS。

---

## 四、字号 / 圆角 / 间距

| 字号 | 值 | 用在哪 |
|---|---|---|
| `caption` | 11 | 徽标、单位、纯标签（不承载句子） |
| `secondary` | 12 | 时间戳、状态行、次要信息 |
| `body` | 13 | 栏内正文、导航项、工单副行 |
| `message` | 14 | 消息正文 |
| `heading` | 15 | 栏标题、卡片标题 |
| `display` | 17 | 页面主标题 |

字重只用 400 / 500 / 640 三档（原画板的 640 / 620 / 600 / 550 保留 640，其余收敛）。

圆角 `radius-sm 4` / `radius-md 8` / `radius-lg 12` / `radius-xl 16`；气泡尖角仍用 `radius-sm`。间距 `space-1 4` / `space-2 8` / `space-4 16` / `space-6 24`。

---

## 五、组件

三个静态参考卡片：`TitleBar`、`Conversation`、`TaskCard`。它们**不是可挂载组件**——实现是 Go (mygo) 与 Kotlin (Compose) 原生绘制，没有 web bundle。卡片用本系统的 `tokens.css` 变量渲染，用来判断「改完之后长什么样」，不参与运行时。

- `TitleBar` 直接对应 [#7 偏离 1](https://github.com/Dangerous828/dsh-bot-crew/issues/7)：恢复设计稿的「名字 · 职能」+「实时状态 · 时长」，把「和 X 说话」这句零信息副标题换掉。
- `Conversation` 演示三档灰与无气泡 Bot 正文，右下 4px 尖角保留。
- `TaskCard` 演示结构分层：分隔线 + 间距 + 字重，替代靠微亮度差堆出来的层。

---

## 六、Not synced

`tokens.json` 是**目标态**。以下尚未改动，别把本系统当成已落地：

- `desktop/theme.go`（色板）、`desktop/ui.go`（`Font*` 常量、`Radius*` 常量）
- `app/.../CrewUi.kt`（11sp / 10.5sp、32dp 头像、圆角）
- `desktop/contrast_test.go`（补 `Hint`/`Tertiary` 档与「前景 × 实际背景」逐对测试）
- `designs/personal-agent/project/*.dc.html` 九张画板（仍是旧色板）

落地顺序与文件行号见 [落地映射.md](落地映射.md)。配套 GitHub：[#6 评审总览](https://github.com/Dangerous828/dsh-bot-crew/issues/6)、[#7 UI 与设计稿偏离](https://github.com/Dangerous828/dsh-bot-crew/issues/7)。

## 对照图

[亮色对照](render/对比-优化前后.png) · [暗色对照](render/对比-优化前后-暗色.png)（可复现的源页：[亮](render/对比-优化前后.html) / [暗](render/对比-优化前后-暗色.html)）

两版共用**同一份组件定义**，只替换 CSS 变量（色值 / 字号 / 圆角）。布局、文案、内容完全一致 —— 差异全部来自 `tokens.json`。下方三组局部放大分别展示：空态说明文字、选中态与分隔线、标题栏信息层（第三组属内容改动，单独列出）。

**这两张是目标态示意，不是真机截屏**。仓库里另有一张 `designs/personal-agent/render/对照-设计稿vs实现.png`，那是「设计稿 vs 当时实现」的历史对照，与本轮的「旧色板 vs 新色板」不是一回事，别混着看。

---

## 来源

从 `designs/personal-agent/tokens.json`、`设计系统.md`、`还原对照.md`、`desktop/theme.go` 与 `docs/review/2026-11-12-ui.md` 的对比度实算枚举而来。保留的色值原样照抄，修订的色值都在 [优化对照.md](优化对照.md) 里给了原值、新值与依据。**没有凭空造品牌色。**
