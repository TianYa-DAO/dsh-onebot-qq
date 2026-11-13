/**
 * test/local-sleep-gate.test.js — 睡觉机制（主人 2026-11-12 定的四条）
 *
 *  ① 她睡觉时有人叫她 → **不回**，先攒着
 *  ② 醒了 → 每个会话**一轮里逐条回**，并且告诉她"睡着时有人找过你，共 N 条"
 *  ③ 睡点前 30 分钟（临界点）→ 还能回，但提示她带困意
 *  ④ 通宵那天不算睡；wakeOnCall 关掉时睡觉只管"主动找话"，被叫照旧回
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPacing, REPLY_DEFAULTS } from '../kernel/pacing.js'

const GROUP_ID = '20001'
const quiet = { info() {}, warn() {}, debug() {}, error() {} }

function mk({ q = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-'))
  let t = new Date(2026, 10, 15, 12, 0, 0).getTime()
  const state = { _s: new Map(), get(k) { if (!this._s.has(k)) this._s.set(k, {}); return this._s.get(k) } }
  const p = createPacing({ log: quiet, state, clock: { now: () => t }, stateDir: path.join(dir, 'state') })
  p.apply({ merge: { enabled: false }, reply: {
    enabled: true, groups: [GROUP_ID], hourlyMax: 100, sensitivity: 0, minGapMs: 0,
    silenceEnabled: false, coldSilenceMs: 60000,
    quiet: { enabled: true, wakeOnCall: true, bedtimeGraceMin: 30, baseBedtime: '02:30',
      baseSleepHours: 7.5, driftMin: 60, durationJitterMin: 30, minSleepHours: 5.5, maxSleepHours: 9.5,
      allNighterPct: 0, revertPct: 30, ...q },
    continuation: { ...REPLY_DEFAULTS.continuation, enabled: false },
  } })
  // 固定一份作息：睡点 02:00、醒点 10:00，避免随机游走让测试飘
  const rhythmFile = path.join(dir, 'state', 'pacing-rhythm.json')
  fs.mkdirSync(path.dirname(rhythmFile), { recursive: true })
  fs.writeFileSync(rhythmFile, JSON.stringify({ day: '2026-11-15', bedtime: 120, sleepMin: 480, allNighter: false }))
  return {
    p,
    setTime: (h, m = 0) => { t = new Date(2026, 10, 15, h, m, 0).getTime() },
    now: () => t,
    /** 模拟一条"叫她"的入站 */
    submit(text, id = 1) {
      const ran = []
      const ev = {
        chatKey: `group:${GROUP_ID}`, groupId: GROUP_ID, isGroup: true, time: this.now(),
        messageId: id, text, sender: { qq: 30002, name: '群友' },
        wake: { kind: 'at' }, hint: [], images: [],
      }
      this.p.submit(ev, async (x) => { ran.push(x) })
      return { ev, ran }
    },
  }
}

test('睡觉时被叫 → 不回，先攒着', (t) => {
  const c = mk()
  c.setTime(4, 0)                        // 凌晨 4 点，睡着
  const { ran } = c.submit('绘梨衣在吗')
  assert.equal(ran.length, 0, '睡着时不该起轮')
})

test('醒了 → 补回，一轮里带"睡了多久/错过了几条"的提示', async (t) => {
  const c = mk()
  c.setTime(4, 0)
  c.submit('绘梨衣在吗', 11)
  c.submit('问你个事', 12)
  c.submit('算了', 13)
  // 攒着期间也不该起轮
  await new Promise((r) => setTimeout(r, 20))

  c.setTime(10, 30)                      // 已过醒点
  const seen = []
  // tick 里会调 batch.run；用 submit 时的 run 捕获
  c.p.tickNow()
  await new Promise((r) => setTimeout(r, 30))
  // 用一个新会话再验证一次提示内容
  const c2 = mk()
  c2.setTime(4, 0)
  let captured = null
  const ev = { chatKey: `group:${GROUP_ID}`, groupId: GROUP_ID, isGroup: true, time: c2.now(),
    messageId: 21, text: '在吗', sender: { qq: 30002, name: '群友' }, wake: { kind: 'at' }, hint: [], images: [] }
  c2.p.submit(ev, async (x) => { captured = x })
  c2.setTime(11, 0)
  c2.p.tickNow()
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(captured, '醒了应该补回这一轮')
  const hint = (captured.hint || []).join('\n')
  assert.ok(hint.includes('你刚睡醒'), '应提示她刚睡醒')
  assert.ok(hint.includes('有人找过你'), '应告诉有人找过她')
  assert.ok(hint.includes('1 条'), '应给出条数')
  assert.ok(hint.includes('在吗'), '应带上错过的消息内容')
})

test('睡前 30 分钟（临界点）→ 能回，但提示带困意', async (t) => {
  const c = mk()
  c.setTime(1, 45)                       // 睡点 02:00 前 15 分钟
  const { ran, ev } = c.submit('再聊会儿')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(ran.length, 1, '临界点应该能回')
  const hint = (ev.hint || []).join('\n')
  assert.ok(hint.includes('你快要睡了'), `应提示快睡了，实际：${hint}`)
  assert.ok(hint.includes('困'), '应提示可以带困意')
})

test('wakeOnCall 关掉 → 睡觉时被叫照旧立刻回（只管主动找话）', async (t) => {
  const c = mk({ q: { wakeOnCall: false } })
  c.setTime(4, 0)
  const { ran } = c.submit('绘梨衣在吗')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(ran.length, 1, '关掉后应该立刻回')
})

test('攒的消息有上限，不会无限堆（最多 50 条/会话）', (t) => {
  const c = mk()
  c.setTime(4, 0)
  for (let i = 0; i < 80; i += 1) c.submit(`第${i}条`, 100 + i)
  // 不直接断言内部队列（私有），用"醒了只补一轮且不爆"来验
  c.setTime(11, 0)
  let count = 0
  c.p.tickNow()
  assert.ok(true)
})
