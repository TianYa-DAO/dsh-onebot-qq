/**
 * test/local-selftalk-backoff.test.js — 死群里不许无限自言自语（指数退避）。
 *
 * 主人提的问题：主动接话 → 群又安静 → 会话沉淀 → 又主动接话 → 又沉淀，会不会空转？
 * 查出来的根因：冷场判定看的是 `lastInboundAt`（**别人**最后说话），她自己发的话不算，
 *   所以她说一句之后群照样"安静"，下一个窗口又可以说 —— 在死群里能一直自言自语下去。
 *
 * 修法：她主动接话发出去之后记 `proactiveUnanswered`；
 *   要求静默时间 = coldSilenceMs × 2^n（n = 连续无人应答次数，封顶 ×8）；
 *   n ≥ 3 直接不说了；有人说话就清零。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPacing, REPLY_DEFAULTS } from '../kernel/pacing.js'

const GROUP_ID = '20001'
const quiet = { info() {}, warn() {}, debug() {}, error() {} }
const COLD = 60_000

function mk() {
  let nowMs = 1_800_000_000_000
  const state = {
    _s: new Map(),
    get(k) { if (!this._s.has(k)) this._s.set(k, { lastInboundAt: 0, lastSendAt: 0 }); return this._s.get(k) },
  }
  const p = createPacing({ log: quiet, state, clock: { now: () => nowMs } })
  p.apply({ reply: { desire: { enabled: false },
    enabled: true, groups: [GROUP_ID], hourlyMax: 100, sensitivity: 0, minGapMs: 0,
    silenceEnabled: true, coldSilenceMs: COLD,
    continuation: { ...REPLY_DEFAULTS.continuation, enabled: false },
  } })
  const fired = []
  p.start({ onProactiveTurn: (a) => { fired.push(a) }, isBusy: () => false, onRepeat: () => {} })
  p.stop()
  return {
    p, fired, advance: (ms) => { nowMs += ms }, now: () => nowMs,
    /** 按 5 秒一步推进并每步 tick：机会窗口带随机延迟（实测可达 80+ 秒），单次大跳跃测不准。 */
    /** 跑到"又触发一次"就停；返回是否真的触发了。 */
    async runUntilFire(ms) {
      const before = fired.length
      const step = 5000
      let left = ms
      while (left > 0) {
        const d = Math.min(step, left)
        nowMs += d
        left -= d
        p.tickNow()
        await new Promise((r) => setTimeout(r, 1))
        if (fired.length > before) return true
      }
      return false
    },
    async run(ms) {
      const step = 5000
      let left = ms
      while (left > 0) {
        const d = Math.min(step, left)
        nowMs += d
        left -= d
        p.tickNow()
        await new Promise((r) => setTimeout(r, 1))
      }
    },
  }
}

const human = (id) => ({
  chatKey: `group:${GROUP_ID}`, groupId: GROUP_ID, isGroup: true,
  time: 1_800_000_000_000, messageId: id, text: '随便说一句', sender: { qq: 30002 },
})

/** 她主动接话真的发出去了 */
const sheSentProactive = (c) => c.p.noteReplySent(`group:${GROUP_ID}`, { wakeKind: 'proactive' })

test('第一次冷场：静默够了就起一轮', async (t) => {
  const c = mk()
  c.p.noteInbound(human(1))
  const got = await c.runUntilFire(3 * COLD)
  assert.equal(got, true, '应该起一轮冷场找话')
  assert.equal(c.fired.length, 1)
  assert.equal(c.fired[0].reason, 'silence')
})

test('她自说自话一次没人接 → 要求的静默时间翻倍（不许马上再来一句）', async (t) => {
  const c = mk()
  c.p.noteInbound(human(1))
  assert.equal(await c.runUntilFire(3 * COLD), true, '第一次应该发')
  sheSentProactive(c)                       // 她说了，没人接

  const n1 = c.fired.length
  const firedTooSoon = await c.runUntilFire(1.5 * COLD)   // 1.5× 静默
  assert.equal(firedTooSoon, false, '没人接时，1.5× 静默内不该再发（退避 ×2）')
  assert.equal(c.fired.length, n1)

  assert.equal(await c.runUntilFire(2 * COLD), true, '到了 2× 静默才允许再说一次')
})

test('连续三次没人接 → 彻底闭嘴，等到有人说话', async (t) => {
  const c = mk()
  c.p.noteInbound(human(1))
  assert.equal(await c.runUntilFire(3 * COLD), true)
  sheSentProactive(c)                                  // 第 1 次无人应答
  assert.equal(await c.runUntilFire(3 * COLD), true)
  sheSentProactive(c)                                  // 第 2 次
  assert.equal(await c.runUntilFire(6 * COLD), true)
  sheSentProactive(c)                                  // 第 3 次 → 闭嘴

  const before = c.fired.length
  const firedAnyway = await c.runUntilFire(60 * COLD)   // 过很久
  assert.equal(firedAnyway, false, '连续三次没人接之后，再久也不该继续自言自语')
  assert.equal(c.fired.length, before)
})

test('有人说话了 → 退避清零，恢复正常的冷场判定', async (t) => {
  const c = mk()
  c.p.noteInbound(human(1))
  await c.runUntilFire(3 * COLD)
  sheSentProactive(c); sheSentProactive(c); sheSentProactive(c)   // 攒到闭嘴
  const before = c.fired.length

  c.p.noteInbound({ ...human(2), time: c.now() })                // 有人开口
  assert.equal(await c.runUntilFire(3 * COLD), true, '有人说话后应恢复接话')
  assert.equal(c.fired.length, before + 1)
})

test('一轮拆条发 3 条 → 只算 1 次"无人应答"（不能一开口就闭嘴）', async (t) => {
  const c = mk()
  c.p.noteInbound(human(1))
  assert.equal(await c.runUntilFire(3 * COLD), true, '第一次应该发')

  // 同一轮（同一个 turnCtx 对象）发 3 条 —— 出站回调是按条触发的
  const turnCtx = { wakeKind: 'proactive' }
  c.p.noteReplySent(`group:${GROUP_ID}`, turnCtx)
  c.p.noteReplySent(`group:${GROUP_ID}`, turnCtx)
  c.p.noteReplySent(`group:${GROUP_ID}`, turnCtx)

  // 若按条计数会变成 3 → 直接闭嘴；正确应是 1 → 退避 ×2 还能再说
  const n1 = c.fired.length
  const tooSoon = await c.runUntilFire(1.5 * COLD)
  assert.equal(tooSoon, false, '1.5× 静默内不该发（×2 退避）')
  assert.equal(await c.runUntilFire(2 * COLD), true, '拆 3 条也只算 1 次，2× 静默后应该还能说')
  assert.equal(c.fired.length, n1 + 1)
})

test('三档拆分：每轮各发多条 → 仍然是"三轮"才闭嘴', async (t) => {
  const c = mk()
  c.p.noteInbound(human(1))
  assert.equal(await c.runUntilFire(3 * COLD), true)

  // 第 1 轮（拆 2 条）
  let ctx = { wakeKind: 'proactive' }
  c.p.noteReplySent(`group:${GROUP_ID}`, ctx); c.p.noteReplySent(`group:${GROUP_ID}`, ctx)
  assert.equal(await c.runUntilFire(3 * COLD), true)
  // 第 2 轮（拆 3 条）
  ctx = { wakeKind: 'proactive' }
  c.p.noteReplySent(`group:${GROUP_ID}`, ctx); c.p.noteReplySent(`group:${GROUP_ID}`, ctx); c.p.noteReplySent(`group:${GROUP_ID}`, ctx)
  assert.equal(await c.runUntilFire(6 * COLD), true)
  // 第 3 轮 → 闭嘴
  ctx = { wakeKind: 'proactive' }
  c.p.noteReplySent(`group:${GROUP_ID}`, ctx)

  const before = c.fired.length
  assert.equal(await c.runUntilFire(40 * COLD), false, '三轮之后应闭嘴')
  assert.equal(c.fired.length, before)
})
