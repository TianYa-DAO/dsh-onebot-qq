/**
 * mem-graph — 长期记忆（星图联想）子插件（id: 'mem-graph'，order: 92）
 *
 * 干什么：把「绘梨衣的长期记忆」接进回话链路 —— 记忆本体在外部服务 `memd`
 * （默认 `http://127.0.0.1:18082`，SQLite + 扩散激活检索；见 /home/ubuntu/mem-graph/）。
 *
 * 两条纪律（照抄 group-memory 的教训）：
 *  ① **只给指针，不贴正文**。回话前只塞一行「有 N 条相关记忆」+ 第一条摘要；
 *     正文由它自己调 `recall_memory` 取 —— 贴正文会被模型当成"群友说的话"，且白烧上下文。
 *  ② **失败一律静默降级**：memd 没起 / 超时 / 500 → 什么都不加，绝不拖住这一轮。
 *
 * 保密：群聊里检索时**排除私聊来源的记忆**（includeSecret=false）；
 *      私聊里才允许带私聊记忆。私聊里的事不该出现在群里。
 */

const DEFAULT_ENDPOINT = 'http://127.0.0.1:18082'

/** 一行摘要：去掉换行、截断 */
function oneLine(s, max = 60) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

export default {
  id: 'mem-graph',
  title: '长期记忆（星图）',
  order: 92,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '长期记忆', label: '长期记忆（回话前给指针）',
      hint: '开：回话前查一次相关记忆，给一行指针，它能自己调 recall_memory 细看。关：完全不用长期记忆。',
    },
    endpoint: {
      type: 'str', default: DEFAULT_ENDPOINT, group: '长期记忆', label: '记忆服务地址',
      hint: 'memd 的 HTTP 地址（本机）。默认 http://127.0.0.1:18082，一般不用改。',
    },
    recallK: {
      type: 'int', default: 5, min: 1, max: 10, step: 1, group: '长期记忆', label: '工具默认回想条数',
      hint: '它调 recall_memory 时默认取几条（最多 10）。',
    },
    pointerEnabled: {
      type: 'bool', default: true, group: '长期记忆', label: '回话前自动给指针',
      hint: '关：不再自动提示，只能靠它自己想起来查（省一点延迟）。',
    },
    pointerMinChars: {
      type: 'int', default: 6, min: 1, max: 60, step: 1, group: '长期记忆', label: '消息至少多少字才查',
      hint: '太短的话（「在吗」「哈哈」）不值得查记忆。',
    },
    timeoutMs: {
      type: 'int', default: 1500, min: 200, max: 8000, step: 100, unit: '毫秒', group: '长期记忆', label: '查询超时',
      hint: '超过就当作没有记忆、继续回话（不拖住这一轮）。',
    },
  },

  setup(bot) {
    const cfg = bot.cfg || {}
    const log = bot.log

    const endpointOf = () => String(cfg.endpoint || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '')
    const timeoutOf = () => (Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 1500)
    const kOf = () => (Number(cfg.recallK) > 0 ? Number(cfg.recallK) : 5)

    /** 是否该在群聊里看到私聊记忆 —— 群聊永远 false（保密） */
    const secretAllowed = (chatKey) => !String(chatKey || '').startsWith('group:')

    async function callRecall({ text, chatKey, k, depth = 2, minScore = 0 }) {
      if (!String(text || '').trim()) return []
      try {
        const res = await fetch(`${endpointOf()}/api/recall`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: String(text).slice(0, 400),
            chat: chatKey || '',
            k: Math.max(1, Math.min(10, Number(k) || kOf())),
            depth,
            includeSecret: secretAllowed(chatKey),
            bump: true,
          }),
          signal: AbortSignal.timeout(timeoutOf()),
        })
        if (!res.ok) return []
        const data = await res.json()
        const items = Array.isArray(data?.items) ? data.items : []
        return items.filter((x) => Number(x?.score || 0) >= minScore)
      } catch (e) {
        // 记忆服务没起 / 超时 → 静默降级
        try { log.debug(`[长期记忆] 查询失败（已忽略）: ${e?.message || e}`) } catch { /* 忽略 */ }
        return []
      }
    }

    // ── 入口 ①：回话前给一行指针 ─────────────────────────────
    bot.on('before-turn', async (ev) => {
      if (cfg.enabled === false) return
      if (cfg.pointerEnabled === false) return
      if (!ev?.wake) return
      if (ev.wake.kind === 'welcome') return
      const text = String(ev.text || '').trim()
      if (text.length < (Number(cfg.pointerMinChars) || 6)) return

      const hits = await callRecall({ text, chatKey: ev.chatKey, k: 3, depth: 2, minScore: 0.25 })
      if (!hits.length) return
      const top = hits[0]
      const secretTag = top.secret && !secretAllowed(ev.chatKey) ? '（私聊来源，别在群里说）' : ''
      ev.hint.push(
        `[长期记忆] 有 ${hits.length} 条可能相关的记忆${secretTag}：${oneLine(top.content, 50)}`
        + '｜需要更多细节就调 recall_memory（别把私聊里的事搬到群里）',
      )
      log.debug(`[长期记忆] 指针 ${ev.chatKey}: ${hits.length} 条，首条分 ${top.score}`)
    })

    // ── 入口 ②：工具 recall_memory ───────────────────────────
    bot.registerTool('recall_memory', {
      description:
        '翻绘梨衣的长期记忆（星图式联想，不是关键词检索）。'
        + '输入一个话题/人名/事件，它会沿关联把相关记忆都找出来 —— 即使字面完全不同。\n'
        + '什么时候用：对方提到以前的事、你想确认某个人的近况、或者想接一句「我记得你…」的话。\n'
        + '**群聊里检索不到私聊来源的记忆**（私事不该在群里说）；私聊里可以。',
      parameters: {
        query: { type: 'string', required: true, description: '要找什么：一个词、一句话都行（例：「小洛 考试」「上次说的服务器」）' },
        k: { type: 'integer', description: `取几条（默认 ${5}，最多 10）` },
      },
      async execute(args = {}) {
        if (cfg.enabled === false) throw new Error('长期记忆已关闭')
        const query = String(args?.query || '').trim()
        if (!query) throw new Error('recall_memory 需要 query')
        const turn = bot.currentTurn?.()
        const chatKey = String(turn?.chatKey || '')
        const k = Math.max(1, Math.min(10, Number(args?.k) || kOf()))

        let res
        try {
          const r = await fetch(`${endpointOf()}/api/recall`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: query, chat: chatKey, k, depth: 3, includeSecret: secretAllowed(chatKey), bump: true }),
            signal: AbortSignal.timeout(Math.max(3000, timeoutOf() * 2)),
          })
          if (!r.ok) throw new Error(`记忆服务返回 ${r.status}`)
          res = await r.json()
        } catch (e) {
          throw new Error(`记忆服务不可用（${e?.message || e}）`)
        }
        const items = Array.isArray(res?.items) ? res.items : []
        if (!items.length) return { ok: true, remembered: 0, memories: [], hint: '记忆里没有相关的事' }
        const lines = items.map((x, i) => {
          const when = x.created_at ? new Date(Number(x.created_at) * 1000).toISOString().slice(0, 10) : ''
          const tag = x.secret && !secretAllowed(chatKey) ? '［私聊·勿外传］' : ''
          return `${i + 1}. ${tag}${x.content}${x.who ? `（${x.who}）` : ''}${when ? ` · ${when}` : ''}`
        })
        log.info(`[长期记忆] 自读「${query}」→ ${items.length} 条`)
        return {
          ok: true, remembered: items.length, memories: items.map((x) => ({
            content: x.content, who: x.who, topics: x.topics, score: x.score,
            secret: !!x.secret, created_at: x.created_at,
          })),
          text: lines.join('\n'),
          hint: items.some((x) => x.secret)
            ? '带［私聊·勿外传］的是私聊里的私事，别在群里说出来'
            : undefined,
        }
      },
    })
  },
}
