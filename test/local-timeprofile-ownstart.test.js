/**
 * test/local-timeprofile-ownstart.test.js — 跨天时段的两种星期语义。
 *
 * 默认（旧行为）：星期按**当前这一天**判。22:00~02:00 + 勾周五 =
 *   周五 22:00~23:59 与 周五 00:00~01:59（后者是周四晚的尾巴）。
 * ownStartDay:true（新开关）：尾巴按**前一天**判。22:00~02:00 + 勾周五 =
 *   周五 22:00 一直到周六 02:00（正是"周五晚上整段"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickTimeProfile, profileCoverage } from '../kernel/pacing.js'

// 2026-11-06 是周五
const FRI = (h, m) => new Date(2026, 10, 6, h, m)      // 周五
const SAT = (h, m) => new Date(2026, 10, 7, h, m)      // 周六
const THU = (h, m) => new Date(2026, 10, 5, h, m)      // 周四
const minOf = (d) => d.getHours() * 60 + d.getMinutes()
const P = (extra = {}) => [{ from: 22 * 60, to: 2 * 60, days: [5], ...extra }]

test('默认语义：周五 22:00~02:00 不覆盖周六凌晨（尾巴算周六，没勾就断）', () => {
  assert.equal(Object.keys(pickTimeProfile(P(), minOf(FRI(22, 30)), FRI(22, 30))).length > 0, true, '周五 22:30 命中')
  assert.equal(Object.keys(pickTimeProfile(P(), minOf(FRI(1, 0)), FRI(1, 0))).length > 0, true, '周五 01:00 命中（当天）')
  assert.equal(Object.keys(pickTimeProfile(P(), minOf(SAT(1, 0)), SAT(1, 0))).length, 0, '周六 01:00 不命中（默认语义）')
})

test('ownStartDay：周五 22:00~02:00 覆盖到周六 02:00', () => {
  const prof = P({ ownStartDay: true })
  assert.equal(Object.keys(pickTimeProfile(prof, minOf(FRI(22, 30)), FRI(22, 30))).length > 0, true, '周五 22:30 命中')
  assert.equal(Object.keys(pickTimeProfile(prof, minOf(SAT(1, 0)), SAT(1, 0))).length > 0, true, '周六 01:00 命中（尾巴算周五）')
  assert.equal(Object.keys(pickTimeProfile(prof, minOf(SAT(2, 0)), SAT(2, 0))).length, 0, '周六 02:00 结束')
  // 周五自己的凌晨（周四晚尾巴）不该命中
  assert.equal(Object.keys(pickTimeProfile(prof, minOf(FRI(1, 0)), FRI(1, 0))).length, 0, '周五 01:00 不命中（那是周四晚）')
  // 周四 23:00 也不该命中（周四没勾）
  assert.equal(Object.keys(pickTimeProfile(prof, minOf(THU(23, 0)), THU(23, 0))).length, 0, '周四 23:00 不命中')
})

test('ownStartDay：不勾的人配置不受影响（向后兼容）', () => {
  const legacy = P()   // 没写 ownStartDay
  const explicitFalse = P({ ownStartDay: false })
  for (const when of [FRI(23, 0), SAT(1, 30), FRI(0, 30)]) {
    const a = Object.keys(pickTimeProfile(legacy, minOf(when), when)).length > 0
    const b = Object.keys(pickTimeProfile(explicitFalse, minOf(when), when)).length > 0
    assert.equal(a, b, `两种写法结果应一致 @${when.toString().slice(0, 24)}`)
  }
})

test('profileCoverage：默认语义下周五 22:00~02:00 自相矛盾（周五晚上 + 周五凌晨）', () => {
  const cov = profileCoverage({ from: 22 * 60, to: 2 * 60, days: [5] })
  assert.deepEqual(cov.sort((a, b) => a.dow - b.dow || a.from - b.from), [
    { dow: 5, from: 0, to: 120 },      // 周五凌晨（其实是周四晚）
    { dow: 5, from: 1320, to: 1440 },  // 周五晚上
  ])
})

test('profileCoverage：ownStartDay 下是连续的「周五晚 → 周六凌晨」', () => {
  const cov = profileCoverage({ from: 22 * 60, to: 2 * 60, days: [5], ownStartDay: true })
  assert.deepEqual(cov.sort((a, b) => a.dow - b.dow || a.from - b.from), [
    { dow: 5, from: 1320, to: 1440 },
    { dow: 6, from: 0, to: 120 },
  ])
})

test('profileCoverage：不跨天 / 全天 的覆盖', () => {
  assert.deepEqual(profileCoverage({ from: 9 * 60, to: 18 * 60, days: [1] }), [{ dow: 1, from: 540, to: 1080 }])
  assert.deepEqual(profileCoverage({ from: 0, to: 0, days: [3] }), [{ dow: 3, from: 0, to: 1440 }])
})
