/** test/local-dream-consolidate.test.js — Deep 阶段（本地规则）：兴趣裁定 / 情绪 / 做梦时刻 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planEffects, dreamMomentOf, LIMITS } from '../plugins/dream/consolidate.js'

const NOW = Date.parse('2026-11-13T04:00:00+08:00')
const H = 3600000
const D = 86400000

test('兴趣：只认真实聊过的人，delta 夹到 ±5', () => {
  const lastTalkAt = (qq) => (qq === '111111' ? NOW - 2 * H : null)
  const r = planEffects({
    nowMs: NOW,
    lastTalkAt,
    meta: { figures: [
      { qq: '111111', name: '甲', delta: 100, why: '护着我' },      // 夹到 5
      { qq: '222222', name: '乙', delta: -3, why: '走了' },          // 查不到互动 → 丢弃
    ], mood: 0 },
  })
  assert.deepEqual(r.adjusted.map((x) => x.qq), ['111111'])
  assert.equal(r.adjusted[0].delta, 5)
  assert.ok(r.skipped.some((s) => s.qq === '222222' && s.reason === 'not-recent'))
})

test('兴趣：单次最多 3 人，当天合计 |Δ| ≤ 10', () => {
  const lastTalkAt = () => NOW - H
  const figs = ['1', '2', '3', '4'].map((n, i) => ({ qq: String(100000 + i), delta: 5, why: `w${n}` }))
  const r = planEffects({ nowMs: NOW, lastTalkAt, meta: { figures: figs, mood: 0 } })
  assert.equal(r.adjusted.length, 2, '每人 5，合计上限 10 → 只能 2 人')
  assert.equal(r.totalDelta, 10)
  assert.ok(r.skipped.length >= 2)
})

test('兴趣：7 天前聊过的不算', () => {
  const r = planEffects({ nowMs: NOW, lastTalkAt: () => NOW - 8 * D, meta: { figures: [{ qq: '999999', delta: 3 }] } })
  assert.equal(r.adjusted.length, 0)
  assert.equal(r.skipped[0].reason, 'not-recent')
})

test('兴趣：QQ 不合法 / delta 为 0 都跳过', () => {
  const r = planEffects({
    nowMs: NOW, lastTalkAt: () => NOW - H,
    meta: { figures: [{ qq: 'abc', delta: 3 }, { qq: '888888', delta: 0 }] },
  })
  assert.equal(r.adjusted.length, 0)
  assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ['bad-qq', 'zero'])
})

test('情绪：mood ≤ -1 才降档；0 和正数不降', () => {
  for (const [mood, expect] of [[-2, -1], [-1, -1], [0, null], [2, null]]) {
    const r = planEffects({ nowMs: NOW, lastTalkAt: () => null, meta: { figures: [], mood } })
    assert.equal(r.moodApplied, expect, `mood=${mood}`)
  }
})

test('做梦时刻：落在睡点+时长×55% 附近，且同一天两次一致、次日不同', () => {
  const rhythm = { bedtime: 150, sleepMin: 480, allNighter: false }   // 02:30 睡，8 小时
  const a = dreamMomentOf(rhythm, '2026-11-13')
  const b = dreamMomentOf(rhythm, '2026-11-13')
  assert.deepEqual(a, b, '同一天必须一致')
  assert.ok(Math.abs(a.minuteOfDay - (150 + 480 * 0.55)) <= 21, `应在深睡中段附近，实际 ${a.minuteOfDay}`)
  const c = dreamMomentOf(rhythm, '2026-11-14')
  assert.notEqual(a.minuteOfDay, c.minuteOfDay, '隔天抖动应该不同')
})

test('做梦时刻：通宵那天不做梦', () => {
  assert.equal(dreamMomentOf({ bedtime: 150, sleepMin: 480, allNighter: true }, '2026-11-13').atMs, null)
})

test('限额常量与规格一致', () => {
  assert.equal(LIMITS.MAX_FIGURES, 3)
  assert.equal(LIMITS.MAX_TOTAL, 10)
  assert.equal(LIMITS.RECENT_MS, 7 * 86400000)
})
