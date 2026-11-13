/**
 * plugins/dream/collect.js — 梦境素材抽取（Light 阶段，纯本地、0 模型调用）
 *
 * 干什么：从最近 24h 的聊天归档里，捞"她参与过的"对话碎片，喂给写梦那一步。
 * 纪律：
 *   · 只收**她回过话**的轮次（in→out 成对）——她没参与的群聊不进她的梦；
 *   · 跳过纯占位（[图片]/[表情]/[合并转发]），只留能长出意象的字；
 *   · 有情绪词 / 有人名 / 她参与过 → 优先保留（超预算时先甩这些之外的行）；
 *   · 不读记忆正文（那是事实层，梦只吃"今天发生过什么"）。
 */

import fs from 'node:fs'

const DAY_MS = 86400000
const EMO = /(?:难受|难过|委屈|开心|高兴|笑|哭|怕|累|烦|生气|喜欢|讨厌|想|念|等|终于|居然|竟然|可惜|舍不得|孤单|冷|热|雨|雪|风|灯|夜|梦)/

/** 一条消息是否只是占位符（没有可长梦的字） */
function isPlaceholder(text) {
  const t = String(text || '').trim()
  if (!t) return true
  return /^\[(图片|表情|动画表情|合并转发|视频|语音|文件|卡片)\]$/.test(t) || /^\[.+\]$/.test(t) && t.length <= 8
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function hhmm(ts) {
  const d = new Date(Number(ts) || 0)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 从归档抽碎片。
 * @param {object} opts
 * @param {string} opts.archiveDir  归档目录（logs/qq_chat）
 * @param {number} [opts.nowMs]     现在（默认 Date.now）
 * @param {number} [opts.hours=24]  回看多少小时
 * @param {number} [opts.maxItems=30] 最多几行
 * @param {number} [opts.maxChars=4000] 最多多少字
 * @param {(name:string)=>string} [opts.labelOf] 文件名 → 可读标签（群/私聊）
 * @returns {{lines: string[], sources: number, pairs: number}}
 */
export function collectFragments({ archiveDir, nowMs = Date.now(), hours = 24, maxItems = 30, maxChars = 4000, labelOf = null, fsModule = null } = {}) {
  const io = fsModule || fs
  const since = nowMs - Math.max(1, hours) * 3600000
  let names = []
  try { names = io.readdirSync(archiveDir) } catch { return { lines: [], sources: 0, pairs: 0 } }

  const out = []
  let sources = 0
  for (const name of names.sort()) {
    const m = /^(group|private)_(\d{1,14})\.jsonl$/.exec(name)   // 真机是 6~12 位，测试会用短号；这里放宽
    if (!m) continue
    const key = `${m[1]}:${m[2]}`
    const label = labelOf ? labelOf(name, m[1], m[2]) : (m[1] === 'group' ? `群${m[2]}` : `私聊`)
    let rows = []
    try {
      rows = io.readFileSync(`${archiveDir}/${name}`, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean)
    } catch { continue }
    if (!rows.length) { continue }

    // 按"她回过话"配对：一条 out 往前找最近一条 in（同一会话）
    let pending = null
    const pairs = []
    for (const r of rows) {
      const ts = Number(r.ts) || 0
      if (r.dir === 'in') {
        pending = { ts, text: r.text, who: r.sender?.card || r.sender?.name || r.sender?.qq || '' }
        continue
      }
      if (r.dir !== 'out') continue
      if (ts < since) { pending = null; continue }
      const mine = clip(r.text, 60)
      if (!pending || isPlaceholder(pending.text) || !mine) { pending = null; continue }
      pairs.push({ ts: pending.ts, who: pending.who, his: clip(pending.text, 70), mine })
      pending = null
    }
    if (!pairs.length) continue
    sources += 1
    for (const p of pairs.slice(-8)) {
      const line = `${hhmm(p.ts)} ${label}｜${p.who || '?'}: ${p.his} ／ 我: ${p.mine}`
      const score = (EMO.test(p.his) || EMO.test(p.mine) ? 2 : 0) + (p.who ? 1 : 0)
      out.push({ line, score, ts: p.ts })
    }
  }

  // 先按"值得入梦"排序取前 maxItems，再按时间正序排回去（梦里时间该是顺的）
  out.sort((a, b) => (b.score - a.score) || (b.ts - a.ts))
  const picked = []
  let chars = 0
  for (const it of out) {
    if (picked.length >= maxItems) break
    if (chars + it.line.length > maxChars) break
    picked.push(it)
    chars += it.line.length
  }
  picked.sort((a, b) => a.ts - b.ts)
  return { lines: picked.map((x) => x.line), sources, pairs: out.length }
}
