/**
 * test/local-timeprofile.test.js — 按时间段覆盖主动接话参数（本地补丁）。
 *
 * 优先级：群覆盖 > 时间段 > 全局。
 * 覆盖跨零点、边界、纯函数与真实 pacing 行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPacing, normalizeHm, minutesOfDay, pickTimeProfile, normalizeWhen, normalizeFilterList } from '../kernel/pacing.js'

const GROUP_ID = 20001
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 纯函数 ──────────────────────────────────────────
test('normalizeHm：各种写法都能解析', () => {
  assert.equal(normalizeHm('09:00'), 9 * 60)
  assert.equal(normalizeHm('9:5'), 9 * 60 + 5)
  assert.equal(normalizeHm('22'), 22 * 60)
  assert.equal(normalizeHm('22：30'), 22 * 60 + 30) // 全角冒号
  assert.equal(normalizeHm('24:00'), 0)
  assert.equal(normalizeHm(''), null)
  assert.equal(normalizeHm('abc'), null)
  assert.equal(normalizeHm('25:00'), null)
  assert.equal(normalizeHm('10:99'), null)
})

test('pickTimeProfile：普通区间 / 边界 / 跨零点', () => {
  const p = [
    { from: 9 * 60, to: 18 * 60, hourlyMax: 1 },
    { from: 22 * 60, to: 2 * 60, hourlyMax: 10 },
  ]
  assert.equal(pickTimeProfile(p, 10 * 60).hourlyMax, 1, '10:00 命中白天段')
  assert.equal(pickTimeProfile(p, 9 * 60).hourlyMax, 1, '左闭：09:00 命中')
  assert.equal(pickTimeProfile(p, 18 * 60).hourlyMax, undefined, '右开：18:00 不命中白天段')
  assert.equal(pickTimeProfile(p, 23 * 60).hourlyMax, 10, '23:00 命中夜间段（跨零点）')
  assert.equal(pickTimeProfile(p, 1 * 60).hourlyMax, 10, '01:00 仍在夜间段')
  assert.equal(pickTimeProfile(p, 2 * 60).hourlyMax, undefined, '02:00 夜间段结束')
  assert.equal(pickTimeProfile(p, 5 * 60).hourlyMax, undefined, '05:00 什么都没命中')
  assert.deepEqual(pickTimeProfile([], 600), {}, '空配置')
})

test('minutesOfDay：本地时区', () => {
  const d = new Date(2026, 0, 1, 13, 45, 0)
  assert.equal(minutesOfDay(d), 13 * 60 + 45)
})

// ── 真实 pacing 行为 ────────────────────────────────
function makePacing({ reply = {}, at = '12:00' } = {}) {
  const [h, m] = at.split(':').map(Number)
  let nowMs = new Date(2026, 0, 1, h, m, 0).getTime()
  const clock = () => nowMs
  const p = createPacing({
    log: { info() {}, warn() {}, error() {}, debug() {} },
    state: { get: () => ({ lastInboundAt: 0, lastSendAt: 0 }) },
    clock,
  })
  p.apply({ reply: { enabled: true, groups: [GROUP_ID], hourlyMax: 20, sensitivity: 0, silenceEnabled: false, ...reply } })
  let fired = 0
  p.start({ onProactiveTurn: () => { fired++ }, isBusy: () => false })
  p.stop()
  return {
    p,
    firedCount: () => fired,
    advanceMs: (ms) => { nowMs += ms },
  }
}

function feed(p, text, msgId = 1) {
  const ev = {
    chatKey: `group:${GROUP_ID}`, groupId: GROUP_ID, isGroup: true, time: Date.now(),
    text, mentionedSelf: false, sender: { qq: 30000 + msgId },
  }
  p.noteInbound(ev)
  p.consider(ev)
}

/** 灌一批消息，然后把时钟推过"机会间隔"再灌一条，让窗口真正到点 */
function feedUntilFired(ctx, rounds = 4) {
  let i = 0
  for (let r = 0; r < rounds; r++) {
    for (let k = 0; k < 4; k++) feed(ctx.p, `这是一个足够长的话题内容第${i++}条`)
    ctx.advanceMs(30 * 60000) // 推 30 分钟，越过默认 15 分钟机会间隔
  }
}

test('时间段：白天段 hourlyMax=0 → 不主动接话', async () => {
  const ctx = makePacing({
    at: '12:00',
    reply: { timeProfiles: [{ from: '09:00', to: '18:00', hourlyMax: 0 }] },
  })
  feedUntilFired(ctx)
  await sleep(80)
  assert.equal(ctx.firedCount(), 0, '白天段被 hourlyMax=0 关掉')
})

test('时间段：夜间段 hourlyMax 放开 → 会接话（对照：无时间段限制也会接）', async () => {
  const night = makePacing({
    at: '23:00',
    reply: { timeProfiles: [{ from: '22:00', to: '02:00', hourlyMax: 20, sensitivity: 0 }] },
  })
  feedUntilFired(night)
  await sleep(80)
  assert.ok(night.firedCount() >= 1, '夜间段应该接话')
})

test('时间段 + 群覆盖：群覆盖优先（同一时刻，覆盖组不接、对照组接）', async () => {
  const off = makePacing({
    at: '12:00',
    reply: {
      timeProfiles: [{ from: '09:00', to: '18:00', hourlyMax: 20 }],
      groupOverrides: { [String(GROUP_ID)]: { hourlyMax: 0 } },
    },
  })
  feedUntilFired(off)
  await sleep(80)
  assert.equal(off.firedCount(), 0, '群覆盖 hourlyMax=0 压过时间段')

  const on = makePacing({
    at: '12:00',
    reply: { timeProfiles: [{ from: '09:00', to: '18:00', hourlyMax: 20 }] },
  })
  feedUntilFired(on)
  await sleep(80)
  assert.ok(on.firedCount() >= 1, '对照组（无群覆盖）在同一时间段应接话')
})

test('群时段表：该群自己的时段优先于全局时段', () => {
  const { p, firedCount } = makePacing({
    at: '12:00',
    reply: {
      // 全局：白天放开
      timeProfiles: [{ from: '09:00', to: '18:00', hourlyMax: 20, sensitivity: 0 }],
      // 这个群：白天关掉
      groupOverrides: {
        [String(GROUP_ID)]: { timeProfiles: [{ from: '09:00', to: '18:00', hourlyMax: 0 }] },
      },
    },
  })
  for (let i = 0; i < 6; i++) feed(p, `话题内容第${i}条`, i + 1)
  assert.equal(firedCount(), 0, '群时段 hourlyMax=0 压过全局时段')
})

test('群时段表：该群时段没写的字段 → 回落该群固定覆盖，再回落全局', async () => {
  const ctx = makePacing({
    at: '23:00',
    reply: {
      hourlyMax: 20,
      groupOverrides: {
        [String(GROUP_ID)]: {
          sensitivity: 0.01,                                   // 群固定值
          timeProfiles: [{ from: '22:00', to: '02:00', hourlyMax: 20 }], // 只覆盖次数
        },
      },
    },
  })
  await feedUntilFired(ctx)
  await sleep(80)
  assert.ok(ctx.firedCount() >= 1, '夜间该群应该接话')
})

test('群时段表：时段外回落群固定覆盖（该群静音）', () => {
  const ctx = makePacing({
    at: '12:00',
    reply: {
      hourlyMax: 20,
      groupOverrides: {
        [String(GROUP_ID)]: {
          hourlyMax: 0,
          timeProfiles: [{ from: '22:00', to: '02:00', hourlyMax: 20 }],
        },
      },
    },
  })
  feedUntilFired(ctx)
  assert.equal(ctx.firedCount(), 0, '12:00 不在该群时段内 → 用群固定覆盖 hourlyMax=0')
})

// ── 周 / 月维度 ─────────────────────────────────────
test('normalizeFilterList：去非法值、去重', () => {
  assert.deepEqual(normalizeFilterList([1, 1, 2, 9], 0, 6), [1, 2])
  assert.deepEqual(normalizeFilterList('6,0,7', 0, 6), [6, 0])
  assert.equal(normalizeFilterList('', 0, 6), undefined)
  assert.equal(normalizeFilterList(null, 1, 31), undefined)
  assert.deepEqual(normalizeFilterList('1,15,32', 1, 31), [1, 15])
})

test('normalizeWhen：Date → {dow,dom,month}', () => {
  const d = new Date(2026, 9, 24, 12, 0, 0) // 2026-10-24 周六
  const w = normalizeWhen(d)
  assert.equal(w.dow, 6)
  assert.equal(w.dom, 24)
  assert.equal(w.month, 10)
})

test('pickTimeProfile：按星期区分工作日/周末', () => {
  const ps = [
    { from: 9 * 60, to: 18 * 60, days: [1, 2, 3, 4, 5], hourlyMax: 1 }, // 工作日
    { from: 9 * 60, to: 18 * 60, days: [6, 0], hourlyMax: 10 },         // 周末
  ]
  const weekday = new Date(2026, 9, 23) // 周五
  const saturday = new Date(2026, 9, 24)
  assert.equal(pickTimeProfile(ps, 10 * 60, weekday).hourlyMax, 1, '周五命中工作日')
  assert.equal(pickTimeProfile(ps, 10 * 60, saturday).hourlyMax, 10, '周六命中周末')
})

test('pickTimeProfile：按月份 / 每月几号', () => {
  const ps = [
    { from: 0, to: 0, months: [2], hourlyMax: 0 },      // 整个 2 月静音
    { from: 0, to: 0, dates: [1], hourlyMax: 5 },       // 每月 1 号
    { from: 0, to: 0, hourlyMax: 3 },
  ]
  assert.equal(pickTimeProfile(ps, 10 * 60, new Date(2026, 1, 3)).hourlyMax, 0, '2 月命中')
  assert.equal(pickTimeProfile(ps, 10 * 60, new Date(2026, 4, 1)).hourlyMax, 5, '5月1号命中')
  assert.equal(pickTimeProfile(ps, 10 * 60, new Date(2026, 4, 2)).hourlyMax, 3, '其它回落兜底条目')
})

test('群时段 + 星期：同一群工作日少、周末多', async () => {
  const mk = (day) => {
    let nowMs = new Date(2026, 9, day, 12, 0, 0).getTime()
    const p = createPacing({ log: { info() {}, warn() {}, error() {}, debug() {} },
      state: { get: () => ({ lastInboundAt: 0, lastSendAt: 0 }) }, clock: () => nowMs })
    p.apply({ reply: {
      enabled: true, groups: [GROUP_ID], hourlyMax: 20, sensitivity: 0, silenceEnabled: false,
      groupOverrides: { [String(GROUP_ID)]: { timeProfiles: [
        { from: '09:00', to: '18:00', days: [1, 2, 3, 4, 5], hourlyMax: 0 },
        { from: '09:00', to: '18:00', days: [6, 0], hourlyMax: 20 },
      ] } },
    } })
    let fired = 0
    p.start({ onProactiveTurn: () => { fired++ }, isBusy: () => false }); p.stop()
    return { p, advance: (ms) => { nowMs += ms }, count: () => fired }
  }
  const feedAll = (ctx) => {
    let i = 0
    for (let r = 0; r < 3; r++) {
      for (let k = 0; k < 4; k++) {
        const ev = { chatKey: `group:${GROUP_ID}`, groupId: GROUP_ID, isGroup: true, time: Date.now(),
          text: `这是一个足够长的话题内容第${i++}条`, mentionedSelf: false, sender: { qq: 31000 + i } }
        ctx.p.noteInbound(ev); ctx.p.consider(ev)
      }
      ctx.advance(30 * 60000)
    }
  }
  const fri = mk(23)   // 周五工作日 → 静音
  feedAll(fri); await sleep(80)
  assert.equal(fri.count(), 0, '工作日该群静音')

  const sat = mk(24)   // 周六 → 放开
  feedAll(sat); await sleep(80)
  assert.ok(sat.count() >= 1, '周末该群接话')
})
