/**
 * test/local-pergroup.test.js — 按群覆盖主动接话参数（本地补丁）。
 *
 * 覆盖表：pacing.reply.groupOverrides = { "<群号>": { repeatMin: 5, ... } }
 * 断言：同一个群，覆盖值优先于全局值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, groupAtEvent } from './helpers.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot(t, reply = {}) {
  const h = await bootKernel({
    config: {
      pacing: {
        merge: { enabled: false },
        reply: {
          enabled: true,
          groups: [GROUP_ID],
          hourlyMax: 20,
          sensitivity: 0,
          repeatEnabled: true,
          repeatMin: 3,
          repeatWindowMin: 3,
          repeatCooldownMin: 10,
          silenceEnabled: false,
          ...reply,
        },
      },
      pluginConfig: {
        'link-parser': { enabled: false },
        'gate-wake': { adminQq: ADMIN_QQ, groupAtRequired: true },
      },
    },
  })
  t.after(() => h.dispose())
  return h
}

const LINE = '这句话大家都同意吧真的'

test('按群覆盖：该群 repeatMin=5 → 刷 3 次不跟（全局是 3）', async (t) => {
  const h = await boot(t, { groupOverrides: { [String(GROUP_ID)]: { repeatMin: 5 } } })
  h.ctx.setPromptHandler(async () => {})
  for (let i = 0; i < 3; i++) {
    await emitRaw(h.kernel, groupAtEvent({ text: LINE, messageId: 8001 + i, userId: 31001 + i, at: false }))
    await sleep(30)
  }
  await sleep(400)
  assert.equal(h.sent.filter((s) => String(s.wire || '').includes(LINE)).length, 0, '覆盖后阈值 5，3 次不该跟')
})

test('按群覆盖：该群 repeatMin=5 → 刷到 5 次才跟', async (t) => {
  const h = await boot(t, { groupOverrides: { [String(GROUP_ID)]: { repeatMin: 5 } } })
  h.ctx.setPromptHandler(async () => {})
  for (let i = 0; i < 5; i++) {
    await emitRaw(h.kernel, groupAtEvent({ text: LINE, messageId: 8101 + i, userId: 31101 + i, at: false }))
    await sleep(30)
  }
  await waitFor(() => h.sent.some((s) => String(s.wire || '').includes(LINE)), { label: '第 5 次跟', timeout: 3000 })
  assert.equal(h.sent.filter((s) => String(s.wire || '').includes(LINE)).length, 1, '只跟一句')
})

test('按群覆盖：该群 repeatEnabled=false → 刷 6 次也不跟', async (t) => {
  const h = await boot(t, { groupOverrides: { [String(GROUP_ID)]: { repeatEnabled: false } } })
  h.ctx.setPromptHandler(async () => {})
  for (let i = 0; i < 6; i++) {
    await emitRaw(h.kernel, groupAtEvent({ text: LINE, messageId: 8201 + i, userId: 31201 + i, at: false }))
    await sleep(30)
  }
  await sleep(400)
  assert.equal(h.sent.filter((s) => String(s.wire || '').includes(LINE)).length, 0, '该群关了复读')
})

test('按群覆盖：hourlyMax=0 等于该群彻底不主动接话', async (t) => {
  const h = await boot(t, { groupOverrides: { [String(GROUP_ID)]: { hourlyMax: 0 } } })
  let prompted = 0
  h.ctx.setPromptHandler(async () => { prompted++ })
  for (let i = 0; i < 4; i++) {
    await emitRaw(h.kernel, groupAtEvent({ text: '这个话题挺有意思的' + i, messageId: 8301 + i, userId: 31301 + i, at: false }))
    await sleep(40)
  }
  await sleep(600)
  assert.equal(prompted, 0, '该群 hourlyMax=0，不该起任何主动轮')
})

test('按群覆盖：enabled=false → 该群不主动接话（含复读）', async (t) => {
  const h = await boot(t, { groupOverrides: { [String(GROUP_ID)]: { enabled: false } } })
  let prompted = 0
  h.ctx.setPromptHandler(async () => { prompted++ })
  // 故意用重复的话：如果 enabled 没生效，复读会跟一句
  for (let i = 0; i < 6; i++) {
    await emitRaw(h.kernel, groupAtEvent({ text: LINE, messageId: 8401 + i, userId: 31401 + i, at: false }))
    await sleep(30)
  }
  await sleep(600)
  assert.equal(prompted, 0, 'enabled=false 不该起主动轮')
  assert.equal(h.sent.filter((s) => String(s.wire || '').includes(LINE)).length, 0, 'enabled=false 也不该复读')
})

test('按群覆盖：enabled=true 时其余群/全局不受影响', async (t) => {
  const h = await boot(t, { groupOverrides: { '99999999': { enabled: false } } })  // 别的群关掉
  h.ctx.setPromptHandler(async () => {})
  for (let i = 0; i < 5; i++) {
    await emitRaw(h.kernel, groupAtEvent({ text: LINE, messageId: 8501 + i, userId: 31501 + i, at: false }))
    await sleep(30)
  }
  await waitFor(() => h.sent.some((s) => String(s.wire || '').includes(LINE)), { label: '本群仍复读', timeout: 3000 })
  assert.equal(h.sent.filter((s) => String(s.wire || '').includes(LINE)).length, 1, '本群不受别的群影响')
})
