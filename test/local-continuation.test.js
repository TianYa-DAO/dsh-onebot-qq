/**
 * test/local-continuation.test.js — 连续对话（摘自上游戏 2026-10-27）。
 *
 * 要点：真人叫过她 + 她回过话之后，隔一会儿把这段时间的新消息再判一次。
 * 防"自转"的三条硬闸必须成立：合成轮不登记 / 必须有人类新消息 / 一次链只检查 1 次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPacing, REPLY_DEFAULTS } from '../kernel/pacing.js'

const GROUP_ID = '20001'
const HOUR = 3600_000
const quiet = { info() {}, warn() {}, debug() {}, error() {} }

function mk({ reply = {}, clock } = {}) {
  let nowMs = 1_800_000_000_000
  const clk = clock || { now: () => nowMs }
  const state = {
    _s: new Map(),
    get(k) { if (!this._s.has(k)) this._s.set(k, { lastInboundAt: 0, lastSendAt: 0 }); return this._s.get(k) },
  }
  const p = createPacing({ log: quiet, state, clock: clk })
  p.apply({ reply: {
    enabled: true, groups: [GROUP_ID], hourlyMax: 20, sensitivity: 0,
    silenceEnabled: false, coldSilenceMs: 999999999, minGapMs: 0,
    continuation: { ...REPLY_DEFAULTS.continuation, enabled: true, delayMs: 60000, ...reply },
  } })
  const fired = []
  p.start({ onProactiveTurn: (a) => { fired.push(a) }, isBusy: () => false, onRepeat: () => {} })
  p.stop()
  return { p, fired, advance: (ms) => { nowMs += ms }, now: () => nowMs }
}

const wakeEv = (text = '绘梨衣 在吗', id = 500) => ({
  chatKey: `group:${GROUP_ID}`, groupId: GROUP_ID, isGroup: true, time: 1_800_000_000_000,
  messageId: id, text, mentionedSelf: true, sender: { qq: 30001 },
  wake: { kind: 'at' },
})
const humanEv = (text, id) => ({
  chatKey: `group:${GROUP_ID}`, groupId: GROUP_ID, isGroup: true, time: 1_800_000_000_000,
  messageId: id, text, mentionedSelf: false, sender: { qq: 30002 },
})

test('连续对话：真人叫过 + 她回过 + 有新消息 → 到点起一轮', async (t) => {
  const c = mk()
  c.p.noteInbound(wakeEv())
  c.p.noteWake(wakeEv())
  c.p.noteReplySent(`group:${GROUP_ID}`, { wakeKind: 'at' })
  c.advance(5000)
  c.p.noteInbound({ ...humanEv('那今晚吃火锅吧', 501), time: c.now() })
  c.advance(61000)
  c.p.tickNow()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(c.fired.length, 1, '应该起一轮续聊')
  assert.equal(c.fired[0].reason, 'continuation')
})

test('连续对话：默认只检查一次（补过一次就收手，防自转）', async (t) => {
  const c = mk()
  c.p.noteInbound(wakeEv()); c.p.noteWake(wakeEv())
  c.p.noteReplySent(`group:${GROUP_ID}`, { wakeKind: 'at' })
  c.advance(5000)
  c.p.noteInbound({ ...humanEv('那今晚到底吃火锅还是烤肉啊', 511), time: c.now() })
  c.advance(61000); c.p.tickNow()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(c.fired.length, 1)
  // 再来很多新消息 + 时间过去很久，也不该自己接第二轮
  c.p.noteInbound({ ...humanEv('火锅吧我觉得', 512), time: c.now() }); c.p.noteInbound({ ...humanEv('那就火锅', 513), time: c.now() })
  c.advance(10 * 60000); c.p.tickNow()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(c.fired.length, 1, '一次唤醒最多补一次')
})

test('连续对话：她回完之后没人说话 → 不检查', async (t) => {
  const c = mk()
  c.p.noteInbound(wakeEv()); c.p.noteWake(wakeEv())
  c.p.noteReplySent(`group:${GROUP_ID}`, { wakeKind: 'at' })
  c.advance(61000); c.p.tickNow()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(c.fired.length, 0, '没人接话不该自己说')
})

test('连续对话：合成轮（主动/续聊/欢迎）回的话不登记新链', async (t) => {
  const c = mk()
  c.p.noteInbound(wakeEv()); c.p.noteWake(wakeEv())
  // 这一轮本身是主动接话轮 → 不应开始计时
  c.p.noteReplySent(`group:${GROUP_ID}`, { wakeKind: 'proactive' })
  c.p.noteInbound(humanEv('咦', 521))
  c.advance(61000); c.p.tickNow()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(c.fired.length, 0, '主动轮不该触发续聊')
})

test('连续对话：总开关关着 → 完全不动', async (t) => {
  const c = mk({ reply: { enabled: false } })
  c.p.noteInbound(wakeEv()); c.p.noteWake(wakeEv())
  c.p.noteReplySent(`group:${GROUP_ID}`, { wakeKind: 'at' })
  c.p.noteInbound(humanEv('在吗', 531))
  c.advance(61000); c.p.tickNow()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(c.fired.length, 0)
})
