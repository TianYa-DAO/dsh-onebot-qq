/**
 * plugins/dream/consolidate.js — Deep 阶段（**不调模型**，纯本地规则）
 *
 * 三件事，都有硬边界：
 *   ① 兴趣：只用梦里真实出现、且最近 7 天真聊过的人；delta 由模型裁定，夹 -5~5；
 *            单次最多 3 人、当天合计 |Δ| ≤ 10
 *   ② 情绪：mood ≤ -1 → 当天主动找话的每小时上限 -1（最低 1），次日自动恢复
 *   ③ 联想：themes 写进星图（secret，不进群聊检索）
 *
 * 与 04:00 每日沉淀的分工：**这里绝不写事实**，只写"联接"。
 */

const DAY_MS = 86400000
const MAX_FIGURES = 3
const MAX_TOTAL = 10
const RECENT_MS = 7 * DAY_MS

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0))

/**
 * 计算该应用的影响（不落盘，便于测试）。
 * @param {object} o
 * @param {object} o.meta            parseDreamOutput 的 meta
 * @param {number} o.nowMs
 * @param {(qq:string)=>number|null} o.lastTalkAt  这个人最近一次真实说话的时间（ms），查不到返回 null
 * @returns {{adjusted: Array<{qq:string,delta:number,why:string}>, skipped: Array<{qq:string,reason:string}>, totalDelta: number, moodApplied: number|null}}
 */
export function planEffects({ meta, nowMs = Date.now(), lastTalkAt = () => null } = {}) {
  const adjusted = []
  const skipped = []
  const figs = Array.isArray(meta?.figures) ? meta.figures : []

  const candidates = []
  for (const f of figs) {
    const qq = String(f?.qq || '')
    if (!/^\d{4,14}$/.test(qq)) { skipped.push({ qq, reason: 'bad-qq' }); continue }
    const rawDelta = Number(f?.delta) || 0
    if (!rawDelta) { skipped.push({ qq, reason: 'zero' }); continue }
    const at = Number(lastTalkAt(qq) || 0)
    if (!at || nowMs - at > RECENT_MS) { skipped.push({ qq, reason: 'not-recent' }); continue }
    candidates.push({ qq, delta: Math.round(clamp(rawDelta, -5, 5)), why: String(f?.why || '').slice(0, 60) })
  }

  // 单次最多 3 人；当天合计 |Δ| ≤ 10（按绝对值从大到小，超出截断）
  candidates.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  let total = 0
  for (const c of candidates) {
    if (adjusted.length >= MAX_FIGURES) { skipped.push({ qq: c.qq, reason: 'too-many' }); continue }
    const next = total + Math.abs(c.delta)
    if (next > MAX_TOTAL) {
      const room = MAX_TOTAL - total
      if (room > 0) {
        adjusted.push({ ...c, delta: Math.sign(c.delta) * room })
        total += room
      } else skipped.push({ qq: c.qq, reason: 'daily-cap' })
      continue
    }
    adjusted.push(c)
    total = next                       // next 已经是"含本条"的累计，不能再加一次
  }

  const mood = Math.round(clamp(meta?.mood, -2, 2))
  const moodApplied = mood <= -1 ? -1 : null     // 只降不升；次日由 pacing 恢复
  return { adjusted, skipped, totalDelta: total, moodApplied }
}

/**
 * 梦的时刻：她今天的睡点 + 睡眠时长 × 0.55，再按天做确定性抖动（±20 分钟）。
 * @param {{bedtime:number, sleepMin:number, allNighter?:boolean}} rhythm  bedtime 是当天 0 点起的分钟数
 * @param {string} dayKey  'YYYY-MM-DD'
 * @returns {{minuteOfDay:number, atMs:number|null}}
 */
export function dreamMomentOf(rhythm, dayKey) {
  if (!rhythm || rhythm.allNighter) return { minuteOfDay: 0, atMs: null }
  const bed = Number(rhythm.bedtime) || 0
  const sleep = Math.max(60, Number(rhythm.sleepMin) || 450)
  const jitter = (hash01(`${dayKey}|dream`) * 2 - 1) * 20
  const minuteOfDay = Math.round(bed + sleep * 0.55 + jitter) % 1440
  const [y, m, d] = String(dayKey).split('-').map(Number)
  const at = new Date(y, (m || 1) - 1, d || 1, 0, minuteOfDay, 0, 0).getTime()
  return { minuteOfDay, atMs: Number.isFinite(at) ? at : null }
}

function hash01(key) {
  let h = 2166136261
  const s = String(key)
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0) / 4294967295
}

export const LIMITS = { MAX_FIGURES, MAX_TOTAL, RECENT_MS }
