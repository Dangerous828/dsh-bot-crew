/**
 * 睡眠期提炼：把一段原始对话提炼成可入库的结构化事实。
 *
 * 为什么默认不用模型：这里跑在 consolidator 的异步路径上，但一条提炼结果必须能回查、
 * 且不能因为模型抽风把账本写脏。默认实现复用 `settle.ts` 的规则——认出「定下来的规矩」，
 * 每条都指回原话。这是一条确定、可测、零模型调用的底线。
 *
 * 想更聪明（像 Muse 那样读意思、提炼偏好）：注入一个 LLM 版 `Distiller` 即可，形如下面的
 * `makeLlmDistiller`。中枢做睡眠期巩固时，用的就是中枢侧更强的提炼器；本机没中枢时退回
 * 这个规则版，功能不残废。
 */
import { looksDurable, type Fact } from './settle.ts'

export interface Distiller {
  /** 把一段原始文本提炼成若干事实；没有可记的返回空数组。`at` 是这段的秒级时间。 */
  distill(text: string, at: number): Promise<Fact[]>
}

/** 话题前缀：取第一句，压到 40 字，作为去重键与标题的共同来源。 */
function subjectOf(text: string): string {
  const first = text.split(/[。！？!?\n]/).map(part => part.trim()).find(Boolean) ?? text
  const flat = first.replace(/\s+/g, ' ').trim()
  return flat.length > 40 ? flat.slice(0, 40) : flat
}

/**
 * 规则版提炼器（默认）：一段文本里，凡是像「定下来的规矩」的整句，各记一条。
 *
 * 切句而不是整段入账——一段里可能夹着闲聊和一句规矩，只把规矩那句留下。
 * 去重键带话题前缀：同一句规矩换个语气再说，键一样，账本不会攒近义条目。
 */
export class RuleDistiller implements Distiller {
  async distill(text: string, at: number): Promise<Fact[]> {
    const sentences = text.split(/(?<=[。！？!?\n])/).map(part => part.trim()).filter(Boolean)
    const facts: Fact[] = []
    const seen = new Set<string>()
    for (const sentence of sentences) {
      if (!looksDurable(sentence)) continue
      const subject = subjectOf(sentence)
      const key = `person:${subject}`
      if (seen.has(key)) continue
      seen.add(key)
      facts.push({
        description: sentence.length > 80 ? `${sentence.slice(0, 80)}…` : sentence,
        body: `主人原话：「${sentence}」\n\n记于 ${new Date(at * 1000).toISOString()}（睡眠期提炼）。`,
        type: 'feedback', importance: 5, dedupe_key: key,
      })
    }
    return facts
  }
}

/**
 * LLM 版提炼器的工厂（留作中枢侧或本机装了便宜模型时用）。
 *
 * `complete` 是一次「给提示词、回一段 JSON」的补全：由调用方按宿主 llm 服务的流式接口实现
 * （中枢侧或宿主侧各有自己的接法）。产出必须是 `{ facts: Fact[] }` 的 JSON；解析失败返回空，
 * 不让一次坏输出污染账本。给成这个形状，是为了把「怎么调模型」和「提炼逻辑」解耦。
 */
export function makeLlmDistiller(complete: (prompt: string) => Promise<string>): Distiller {
  const system = '你是记忆提炼器。读一段主人说过的话，只提炼「长期有效的偏好/决定/约定」，'
    + '忽略一次性的闲聊与任务细节。输出 JSON：{"facts":[{"description":单行标题,'
    + '"body":原话+说明,"type":"user|feedback|project|reference","importance":1-5,"dedupe_key":话题前缀}]}。'
    + '没有值得长期记住的就输出 {"facts":[]}。'
  return {
    async distill(text: string, at: number): Promise<Fact[]> {
      let raw: string
      try { raw = await complete(`${system}\n\n时间：${new Date(at * 1000).toISOString()}\n\n主人说：\n${text}`) }
      catch { return [] }
      try {
        const parsed = JSON.parse(raw) as { facts?: unknown }
        if (!Array.isArray(parsed.facts)) return []
        return parsed.facts.flatMap(item => {
          const f = item as Partial<Fact> & { dedupe_key?: string }
          if (typeof f.description !== 'string' || typeof f.body !== 'string' || typeof f.dedupe_key !== 'string') return []
          const type = f.type === 'user' || f.type === 'project' || f.type === 'reference' ? f.type : 'feedback'
          return [{ description: f.description, body: f.body, type, importance: typeof f.importance === 'number' ? f.importance : 4, dedupe_key: f.dedupe_key }]
        })
      } catch { return [] }
    },
  }
}
