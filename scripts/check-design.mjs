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
const design = readFileSync(join(root, 'designs/personal-agent/project/Desktop.dc.html'), 'utf8')
const theme = readFileSync(join(root, 'desktop/theme.go'), 'utf8')

const problems = []

// 1) 设计稿用到的每个字号，主题里都要有对应刻度。
const sizes = new Set([...design.matchAll(/font-size:\s*([0-9.]+)px/g)].map(m => Number(m[1])))
const scale = new Set([...theme.matchAll(/Font\w+\s*=\s*([0-9.]+)/g)].map(m => Number(m[1])))
for (const size of [...sizes].sort((a, b) => a - b)) {
  if (!scale.has(size)) problems.push(`设计稿里的 ${size}px 在 theme.go 的刻度里没有对应项`)
}

// 2) 圆角同理。
const radii = new Set([...design.matchAll(/border-radius:\s*(\d+)px/g)].map(m => Number(m[1])))
const radiusScale = new Set([...theme.matchAll(/Radius\w+\s*=\s*(\d+)/g)].map(m => Number(m[1])))
for (const r of [...radii].sort((a, b) => a - b)) {
  if (!radiusScale.has(r)) problems.push(`设计稿里的圆角 ${r}px 在 theme.go 里没有对应项`)
}

// 3) 亮色主题的每个品牌色都必须是设计稿里出现过的值。
const brandColors = ['#FBF9F6', '#FFFFFF', '#1F1D1A', '#57524A', '#8A8377', '#EDE8E1', '#3E6B62', '#F3F0EA', '#EAF1EC', '#96603A', '#F6EEE6']
const upper = design.toUpperCase()
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

if (problems.length) {
  console.error('design: 与设计稿不一致')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log(`design: 通过（${sizes.size} 个字号、${radii.size} 个圆角、${brandColors.length} 个颜色都与设计稿对得上）`)
