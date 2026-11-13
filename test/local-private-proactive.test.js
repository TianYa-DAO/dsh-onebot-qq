/**
 * test/local-private-proactive.test.js — 私聊主动聊天（2026-11-12 摘上游戏 2026-11-07 的"统一随机窗"，按我们的模型重写）
 *
 * 纪律：
 *   · 只对「允许名单」里的人主动；留空 = 谁都不主动
 *   · 只有**聊过的人**才会被想起（从没聊过 → 不打扰）
 *   · 比群里克制：默认 6 小时没说话才开口
 *   · 睡觉时不发（跟同一个作息）
 *   · 没回音指数退避，三次没人理就停
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPacing, REPLY_DEFAULTS } from '../kernel/pacing.js'

const QQ = '305542342'
const quiet = { info() {}, warn() {}, debug() {}, error() {} }
const MIN = 60000

function mk({ reply = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privpro-'))
  let t = new Date(2026, 10, 15, 15, 0, 0).getTime()
  const state = { _s: new Map(), get(k) { if (!this._s.has(k)) this._s.set(k, {}); return this._s.get(k) } }
  const p = createPacing({ log: quiet, state, clock: { now: () => t }, stateDir: path.join(dir, 'state') })
  p.apply({ merge: { enabled: false }, reply: {
    enabled: true, groups: [], hourlyMax: 100, sensitivity: 0, minGapMs: 0,
    silenceEnabled: true, coldSilenceMs: 5 * MIN,
    privateAllow: [QQ], privateColdHours: 6,
    quiet: { enabled: true, wakeOnCall: true, baseBedtime: '02:30', baseSleepHours: 7.5, driftMin: 60,
      durationJitterMin: 30, minSleepHours: 5.5, maxSleepHours: 9.5, allNighterPct: 0, revertPct: 30 },
    continuation: { ...REPLY_DEFAULTS.continuation, enabled: false },
    ...reply,
  } })
  // 固定作息：睡 02:00~10:00
  const f = path.join(dir, 'state', 'pacing-rhythm.json')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ day: '2026-11-15', bedtime: 120, sleepMin: 480, allNighter: false }))
  const fired = []
  p.start({ onProactiveTurn: (a) => fired.push(a), isBusy: () => false, onRepeat: () => {} })
  p.stop()
  return {
    p, fired, dir,
    setTime: (h, m = 0) => { t = new Date(2026, 10, 15, h, m, 0).getTime() },
    setTimeTo: (ms) => { t = ms },
    now: () => t,
    step(ms) { t += ms },
    async tick() { p.tickNow(); await new Promise((r) => setImmediate(r)) },
    inbound() { p.noteInbound({ chatKey: `private:${QQ}`, isGroup: false, time: t, messageId: 1, text: 'hi', sender: { qq: QQ } }) },
  }
}

test('安静够久 → 对她主动私聊（chatKey=private:QQ, groupId=null）', async (t) => {
  const c = mk()
  c.setTime(15, 0)
  c.inbound()
  c.step(7 * 3600000)          // 7 小时没说话（> 6 小时门槛）
  await c.tick()
  assert.equal(c.fired.length, 1, '应该主动私聊一次')
  assert.equal(c.fired[0].chatKey, `private:${QQ}`)
  assert.equal(c.fired[0].groupId, null, '私聊没有 groupId')
})

test('没安静够（才 2 小时）→ 不打扰', async (t) => {
  const c = mk()
  c.setTime(15, 0)
  c.inbound()
  c.step(2 * 3600000)
  await c.tick()
  assert.equal(c.fired.length, 0)
})

test('不在允许名单里 → 绝不主动私聊', async (t) => {
  const c = mk({ reply: { privateAllow: ['999999'] } })
  c.setTime(15, 0)
  c.inbound()
  c.step(20 * 3600000)
  await c.tick()
  assert.equal(c.fired.length, 0)
})

test('从没聊过的人 → 不打扰（没有 lastInboundAt）', async (t) => {
  const c = mk()
  c.setTime(15, 0)
  c.step(20 * 3600000)
  await c.tick()
  assert.equal(c.fired.length, 0, '没聊过就不该主动找')
})

test('她睡觉时不主动私聊', async (t) => {
  const c = mk()
  c.setTime(3, 0)              // 凌晨 3 点，睡着（02:00~10:00）
  c.inbound()
  c.p.noteInbound({ chatKey: `private:${QQ}`, isGroup: false, time: c.now() - 20 * 3600000, messageId: 1, text: 'hi', sender: { qq: QQ } })
  await c.tick()
  assert.equal(c.fired.length, 0, '睡觉时不该主动私聊')
})

test('没回音指数退避：一次没回 → 要等 2 倍；三次没回 → 先不打扰', async (t) => {
  const c = mk()
  c.setTime(15, 0)
  c.inbound()
  c.step(7 * 3600000)
  await c.tick()
  assert.equal(c.fired.length, 1)
  // 她发了但对方没回 → 记一次"无人应答"
  c.p.noteReplySent(`private:${QQ}`, { wakeKind: 'proactive' })
  // 刚过 6 小时不该再发（要 2×）
  c.step(7 * 3600000)
  await c.tick()
  assert.equal(c.fired.length, 1, '一次没回音时应退避到 2 倍')
  // 再等够 2× 就该发
  c.step(6 * 3600000)
  await c.tick()
  assert.equal(c.fired.length, 2, '退避期过后应该再试一次')
})

// ── 私聊门槛的随机抖动（2026-11-12 主人要求：6 小时上下抖 30 分钟）──────────
test('抖动真的生效：跨多天在"刚好 6 小时"这个点，有的天触发、有的天还没到', async (t) => {
  let firedAt6h = 0
  const DAYS = 20
  for (let d = 12; d <= 12 + DAYS - 1; d += 1) {
    const c = mk({ reply: { privateColdHours: 6, privateColdJitterMin: 30 } })
    c.setDay = undefined
    // mk 里时间固定在 11-15；这里直接造每天不同日期的独立实例
    const t0 = new Date(2026, 10, d, 15, 0, 0).getTime()
    c.setTimeTo(t0)
    c.inbound()
    c.step(6 * 3600000)        // 正好 6 小时
    await c.tick()
    if (c.fired.length) firedAt6h += 1
  }
  assert.ok(firedAt6h > 0, `20 天里应有部分天在 6 小时触发（实际 ${firedAt6h}）`)
  assert.ok(firedAt6h < DAYS, `也该有部分天还没到（门槛被抖到 6h 以上），实际 ${firedAt6h}/${DAYS}`)
})

test('抖动幅度为 0 时门槛固定 6 小时（2 小时不触发 / 7 小时必触发）', async (t) => {
  const c = mk({ reply: { privateColdHours: 6, privateColdJitterMin: 0 } })
  c.setTime(15, 0)
  c.inbound()
  c.step(2 * 3600000)
  await c.tick()
  assert.equal(c.fired.length, 0, '2 小时不该触发')
  c.step(5 * 3600000)              // 累计 7 小时
  await c.tick()
  assert.equal(c.fired.length, 1, '7 小时应触发')
})

test('抖动 ±30 分钟：超过上限 6.5 小时后一定触发', async (t) => {
  const c = mk({ reply: { privateColdHours: 6, privateColdJitterMin: 30 } })
  c.setTime(15, 0)
  c.inbound()
  c.step(6.8 * 3600000)
  await c.tick()
  assert.equal(c.fired.length, 1, '超过 6.5 小时必触发')
})
