#!/usr/bin/env node
// 设计稿与实现的对照检查。
//
// 截图拿不到的时候，至少让「结构对不对」能被自动发现：
// 设计稿里写明的字号、圆角、颜色，实现里必须有一份对得上的值。
// 这不能代替人眼，但能挡住「改了一处忘了另一处」。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const theme = readFileSync(join(root, 'desktop/theme.go'), 'utf8')

const problems = []

// 九张画板都算数，不只桌面主界面。只查一张的话，
// 空态那种「52×52 圆角 16」的框会被漏掉 —— 之前就是这么漏的。
const DESKTOP_BOARDS = ['Desktop.dc.html', 'Desktop-dark.dc.html', 'Desktop-empty.dc.html', 'Desktop-offline.dc.html']
const MOBILE_BOARDS = ['Mobile.dc.html', 'Mobile-dark.dc.html', 'Mobile-roster.dc.html', 'Mobile-card.dc.html', 'Mobile-workspace.dc.html']

function readBoards(names) {
  return names.map(name => ({
    name,
    text: readFileSync(join(root, 'designs/personal-agent/project', name), 'utf8'),
  }))
}
const desktopBoards = readBoards(DESKTOP_BOARDS)
const mobileBoards = readBoards(MOBILE_BOARDS)

function union(boards, re) {
  const out = new Set()
  for (const { text } of boards) for (const m of text.matchAll(re)) out.add(m[1])
  return out
}

// 画板写 `11px`、常量写 `11.0`，是同一个值。按数字比，不按字符串比。
const asNumbers = set => new Set([...set].map(Number))
const byNumber = (a, b) => a - b

// 1) 桌面画板用到的每个字号，theme.go 里都要有对应刻度。
const sizes = asNumbers(union(desktopBoards, /font-size:\s*([0-9.]+)px/g))
const scale = asNumbers(new Set([...theme.matchAll(/Font\w+\s*=\s*([0-9.]+)/g)].map(m => m[1])))
for (const size of [...sizes].sort(byNumber)) {
  if (!scale.has(size)) problems.push(`桌面画板里的 ${size}px 在 theme.go 的刻度里没有对应项`)
}

// 2) 圆角同理。圆角是四面写法的（`15px 15px 4px`），逐个数字都要有出处。
const radii = new Set()
for (const { name, text } of desktopBoards) {
  for (const m of text.matchAll(/border-radius:\s*([0-9]+)(?:px)/g)) radii.add(m[1])
}
const radiusScale = asNumbers(new Set([...theme.matchAll(/Radius\w+\s*=\s*(\d+)/g)].map(m => m[1])))
for (const r of [...radii].sort(byNumber)) {
  if (!radiusScale.has(Number(r))) problems.push(`桌面画板里的圆角 ${r}px 在 theme.go 里没有对应项`)
}

// 2b) 手机画板的字号与圆角要与 CrewUi.kt 对得上。
//     两端各写一份刻度，漏改一处就只剩一端是新值。
const kt = readFileSync(join(root, 'app/app/src/main/java/com/dsh/botcrew/CrewUi.kt'), 'utf8')
//     两个例外，都是「画板上画了但界面不该显示」的字号 —— 不是漏实现：
//       9   ：工作区画板里「24px 安全区」的虚线标注，那是画板的注释，不是界面元素。
//       9.5 ：队伍头像右上角的未读徽标。后端没有未读计数，没有数据就不该画一个假的。
const MOBILE_SIZE_EXEMPT = new Map([
  [9, '画板注释（「24px 安全区」标注），不是界面元素'],
  [9.5, '未读徽标：后端没有未读计数，无数据不画'],
])
const mobileSizes = asNumbers(union(mobileBoards, /font-size:\s*([0-9.]+)px/g))
const ktSizes = asNumbers(new Set([...kt.matchAll(/fontSize\s*=\s*([0-9.]+)\.sp/g)].map(m => m[1])))
for (const size of [...mobileSizes].sort(byNumber)) {
  if (ktSizes.has(size) || MOBILE_SIZE_EXEMPT.has(size)) continue
  problems.push(`手机画板里的 ${size}sp 在 CrewUi.kt 里没有对应项`)
}

// 3) 亮色主题的每个品牌色都必须是设计稿里出现过的值。
//    整个九张画板的并集都算「设计稿里」—— 有的颜色只在暗色板或手机板上出现。
const brandColors = ['#FBF9F6', '#FFFFFF', '#1F1D1A', '#57524A', '#8A8377', '#EDE8E1', '#3E6B62', '#F3F0EA', '#EAF1EC', '#96603A', '#F6EEE6']
const upper = [...desktopBoards, ...mobileBoards].map(b => b.text).join('\n').toUpperCase()
for (const color of brandColors) {
  if (!upper.includes(color.toUpperCase())) {
    problems.push(`品牌色 ${color} 在设计稿里没出现，要么写错了要么设计改了`)
  }
  if (!theme.toUpperCase().includes(color.toUpperCase())) {
    problems.push(`品牌色 ${color} 在 theme.go 里没有，实现漏了这一层`)
  }
}

// 4) 尺寸常量要对得上设计稿里写死的宽度。
for (const [name, value] of [['SidebarWidth', 329], ['BackendWidth', 393], ['ContentMax', 718], ['ContentInset', 75], ['AvatarSmall', 36], ['AvatarHdr', 38], ['RadiusBubble', 15], ['RadiusTail', 4]]) {
  if (!new RegExp(`${name}\\s*=\\s*${value}`).test(theme)) {
    problems.push(`尺寸 ${name} 应该等于 ${value}`)
  }
}

// 5) 每个刻度常量都得真的被用到。定义了不用 = 白写；
//    用得少了说明还有地方在写裸数字。
const ui = readFileSync(join(root, 'desktop/ui.go'), 'utf8')
// 字号与圆角要「齐全」（上一节已经查过对得上设计稿），
// 但只有圆角必须被使用 —— 字号是给未来元素留的刻度，定义着不用是对的。
for (const [, name] of theme.matchAll(/(Radius\w+|Weight\w+)\s*=\s*[0-9.]+/g)) {
  const uses = (ui.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length
  if (uses === 0) problems.push(`刻度 ${name} 定义了但 ui.go 里没用`)
}

// 6) 裸数字回潮：ui.go 里不该再出现「FontSize(13)」这种手写值。
const bare = [...ui.matchAll(/\.FontSize\(\s*([0-9.]+)\s*\)/g)].map(m => m[1])
if (bare.length) problems.push(`ui.go 里还有 ${bare.length} 处裸字号: ${[...new Set(bare)].join(', ')}`)

// 7) 调色板里声明的每个颜色字段，两套主题都要有实值。
//    漏赋值时 ui.Color 是零值（alpha=0），画出来完全透明；只查「颜色出现过」抓不到。
const declared = [...theme.matchAll(/^\s*(\w+)\s+ui\.Color\b/gm)].map(m => m[1])
for (const [name, block] of [['LightPalette', theme.match(/var LightPalette = Palette\{([\s\S]*?)\n\}/)?.[1] ?? ''],
  ['DarkPalette', theme.match(/var DarkPalette = Palette\{([\s\S]*?)\n\}/)?.[1] ?? '']]) {
  const set = new Set([...block.matchAll(/(\w+)\s*:/g)].map(m => m[1]))
  for (const field of declared) {
    if (!set.has(field)) problems.push(`${name} 缺字段 ${field}：零值是透明，画出来会少一整块`)
  }
}

if (problems.length) {
  console.error('design: 与设计稿不一致')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log(
  `design: 通过（${desktopBoards.length} 张桌面画板 + ${mobileBoards.length} 张手机画板：` +
  `${sizes.size} 个字号、${radii.size} 个圆角、${brandColors.length} 个颜色都与实现对得上）`,
)
