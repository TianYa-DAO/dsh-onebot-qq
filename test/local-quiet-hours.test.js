/**
 * test/local-quiet-hours.test.js — 她的作息（随机游走，不是固定点上下抖）。
 *
 * 主人的要求：
 *   · 抖动是**接着前一天走**的（今天熬到 4 点，明天更晚），不是每天围着 01:30 抖
 *   · 偶尔可以**通宵**（像人不小心过上美国人作息）
 *   · **睡眠时长也浮动，但幅度不大**（正常人 6~9 小时）
 *   · 只拦"冷场找话"；正常被叫照旧回（睡觉不回单独由 wakeOnCall 控制，见 local-sleep-gate）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPacing, REPLY_DEFAULTS } from '../kernel/pacing.js'

const GROUP_ID = '20001'
const quiet = { info() {}, warn() {}, debug() {}, error() {} }
const DAY = 24 * 3600 * 1000

function mk({ q = {}, startDay = 12 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-'))
  let t = new Date(2026, 10, startDay, 12, 0, 0).getTime()
  const p = createPacing({
    log: quiet, state: { _s: new Map(), get(k) { if (!this._s.has(k)) this._s.set(k, {}); return this._s.get(k) } },
    clock: { now: () => t }, stateDir: path.join(dir, 'state'),
  })
  p.apply({ reply: { desire: { enabled: false },
    enabled: true, groups: [GROUP_ID], hourlyMax: 100, sensitivity: 0, minGapMs: 0,
    silenceEnabled: true, coldSilenceMs: 60000,
    quiet: { enabled: true, baseBedtime: '02:30', baseSleepHours: 7.5, driftMin: 75,
      durationJitterMin: 35, minSleepHours: 5.5, maxSleepHours: 9.5, allNighterPct: 4, revertPct: 30, ...q },
    continuation: { ...REPLY_DEFAULTS.continuation, enabled: false },
  } })
  return { p, dir, setDay: (d) => { t = new Date(2026, 10, d, 12, 0, 0).getTime() }, setTime: (h, m = 0, d = 12) => { t = new Date(2026, 10, d, h, m, 0).getTime() }, now: () => t }
}

test('作息是接着前一天走的（不是每天独立抖动）', (t) => {
  const c = mk()
  const days = []
  for (let d = 12; d <= 20; d += 1) { c.setDay(d); days.push(c.p.quietWindowFor().startMin) }
  // 相邻两天之间必然是"小步走动"，而不是随机跳。
  // ⚠️ 睡点会跨零点（05:50 与 23:42 数字差 1253，实际只差 233），必须按**环形距离**算。
  const circ = (a, b) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d) }
  for (let i = 1; i < days.length; i += 1) {
    const delta = circ(days[i], days[i - 1])
    assert.ok(delta < 400, `相邻两天不该跳 ${delta} 分钟（应是小步游走）`)
  }
  assert.ok(new Set(days).size > 1, '每天应该略有不同（不是钉死一个点）')
})

test('睡眠时长有界且在正常范围（5.5~9.5 小时）', (t) => {
  const c = mk()
  for (let d = 12; d <= 40; d += 1) {
    c.setDay(d)
    const r = c.p.quietWindowFor()
    assert.ok(r.sleepMin >= 5.5 * 60 && r.sleepMin <= 9.5 * 60, `第 ${d} 天睡了 ${(r.sleepMin / 60).toFixed(1)}h，超出正常范围`)
  }
})

test('通宵：小概率出现，且那天不算"在睡"', (t) => {
  const c = mk({ q: { allNighterPct: 30 } })      // 调高概率便于观察
  let found = 0
  for (let d = 12; d <= 40; d += 1) {
    c.setDay(d)
    if (c.p.quietWindowFor().allNighter) {
      found += 1
      c.setTime(3, 0, d)                        // 凌晨 3 点，通宵那天不该判定为在睡
      assert.equal(c.p.inQuietHours(), false, '通宵那天凌晨也不该算睡觉')
    }
  }
  assert.ok(found > 0, '开着通宵概率时，30 天里应该出现过通宵')
})

test('回拉力：不会一路漂到天亮或漂到半夜（长期在基线附近）', (t) => {
  const c = mk({ q: { allNighterPct: 0 } })
  const starts = []
  for (let d = 12; d <= 60; d += 1) { c.setDay(d); starts.push(c.p.quietWindowFor().startMin) }
  const near = starts.filter((m) => {
    // 以 02:30(150) 为基线，容差 ±3.5 小时（含跨零点）
    const diff = Math.min(Math.abs(m - 150), 1440 - Math.abs(m - 150))
    return diff <= 210
  }).length
  assert.ok(near / starts.length > 0.6, `长期应多数落在基线附近，实际 ${near}/${starts.length}`)
})

test('同一天内多次调用完全一致（不会在睡/醒之间横跳）', (t) => {
  const c = mk()
  c.setDay(15)
  const a = c.p.quietWindowFor()
  for (let i = 0; i < 5; i += 1) assert.deepEqual(c.p.quietWindowFor(), a)
})

test('免打扰只拦"冷场找话"：睡着时冷场不开口', async (t) => {
  const c = mk({ q: { allNighterPct: 0 } })
  c.setDay(15)
  const w = c.p.quietWindowFor()
  c.setTime(Math.floor(w.startMin / 60), w.startMin % 60, 15)   // 正好睡点
  assert.equal(c.p.inQuietHours(), true)
  c.p.noteInbound({ chatKey: `group:${GROUP_ID}`, groupId: GROUP_ID, isGroup: true, time: c.now(), messageId: 1, text: 'x', sender: { qq: 30002 } })
  const fired = []
  c.p.start({ onProactiveTurn: (a) => fired.push(a), isBusy: () => false, onRepeat: () => {} })
  c.p.stop()
  const before = fired.length
  // 只在她睡着的区间里推进
  for (let i = 0; i < 60; i += 1) { c.setTime(Math.floor(w.startMin / 60), (w.startMin % 60) + i, 15); c.p.tickNow(); await new Promise((r) => setTimeout(r, 1)) }
  assert.equal(fired.length, before, '睡觉时不该"冷场找话"')
})

test('关掉免打扰 → 任何时间都不拦', (t) => {
  const c = mk({ q: { enabled: false } })
  c.setTime(3, 0, 15)
  assert.equal(c.p.inQuietHours(), false)
})
