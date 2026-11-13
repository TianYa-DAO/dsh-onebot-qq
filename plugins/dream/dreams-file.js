/**
 * plugins/dream/dreams-file.js — 梦境日记文件（DREAMS.md）读写
 * 结构沿用 openclaw 的"人可读、追加式、可裁剪"：标题 + 按日期分段。
 */
import fs from 'node:fs'
import path from 'node:path'

const HEADER = '# 梦境日记\n\n她自己做的梦，按日期倒序。这是她自己的东西。\n'

const dateOf = (ms) => {
  const d = new Date(Number(ms) || Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 把文件切成 [{date, body}]（date 取自 `## YYYY-MM-DD`） */
export function parseEntries(text) {
  const src = String(text || '')
  const parts = src.split(/^## /m)
  const head = parts.shift() || ''
  const entries = []
  for (const p of parts) {
    const m = /^(\d{4}-\d{2}-\d{2})[^\n]*\n([\s\S]*)$/.exec(p)
    if (m) entries.push({ date: m[1], body: m[2].trim() })
    else if (p.trim()) entries.push({ date: '', body: p.trim() })
  }
  return { head: head.trim(), entries }
}

/**
 * 追加一篇梦（倒序：新梦在上）。
 * @param {{file:string, content:string, nowMs?:number, keepDays?:number, metaText?:string}} o
 * @returns {{ok:boolean, bytes:number, entries:number, error?:string}}
 */
export function appendDream({ file, content, nowMs = Date.now(), keepDays = 60, metaText = '' }) {
  const body = String(content || '').trim()
  if (!body) return { ok: false, bytes: 0, entries: 0, error: 'empty' }
  const date = dateOf(nowMs)
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { text = HEADER }
  if (!text.trim()) text = HEADER
  const { head, entries } = parseEntries(text)

  // 同一天已有一篇 → 合并成一段（不重复日期标题）
  const today = entries.find((e) => e.date === date)
  const extra = metaText ? `\n\n${metaText}` : ''
  if (today) today.body = `${body}${extra}\n\n${today.body}`
  else {
    // 按日期倒序插入（补写旧梦时不能跑到最上面）
    entries.push({ date, body: `${body}${extra}` })
    entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  }

  // 裁剪：只留最近 keepDays 段
  const keep = Math.max(1, Number(keepDays) || 60)
  const kept = entries.slice(0, keep)
  const out = `${head}\n\n${kept.map((e) => `## ${e.date}\n\n${e.body}`).join('\n\n')}\n`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, out, { mode: 0o600 })
    fs.renameSync(tmp, file)
    return { ok: true, bytes: Buffer.byteLength(out, 'utf8'), entries: kept.length }
  } catch (e) {
    return { ok: false, bytes: 0, entries: kept.length, error: e.message }
  }
}

/** 读最近 n 篇（新→旧） */
export function readDreams({ file, days = 3 }) {
  const n = Math.max(1, Math.min(30, Number(days) || 3))
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  return parseEntries(text).entries.filter((e) => e.date).slice(0, n).map((e) => ({ date: e.date, content: e.body }))
}

export { dateOf }
