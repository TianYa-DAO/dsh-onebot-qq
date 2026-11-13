/**
 * qzone — QQ空间（说说）子插件（id: 'qzone'，order: 93）
 *
 * 能力：看自己发过的说说、发一条新说说（可带图）、删掉某条。
 * 实现全在外部服务 `qzd`（默认 http://127.0.0.1:18083）：
 *   · 认证走 NapCat 的 get_cookies → skey → g_tk（不用你手填 cookie）
 *   · 发图 base64 直传 up.qzone.qq.com（本地图直接能发，不需要公网 URL）
 *   · 读说说 feeds3 scope=1；删说说 web 接口，失败退 NapCat 原生
 *
 * 纪律：
 *  ① **失败一律降级**：服务没起/超时 → 工具返回原因，不抛未捕获异常、不拖住回话。
 *  ② **发说说只认主人**：默认只有主人私聊里能发（说说公开可见，不能让它随手发）。
 *  ③ 一次只发一条；不自动重试（避免重复发）。
 */

const DEFAULT_ENDPOINT = 'http://127.0.0.1:18083'

export default {
  id: 'qzone',
  title: 'QQ空间（说说）',
  order: 93,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '空间', label: 'QQ空间功能',
      hint: '关掉后工具全部不可用（她不能在聊天里看/发/删说说）。',
    },
    endpoint: {
      type: 'str', default: DEFAULT_ENDPOINT, group: '空间', label: '空间服务地址',
      hint: 'qzd 的 HTTP 地址（本机）。默认 http://127.0.0.1:18083。',
    },
    masterQq: {
      type: 'str', default: '', group: '空间', label: '主人 QQ（留空 = 用内核的）',
      hint: '只有这个人的私聊里允许「发说说 / 删说说」（说说公开可见，防误发）。'
        + '**留空就用实例配置里的主人 QQ**（推荐留空，换主人不用改两处）。看说说不受限。',
    },
    allowSelfPost: {
      type: 'bool', default: true, group: '空间', label: '允许她主动发（不等主人开口）',
      hint: '开：她自己想发就能发（任何会话里都行），只受「每天上限 / 最小间隔」约束；'
        + '关：退回旧行为——只有主人私聊里要求才能发。夜间自动发帖已停用，发帖只走这条路。',
    },
    whoCanSee: {
      type: 'int', default: 1, min: 1, max: 4, step: 1, group: '空间', label: '说说可见范围',
      hint: '1 = 公开；2 = 私密（仅自己）；4 = 好友可见。默认公开。',
    },
    timeoutMs: {
      type: 'int', default: 45000, min: 3000, max: 180000, step: 1000, unit: '毫秒', group: '空间', label: '超时',
      hint: '带图发布要传图，慢一点正常。超过就报错（不会自动重试）。',
    },
  },

  setup(bot) {
    const cfg = bot.cfg || {}
    const log = bot.log

    const endpointOf = () => String(cfg.endpoint || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '')
    const timeoutOf = () => (Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 45000)

    async function qz(path, payload, method = 'GET') {
      const opt = {
        method,
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutOf()),
      }
      if (method === 'POST') opt.body = JSON.stringify(payload || {})
      const res = await fetch(`${endpointOf()}${path}`, opt)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data?.ok === false) throw new Error(data?.error || `空间服务返回 ${res.status}`)
      return data
    }

    /** 当前会话是不是主人私聊（发说说的门槛） */
    function isMasterTurn() {
      const turn = bot.currentTurn?.()
      const chatKey = String(turn?.chatKey || '')
      // 优先用插件配置；留空则跟随内核的 adminQq（单一真源，换主人不用改两处）
      const master = String(cfg.masterQq || '').trim() || String(Number(bot.core?.adminQq) || '')
      if (!master) return false
      return chatKey === `private:${master}`
    }

    /**
     * 发说说的共享额度：跟 qzd 的「按心情自动发」用**同一份配置和同一份记录**。
     * 为什么必须共享：不然她白天在对话里发一条、晚上守护进程再发一条 → 一天两条，
     * 而且彼此都不知道对方发过（说说这种公开内容「一天一条」是她的人设节奏）。
     * @returns {Promise<{can:boolean, why:string, todayCount:number, maxPerDay:number, lastAt:number}>}
     */
    async function postQuota() {
      let maxPerDay = 1
      let minGapHours = 18
      try {
        const c = await qz('/api/qz/config')
        const cc = c?.config || {}
        if (Number(cc.maxPerDay) > 0) maxPerDay = Number(cc.maxPerDay)
        if (Number(cc.minGapHours) > 0) minGapHours = Number(cc.minGapHours)
      } catch { /* 拿不到配置就用默认（1 条/18 小时） */ }
      let items = []
      try {
        const d = await qz('/api/qz/feeds?num=50')
        items = Array.isArray(d?.items) ? d.items : []
      } catch { /* 拿不到记录：宁可放行，但下面还有别的约束 */ }
      const nowSec = Math.floor(Date.now() / 1000)
      const today = new Date(nowSec * 1000).toISOString().slice(0, 10)
      const dayOf = (sec) => new Date(Number(sec) * 1000).toISOString().slice(0, 10)
      const todayCount = items.filter((x) => dayOf(x.created_at) === today).length
      const lastAt = items.reduce((m, x) => Math.max(m, Number(x.created_at) || 0), 0)
      if (todayCount >= maxPerDay) {
        return { can: false, why: `今天已经发过 ${todayCount} 条了（上限 ${maxPerDay} 条/天），明天再说`, todayCount, maxPerDay, lastAt }
      }
      if (lastAt && nowSec - lastAt < minGapHours * 3600) {
        const hours = Math.floor((nowSec - lastAt) / 3600)
        return { can: false, why: `离上一条才 ${hours} 小时（要隔 ${minGapHours} 小时），这次先不发`, todayCount, maxPerDay, lastAt }
      }
      return { can: true, why: '', todayCount, maxPerDay, lastAt }
    }

    // ── 主人私聊时：有待批准草稿就提一句（她好开口问）────────
    bot.on('before-turn', async (ev) => {
      if (cfg.enabled === false) return
      if (!ev?.wake) return
      if (String(ev.chatKey || '') !== `private:${String(cfg.masterQq || '').trim()}`) return
      // 自己刚批准/拒绝的那轮不重复提示
      try {
        const d = await qz('/api/qz/pending')
        const items = d.items || []
        if (!items.length) return
        const top = items[0]
        ev.hint.push(
          `[空间草稿待确认] 你有一条想发、但提到别人的说说（id=${top.id}，涉及：${(top.involves || []).join('、') || '—'}）：`
          + `「${String(top.content).slice(0, 60)}」`
          + '。规则是**问涉及的那个人本人**（不是问主人）：先私聊问他能不能发，他同意后再 qzone_approve 发出去，'
          + '不同意就用 qzone_reject 丢掉。别自己先发，也别在群里提这件事。',
        )
      } catch { /* 空间服务不可用 → 静默 */ }
    })

    // ── 看说说 ────────────────────────────────────────────
    bot.registerTool('qzone_list', {
      description:
        '看你自己的 QQ 空间里最近发过的说说（内容、时间、配图数量）。'
        + '想接自己的梗、或者确认某条说过没有时用。只读，不修改任何东西。',
      parameters: {
        num: { type: 'integer', description: '看几条（默认 8，最多 30）' },
      },
      async execute(args = {}) {
        if (cfg.enabled === false) throw new Error('QQ空间功能已关闭')
        const num = Math.max(1, Math.min(30, Number(args?.num) || 8))
        let d
        try {
          d = await qz(`/api/qz/feeds?num=${num}`)
        } catch (e) {
          throw new Error(`读空间失败（${e?.message || e}）`)
        }
        const items = (d.items || []).map((x) => ({
          tid: x.tid,
          content: x.content,
          created_at: x.created_at,
          pics: (x.pics || []).length,
        }))
        if (!items.length) return { ok: true, count: 0, hint: '空间里还没有说说' }
        const lines = items.map((x, i) => {
          const when = x.created_at ? new Date(x.created_at * 1000).toISOString().slice(0, 10) : ''
          return `${i + 1}. [${when}] ${x.content || '（只有图）'}${x.pics ? `（配图 ${x.pics} 张）` : ''}`
        })
        log.info(`[空间] 看了 ${items.length} 条说说`)
        return { ok: true, count: items.length, items, text: lines.join('\n') }
      },
    })

    // ── 发说说 ────────────────────────────────────────────
    bot.registerTool('qzone_post', {
      description:
        '在你自己的 QQ 空间发一条说说（**公开可见**）。这是你自己的能力：'
        + '**想发就可以自己发**，不用等主人开口、也不用报备。'
        + '额度：一天最多 1 条、跟上一条约隔 18 小时（可在控制台调；超了会明确告诉她下次）。'
        + '**要不要问、问谁，只看那件事是从哪来的**（不用问主人）：'
        + '来自**私聊**（某个人的悄悄话、私下告诉她的事）→ **先私聊问那个人本人**「这句我能发到空间吗」，'
        + '他说可以才发、说不行就不发；涉及几个人就问几个，有一个不同意就别发那条。'
        + '来自**群聊**（群里公开说过的）→ **直接发，谁都不用问**。'
        + '**别人让她发**（群里或别人私聊让她发）→ 不发，说「这个我自己来」就行。'
        + '文字要像她自己写的：短、具体、不喊口号、不堆形容词、别用感叹号。一次只发一条。'
        + '发完不用在对话里复述全文，也不用说「我发了说说」。',
      parameters: {
        content: { type: 'string', required: true, description: '说说的正文（像她自己写的一句话，不超过 200 字）' },
        image_path: { type: 'string', description: '可选：要配的本地图片路径（绝对路径）' },
      },
      async execute(args = {}) {
        if (cfg.enabled === false) throw new Error('QQ空间功能已关闭')
        const content = String(args?.content || '').trim()
        // 谁能发：
        //   · 主人私聊 → 一直允许（他要求的，或者她在他面前想发）
        //   · 其它会话 → 只有 allowSelfPost 开着才允许，且必须过共享额度
        //     为什么放开：她要"想发就发"；为什么仍要额度：说说公开可见，
        //     而且跟夜间自动发说说共用预算，否则一天会冒出两条。
        if (!isMasterTurn()) {
          if (cfg.allowSelfPost === false) {
            throw new Error('发说说只允许主人在私聊里要求（说说公开可见，不能随手发）')
          }
          const q = await postQuota()
          if (!q.can) throw new Error(`这次先不发：${q.why}`)
        }
        if (!content) throw new Error('说说明文不能为空')
        if (content.length > 500) throw new Error('说说太长（>500 字）')
        const payload = { content, whoCanSee: Number(cfg.whoCanSee) || 1 }
        const img = String(args?.image_path || '').trim()
        if (img) payload.images = [img]
        let d
        try {
          d = await qz('/api/qz/publish', payload, 'POST')
        } catch (e) {
          throw new Error(`发说说失败（${e?.message || e}）`)
        }
        log.info(`[空间] 发了说说 tid=${d.tid} 图=${img ? 1 : 0} 字=${content.length}`)
        return {
          ok: true, tid: d.tid,
          content, image: img || null,
          hint: '发好了。别在对话里复述这条说说的全文，也没必要说"我发了说说"。',
        }
      },
    })

    // ── 草稿：她自己拿不准时先搁着，问完当事人再发 ──────────────
    bot.registerTool('qzone_pending', {
      description: '看有没有「先搁着、等确认」的说说草稿（涉及别人私聊隐私的）。'
        + '只读。规则：先私聊问**涉及的那个人本人**能不能发，他说可以之后才用 qzone_approve 发出去；'
        + '他不同意就用 qzone_reject 丢掉。（不是问主人）',
      parameters: {},
      async execute() {
        if (cfg.enabled === false) throw new Error('QQ空间功能已关闭')
        let d
        try { d = await qz('/api/qz/pending') } catch (e) { throw new Error(`读待批准列表失败（${e?.message || e}）`) }
        const items = d.items || []
        if (!items.length) return { ok: true, count: 0, items: [], hint: '没有待批准的说说' }
        const lines = items.map((x, i) =>
          `${i + 1}. id=${x.id}｜涉及：${(x.involves || []).join('、') || '—'}｜${x.content}`)
        return { ok: true, count: items.length, items, text: lines.join('\n') }
      },
    })

    bot.registerTool('qzone_approve', {
      description: '确认之后，把挂起的那条说说发出去。**发之前必须先问过涉及的那个人本人、他说可以**。'
        + '（这是主人私聊里的入口；她在别处也可以问完之后直接 qzone_post）',
      parameters: {
        id: { type: 'string', required: true, description: '草稿 id（qzone_pending / 提示里给的那串，形如 d1793...）' },
      },
      async execute(args = {}) {
        if (cfg.enabled === false) throw new Error('QQ空间功能已关闭')
        if (!isMasterTurn()) throw new Error('只有主人在私聊里能批准发说说')
        const id = String(args?.id || '').trim()
        if (!/^d?[0-9]{6,20}$/.test(id)) throw new Error('草稿 id 格式不对')
        let d
        try { d = await qz('/api/qz/approve', { id }, 'POST') } catch (e) { throw new Error(`发布失败（${e?.message || e}）`) }
        log.info(`[空间] 主人批准后发出 tid=${d.tid} 草稿=${id}`)
        return { ok: true, tid: d.tid, draft: id, hint: '发好了。不必在聊天里复述全文。' }
      },
    })

    bot.registerTool('qzone_reject', {
      description: '这条不发了，把草稿丢掉（不会发出去）。对方不同意、或者你自己觉得不合适时用。',
      parameters: {
        id: { type: 'string', required: true, description: '草稿 id' },
      },
      async execute(args = {}) {
        if (cfg.enabled === false) throw new Error('QQ空间功能已关闭')
        if (!isMasterTurn()) throw new Error('只有主人在私聊里能拒绝说说')
        const id = String(args?.id || '').trim()
        if (!/^d?[0-9]{6,20}$/.test(id)) throw new Error('草稿 id 格式不对')
        let d
        try { d = await qz('/api/qz/reject', { id }, 'POST') } catch (e) { throw new Error(`取消失败（${e?.message || e}）`) }
        log.info(`[空间] 主人拒绝草稿 ${id}`)
        return { ok: true, rejected: id }
      },
    })

    // ── 删说说 ────────────────────────────────────────────
    bot.registerTool('qzone_delete', {
      description: '删掉你 QQ 空间里的某条说说（需要 tid，先用 qzone_list 拿到）。只有主人私聊里能用。',
      parameters: {
        tid: { type: 'string', required: true, description: '说说的 tid（qzone_list 返回里那串）' },
      },
      async execute(args = {}) {
        if (cfg.enabled === false) throw new Error('QQ空间功能已关闭')
        if (!isMasterTurn()) throw new Error('删说说只允许主人在私聊里操作')
        const tid = String(args?.tid || '').trim()
        if (!/^[0-9a-zA-Z]{10,40}$/.test(tid)) throw new Error('tid 格式不对（应该是一串字母数字）')
        let d
        try {
          d = await qz('/api/qz/delete', { tid }, 'POST')
        } catch (e) {
          throw new Error(`删说说失败（${e?.message || e}）`)
        }
        log.info(`[空间] 删了说说 tid=${tid} via=${d.via}`)
        return { ok: true, tid, via: d.via }
      },
    })
  },
}
