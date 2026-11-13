/**
 * plugins/dream/index.js — 梦境系统（id: 'dream', order: 94）
 *
 * 她睡着的时候做一次梦：
 *   Light  素材抽取（本地，collect.js）
 *   REM    写梦（1 次 runIsolatedTask；narrative.js）
 *   Deep   巩固（本地规则，consolidate.js）：星图联想 + 兴趣微调 + 心情残留
 *
 * 纪律（别改）：
 *  ① 每夜最多 1 次模型调用，Deep 绝不调模型；
 *  ② 不做事实提炼（那是 04:00 每日沉淀的活），梦只写"联接"；
 *  ③ 梦里的人只在最近 7 天真实聊过的范围内生效，delta 夹 ±5、单次 ≤3 人、当天 |Δ|≤10；
 *  ④ 梦不按会话切分 —— 是她的梦；只有「别人的私事不点名」这条人设纪律照旧；
 *  ⑤ 幂等：lastDreamDay 一天一次，失败不补做。
 */
import fs from 'node:fs'
import path from 'node:path'
import { collectFragments } from './collect.js'
import { buildDreamPrompt, parseDreamOutput } from './narrative.js'
import { appendDream, readDreams, dateOf } from './dreams-file.js'
import { planEffects, dreamMomentOf } from './consolidate.js'

const STATE_FILE = 'dream.json'
const TICK_MS = 60 * 1000

export default {
  id: 'dream',
  title: '梦境',
  order: 94,

  configSchema: {
    enabled: { type: 'bool', default: true, group: '梦境', label: '做梦', hint: '她睡着时偶尔做一个梦：写一篇梦境日记，梦里的人会按行为影响她的好恶。关：完全不做。' },
    affectInterests: { type: 'bool', default: true, group: '梦境', label: '梦里的人影响她的好恶', hint: '梦里出现、且最近 7 天真实聊过的人，按梦里他的行为给她加分或减分（每人 ±5，单次最多 3 人）。' },
    affectMood: { type: 'bool', default: true, group: '梦境', label: '梦境影响当天心情', hint: '做了沉的梦 → 当天"主动找话"少一次（最低 1），次日自动恢复。不动人格、不改回复风格。' },
    keepDays: { type: 'int', default: 60, min: 7, max: 365, step: 7, group: '梦境', label: '梦境日记保留', unit: '天', hint: '梦境日记文件滚动裁剪，只留最近这么多天的段落。' },
    minFragments: { type: 'int', default: 6, min: 1, max: 30, step: 1, group: '梦境', label: '素材少于这么多就不做梦', hint: '没话可长成梦的时候不硬编。' },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const log = bot.log || console
    const dataDir = () => String(bot.core?.dataDir || '.').trim()
    const dreamsFile = () => path.join(dataDir(), 'dreams', 'DREAMS.md')
    const stateFile = () => path.join(dataDir(), 'state', STATE_FILE)
    const archiveDir = () => String(bot.core?.archive?.dir || path.join(dataDir(), 'logs', 'qq_chat')).trim()
    const memoryDir = () => path.join(dataDir(), 'qq-memory')
    const enabled = () => cfg().enabled !== false
    const keepDays = () => Math.max(7, Math.min(365, Math.round(Number(cfg().keepDays) || 60)))
    const minFragments = () => Math.max(1, Math.min(30, Math.round(Number(cfg().minFragments) || 6)))

    // ── 状态（state/dream.json）───────────────────────────────
    let state = { lastDreamDay: '', lastError: '', lastAt: 0, effects: [], hintedChats: {}, lastReason: '' }
    try {
      if (fs.existsSync(stateFile())) state = { ...state, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }
    } catch (e) { log.warn(`[梦] 状态读取失败（按空处理）: ${e.message}`) }
    const saveState = () => {
      try {
        fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
        const tmp = `${stateFile()}.${process.pid}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 })
        fs.renameSync(tmp, stateFile())
      } catch (e) { log.warn(`[梦] 状态写入失败: ${e.message}`) }
    }

    /** 这个 QQ 最近一次真实说话的时间（查归档），查不到返回 0 */
    function lastTalkAtOf(qqTarget) {
      const want = String(qqTarget)
      let best = 0
      let names = []
      try { names = fs.readdirSync(archiveDir()) } catch { return 0 }
      for (const name of names) {
        const m = /^(group|private)_(\d{1,14})\.jsonl$/.exec(name)
        if (!m) continue
        let rows = []
        try { rows = fs.readFileSync(path.join(archiveDir(), name), 'utf8').split('\n') } catch { continue }
        for (const line of rows) {
          if (!line.trim()) continue
          try {
            const r = JSON.parse(line)
            if (String(r?.sender?.qq ?? '') !== want) continue
            const ts = Number(r.ts) || 0
            if (ts > best) best = ts
          } catch { /* 坏行跳过 */ }
        }
      }
      return best
    }

    /** 星图联想：themes 写成 secret 记忆（不进群聊检索） */
    async function writeStarLink({ themes, content, nowMs }) {
      const base = String(bot.cfg?.memgraphEndpoint || 'http://127.0.0.1:18082').replace(/\/+$/, '')
      const body = {
        chat: 'dream',
        content: `梦境联想：${content}`,
        who: '我',
        topics: (themes || []).slice(0, 4),
        importance: 3,
        secret: true,
        at: nowMs,
      }
      const res = await fetch(`${base}/api/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) throw new Error(`mem-graph ${res.status}`)
      return true
    }

    // ── 主流程 ────────────────────────────────────────────────
    let running = false
    async function runDream({ force = false } = {}) {
      if (!enabled()) return { ok: false, reason: 'disabled' }
      if (running) return { ok: false, reason: 'busy' }
      running = true
      const nowMs = Date.now()
      const dayKey = dateOf(nowMs)
      try {
        if (!force && state.lastDreamDay === dayKey) return { ok: false, reason: 'already' }

        const frag = collectFragments({ archiveDir: archiveDir(), nowMs, maxItems: 30, maxChars: 4000 })
        if (!force && frag.lines.length < minFragments()) {
          state.lastReason = `素材不足(${frag.lines.length})`
          saveState()
          log.info(`[梦] 素材不足（${frag.lines.length} < ${minFragments()}），今晚不做梦`)
          return { ok: false, reason: 'too-few-fragments', count: frag.lines.length }
        }

        const interests = bot.pacing?.interestsView?.() || null
        const rhythm = (() => {
          try {
            const w = bot.pacing?.quietWindowFor?.(nowMs)
            if (!w) return null
            const h = Math.floor(Number(w.sleepMin || 0) / 60)
            return { text: `已经睡了大约 ${h} 小时`, bedtime: w.startMin, sleepMin: w.sleepMin, allNighter: !!w.allNighter }
          } catch { return null }
        })()
        const recentDreams = readDreams({ file: dreamsFile(), days: 3 }).map((e) => e.content.slice(0, 120))

        const prompt = buildDreamPrompt({ fragments: frag.lines, recentDreams, interests, rhythm })
        let raw = ''
        try {
          const task = await bot.dsh.runIsolatedTask({ name: `做梦(${dayKey})`, prompt, cwd: dataDir(), timeoutMs: 5 * 60 * 1000 })
          raw = String(task?.text || '')
        } catch (e) {
          state.lastError = `写梦失败: ${e.message}`
          saveState()
          log.warn(`[梦] ${state.lastError}`)
          return { ok: false, reason: 'model-failed', error: e.message }
        }

        let parsed = parseDreamOutput(raw)
        // 后台会话有时会"只思考不说话"（模型想调工具但没有工具）：重试一次，用最短的强制指令
        if (!String(raw || '').trim()) {
          log.warn('[梦] 第一次输出为空，用精简指令重试一次')
          try {
            const retry = await bot.dsh.runIsolatedTask({
              name: `做梦重试(${dayKey})`,
              prompt: `【后台写作任务·无工具】不要调用任何工具，也不要发消息。直接按下面格式输出中文，不要别的话：\nDREAM: 一段 80~180 字的第一人称梦境散文\nMETA: {"themes":["主题"],"figures":[],"mood":0}\n\n素材：\n${frag.lines.join('\n')}`,
              cwd: dataDir(),
              timeoutMs: 5 * 60 * 1000,
            })
            raw = String(retry?.text || '')
            parsed = parseDreamOutput(raw)
          } catch (e) { log.warn(`[梦] 重试也失败: ${e.message}`) }
        }
        if (!String(raw || '').trim()) {
          // 空输出不写占位（占位会污染日记），只记错误，明天再来
          state.lastError = '写梦输出为空（模型只思考没输出）'
          saveState()
          return { ok: false, reason: 'empty-output' }
        }

        // 落盘：梦境日记
        const metaLine = parsed.meta?.themes?.length
          ? `<!-- 主题: ${parsed.meta.themes.join(' / ')}${parsed.meta.mood ? ` · 心情 ${parsed.meta.mood}` : ''} -->`
          : ''
        const wrote = appendDream({ file: dreamsFile(), content: parsed.content, nowMs, keepDays: keepDays(), metaText: metaLine })

        // 巩固（Deep，本地规则）
        let effects = { adjusted: [], skipped: [], totalDelta: 0, moodApplied: null }
        if (wrote.ok) {
          effects = planEffects({
            meta: parsed.meta,
            nowMs,
            lastTalkAt: (qq) => lastTalkAtOf(qq),
          })
          if (cfg().affectInterests !== false) {
            for (const a of effects.adjusted) {
              try {
                bot.pacing?.noteInterest?.({ kind: 'person', qq: a.qq, delta: a.delta, why: `梦见：${a.why || '说不清'}` })
              } catch (e) { log.debug(`[梦] 兴趣写入失败 ${a.qq}: ${e.message}`) }
            }
          } else effects.adjusted = []
          if (cfg().affectMood !== false && effects.moodApplied) {
            try { bot.pacing?.setMood?.({ day: dayKey, penalty: 1 }) } catch (e) { log.debug(`[梦] 心情写入失败: ${e.message}`) }
          } else effects.moodApplied = null
          // 星图联想（失败不影响主流程）
          if (parsed.meta?.themes?.length) {
            try {
              await writeStarLink({ themes: parsed.meta.themes, content: parsed.content.slice(0, 120), nowMs })
            } catch (e) { log.debug(`[梦] 星图联想失败: ${e.message}`) }
          }
        }

        state = {
          ...state,
          lastDreamDay: dayKey,
          lastAt: nowMs,
          lastError: wrote.ok ? '' : `写入失败: ${wrote.error || '?'}`,
          lastReason: '',
          effects: effects.adjusted.map((a) => ({ qq: a.qq, delta: a.delta, why: a.why })),
          mood: parsed.meta?.mood ?? 0,
          themes: parsed.meta?.themes || [],
          degraded: parsed.degraded,
        }
        saveState()
        log.info(`[梦] ${dayKey} 做了一篇梦（${parsed.content.length} 字${parsed.degraded ? '，格式降级' : ''}）`
          + `｜素材 ${frag.lines.length} 行｜兴趣 ${effects.adjusted.length} 人${effects.moodApplied ? '｜心情降档' : ''}`)
        return { ok: true, dayKey, content: parsed.content, meta: parsed.meta, effects, degraded: parsed.degraded }
      } finally {
        running = false
      }
    }

    // ── 调度：她真实深睡中段，一天一次 ────────────────────────
    let timer = null
    function tick() {
      if (!enabled() || running) return
      try {
        const nowMs = Date.now()
        const dayKey = dateOf(nowMs)
        if (state.lastDreamDay === dayKey) return
        const w = bot.pacing?.quietWindowFor?.(nowMs)
        if (!w || w.enabled === false || w.allNighter) return
        const sleeping = bot.pacing?.inQuietHours?.(nowMs) === true
        const nightAwake = bot.pacing?.awakeBecauseNightWake?.(nowMs) > 0
        if (!sleeping || nightAwake) return                 // 只在睡着（且没夜醒）时做梦
        const moment = dreamMomentOf({ bedtime: w.startMin, sleepMin: w.sleepMin, allNighter: !!w.allNighter }, dayKey)
        if (!moment.atMs) return
        // 允许 90 分钟窗口（ticker 可能因负载错过精确时刻）
        if (nowMs < moment.atMs || nowMs - moment.atMs > 90 * 60000) return
        runDream().catch((e) => log.warn(`[梦] 执行异常: ${e.message}`))
      } catch (e) {
        log.debug(`[梦] tick 异常: ${e.message}`)
      }
    }
    const start = () => { if (!timer) { timer = setInterval(tick, TICK_MS); timer.unref?.() } }
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    start()
    try { bot.onDispose?.(stop) } catch { /* 老内核没有 onDispose */ }

    // ── 工具：读自己的梦 ─────────────────────────────────────
    bot.registerTool('read_dreams', {
      description: '读你自己最近做过的梦（`days` 默认 3，最多 30）。梦是你自己的，可以在任何会话里提起；'
        + '但梦里如果碰到别人私下告诉你的事，在群里不点名、不指名细节。',
      parameters: {
        days: { type: 'integer', description: '读最近几天的梦，默认 3' },
      },
      async execute(args = {}) {
        const days = Math.max(1, Math.min(30, Math.round(Number(args.days) || 3)))
        const entries = readDreams({ file: dreamsFile(), days })
        return { ok: true, days, count: entries.length, entries }
      },
    })

    // ── 提醒：当天有梦，第一次开口时提示一句（不贴内容）────────
    bot.on('before-turn', (ev) => {
      try {
        if (!enabled() || !ev?.wake) return
        if (ev.wake.kind === 'welcome') return
        const dayKey = dateOf(Date.now())
        if (state.lastDreamDay !== dayKey) return
        const key = String(ev.chatKey || '')
        if (!key || state.hintedChats?.[key] === dayKey) return
        state.hintedChats = { ...(state.hintedChats || {}), [key]: dayKey }
        saveState()
        ev.hint.push('[你昨晚做了个梦，梦里有点乱。想提可以提，不想提就算了]')
      } catch { /* 提示失败不影响回话 */ }
    })

    // 暴露给控制台/自检
    bot.shared.dreamRun = runDream
    bot.shared.dreamRead = ({ days = 3 } = {}) => readDreams({ file: dreamsFile(), days })
    bot.shared.dreamStatus = () => ({ ...state, file: dreamsFile(), enabled: enabled() })
    log.info(`[梦] 已就绪：梦境日记 ${dreamsFile()}｜每晚一次（她深睡中段）`)
  },
}
