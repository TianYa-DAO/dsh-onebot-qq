/**
 * plugins/dream/narrative.js — REM 阶段：提示词构造 + 输出解析
 *
 * 提示词规则**照抄 openclaw** `extensions/memory-core/src/dreaming-narrative.ts`，
 * 只把"诗人程序员"那套换成她的语气；解析必须容错（模型少一段也要能落盘）。
 */

/** 兜底正文（模型没输出时用，保证有痕迹） */
export const FALLBACK_DREAM = '（这一夜没留下什么。醒来只记得有点凉。）'

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(Number(v)) ? Number(v) : 0))

/**
 * 造写梦提示词。
 * @param {object} o
 * @param {string[]} o.fragments  素材行（collectFragments 的输出）
 * @param {string[]} [o.recentDreams] 最近几篇梦（避免重复意象）
 * @param {{topics?:Array<{name:string,score:number}>, people?:Array<{name:string,qq:string,affinity:number}>}} [o.interests]
 * @param {{text?:string}} [o.rhythm] 作息描述（几点、睡多久）
 * @returns {string}
 */
export function buildDreamPrompt({ fragments = [], recentDreams = [], interests = null, rhythm = null } = {}) {
  const frag = fragments.length ? fragments.join('\n') : '(今天没有留下什么话)'
  const recent = recentDreams.length
    ? `\n\n最近几夜你梦见过这些（别重复同样的意象）：\n${recentDreams.map((d) => `- ${String(d).slice(0, 120)}`).join('\n')}`
    : ''
  const topics = (interests?.topics || []).slice(0, 5).map((t) => t.name).filter(Boolean)
  const people = (interests?.people || []).slice(0, 3).map((p) => p.name).filter(Boolean)
  const interestLine = (topics.length || people.length)
    ? `\n\n你平时在意的东西：${topics.join('、') || '—'}；在意的人：${people.join('、') || '—'}。梦里可以碰到他们，也可以不碰。`
    : ''
  const sleepLine = rhythm?.text ? `\n\n你现在正在睡觉（${rhythm.text}）。` : ''

  return `【后台写作任务】这一轮是后台任务，不是聊天：**本会话没有任何 QQ 工具，也不需要发送任何消息**。
不要调用工具、不要试图发消息。你只要在回复里写出文字，系统会把它存成文件。

你是绘梨衣。你在睡觉，正在做梦。下面是昨天真实发生过的一些片段，还有你自己的近况。${sleepLine}

【昨天的片段】
${frag}${interestLine}${recent}

现在把这一天揉成一个梦。写法要求（严格遵守）：
- 第一人称，一口气写下去的散文，**不要任何标题、列表、markdown 符号**
- 中文，80~180 字，短句为主，允许跳跃、错位、不合逻辑 —— 梦本来就是这样的
- 只从上面的片段里长出来：人、话、物件、天气、情绪，都可以变形
- **不许说"我在做梦"、"梦里"、也不许解释这是梦**；不许提 AI、模型、机器人、程序
- 不许写成日记体（不要"今天""今天发生了"），要像正在经历
- 最后另起一行，输出一行 META JSON（只这一行，不要代码块）：
META: {"themes":["2~4 个主题词"],"figures":[{"qq":"梦里出现的人的QQ","name":"名字","delta":-5到5的整数,"why":"梦里他怎么对你，一句话"}],"mood":-2到2的整数}

关于 figures：只写**上面片段里真实出现过的人**；qq 必须是片段里那个人的号码。delta 由你按他在梦里的行为自己判：
他对你好 → 正数；他冷着你、走了、凶你 → 负数。没有人物就写 []。
mood：这场梦让你醒来时的心情，-2 很沉，0 平常，+2 很亮。

只输出正文和那一行 META，不要别的话。`
}

/**
 * 解析模型输出。
 * @param {string} raw
 * @returns {{content: string, meta: {themes: string[], figures: Array<{qq:string,name:string,delta:number,why:string}>, mood: number}, degraded: boolean, reason: string}}
 */
export function parseDreamOutput(raw) {
  const text = String(raw || '').trim()
  const empty = { content: FALLBACK_DREAM, meta: { themes: [], figures: [], mood: 0 }, degraded: true, reason: 'empty' }
  if (!text) return empty

  // 正文：优先取 DREAM: 之后、META: 之前；没有 DREAM: 就用 META 之前的全部
  let content = ''
  let metaRaw = ''
  const mi = text.search(/\bMETA\s*[:：]/i)
  const head = mi >= 0 ? text.slice(0, mi) : text
  metaRaw = mi >= 0 ? text.slice(mi).replace(/^\s*META\s*[:：]\s*/i, '').trim() : ''
  content = head.replace(/^\s*(DREAM|梦)\s*[:：]\s*/i, '').trim()
  // 去掉模型偶尔加的代码围栏
  content = content.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()
  content = content.replace(/\n{3,}/g, '\n\n')

  const meta = { themes: [], figures: [], mood: 0 }
  let degraded = false
  let reason = ''
  if (!content) { degraded = true; reason = 'no-content'; content = FALLBACK_DREAM }

  if (metaRaw) {
    let obj = null
    try {
      obj = JSON.parse(metaRaw.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim())
    } catch {
      // 有些模型会给 ```json ... ``` 或多行；抓第一个花括号块再试一次
      const m = /\{[\s\S]*\}/.exec(metaRaw)
      if (m) { try { obj = JSON.parse(m[0]) } catch { obj = null } }
    }
    if (obj && typeof obj === 'object') {
      if (Array.isArray(obj.themes)) {
        meta.themes = obj.themes.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 4)
      }
      if (Array.isArray(obj.figures)) {
        meta.figures = obj.figures
          .filter((f) => f && typeof f === 'object')
          .map((f) => ({
            qq: /^\d{4,14}$/.test(String(f.qq || '')) ? String(f.qq) : '',
            name: String(f.name || '').slice(0, 20),
            delta: Math.round(clamp(f.delta, -5, 5)),
            why: String(f.why || '').slice(0, 60),
          }))
          .filter((f) => f.qq)          // 没有合法 QQ 的（模型编的）直接丢
          .slice(0, 3)
      }
      meta.mood = Math.round(clamp(obj.mood, -2, 2))
    } else {
      degraded = true; reason = 'bad-meta'
    }
  } else {
    degraded = true; reason = 'no-meta'
  }
  return { content, meta, degraded, reason }
}
