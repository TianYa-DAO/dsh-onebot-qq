/**
 * test/local-repeat.test.js — 复读机行为（本地补丁）。
 *
 * 群里连着几个人刷「同一句话」时，绘梨衣跟着刷一句一模一样的：
 *   · 不进模型（不花 token）
 *   · 同一个群有冷却，不会一直跟
 *   · 太短的话（「？」「好」）不复读
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, groupAtEvent } from './helpers.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot(t, pacing = {}) {
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
          ...pacing,
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

test('复读机：群友连着刷同一句 3 次 → 它原样跟一句，且不进模型', async (t) => {
  const h = await boot(t)
  let prompted = 0
  h.ctx.setPromptHandler(async () => { prompted++ })

  const line = '经过判断，田鸡压根不会写简历。'
  // 三个人各发一遍（都不 @，所以不会唤醒，只会进主动接话的观察路径）
  for (let i = 0; i < 3; i++) {
    await emitRaw(h.kernel, groupAtEvent({ text: line, messageId: 7001 + i, userId: 30001 + i, at: false }))
    await sleep(30)
  }

  await waitFor(() => h.sent.some((s) => String(s.wire || '').includes('田鸡压根不会写简历')), {
    label: '复读那一句',
    timeout: 3000,
  })
  const hit = h.sent.filter((s) => String(s.wire || '').includes('田鸡压根不会写简历'))
  assert.equal(hit.length, 1, '只跟一句')
  assert.equal(prompted, 0, '复读不走模型')
})

test('复读机：只刷 2 次不够（默认 3 人）', async (t) => {
  const h = await boot(t)
  h.ctx.setPromptHandler(async () => {})
  const line = '我们都爱喝奶茶不加糖'
  for (let i = 0; i < 2; i++) {
    await emitRaw(h.kernel, groupAtEvent({ text: line, messageId: 7101 + i, userId: 30101 + i, at: false }))
    await sleep(30)
  }
  await sleep(400)
  assert.equal(h.sent.filter((s) => String(s.wire || '').includes('我们都爱喝奶茶不加糖')).length, 0, '2 次不该复读')
})

test('复读机：太短的话不复读（「？」这种）', async (t) => {
  const h = await boot(t)
  h.ctx.setPromptHandler(async () => {})
  for (let i = 0; i < 5; i++) {
    await emitRaw(h.kernel, groupAtEvent({ text: '？？', messageId: 7201 + i, userId: 30201 + i, at: false }))
    await sleep(30)
  }
  await sleep(400)
  assert.equal(h.sent.filter((s) => String(s.wire || '').includes('？？')).length, 0, '短句不复读')
})

test('复读机：关掉开关就不复读', async (t) => {
  const h = await boot(t, { repeatEnabled: false })
  h.ctx.setPromptHandler(async () => {})
  const line = '这句话大家都同意吧'
  for (let i = 0; i < 4; i++) {
    await emitRaw(h.kernel, groupAtEvent({ text: line, messageId: 7301 + i, userId: 30301 + i, at: false }))
    await sleep(30)
  }
  await sleep(400)
  assert.equal(h.sent.filter((s) => String(s.wire || '').includes('这句话大家都同意吧')).length, 0, '关了就不跟')
})
