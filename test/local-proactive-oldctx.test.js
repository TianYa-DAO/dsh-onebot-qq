/**
 * test/local-proactive-oldctx.test.js — 冷场找话必须看得到"较旧"的群上文（回归 2026-11-07 事故）。
 *
 * 线上现象：群里 20:03 有过对话，她 22:09 的冷场轮却说"群里安静一会儿了/没有新的活"。
 * 根因：群上文默认时效 30 分钟，而冷场阈值本身常 ≥60 分钟 →
 *       **只要冷场判定成立，上文必然是空的**，她永远接不上刚才的话题。
 * 修法：冷场/续聊轮把时效放宽到 6 小时，并给每行标"(X小时前)"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, waitFor, GROUP_ID, MEMBER_QQ, ADMIN_QQ } from './helpers.mjs'

test('冷场找话：2 小时前的群消息也要进 prompt（且标注时间）', async (t) => {
  const OLD_LINE = '今晚玩哈比不'
  const h = await bootKernel({
    config: { pluginConfig: { 'link-parser': { enabled: false }, 'gate-wake': { adminQq: ADMIN_QQ } } },
  })
  t.after(async () => { await h.dispose() })
  h.ctx.setPromptHandler(async () => '嗯')

  // 群历史：一条 2 小时前的（默认 30 分钟时效会把它过滤掉）
  h.kernel.napcat.groupHistory = async () => [
    {
      message_id: 8801,
      time: Math.floor(Date.now() / 1000) - 2 * 3600,
      sender: { user_id: MEMBER_QQ, nickname: '陈天乐魔帝' },
      message: [{ type: 'text', data: { text: OLD_LINE } }],
    },
  ]

  assert.equal(typeof h.kernel.runProactiveTurn, 'function')
  // 用 runProactiveTurn 直接起一轮"冷场找话"
  await h.kernel.runProactiveTurn({ chatKey: `group:${GROUP_ID}`, groupId: GROUP_ID, reason: 'silence' })
  await waitFor(() => (h.ctx._prompts || []).length > 0, 8000, '冷场轮应起一轮模型调用')

  const prompt = JSON.stringify(h.ctx._prompts.at(-1)?.content || '')
  assert.ok(prompt.includes(OLD_LINE), '两小时前的消息必须进 prompt（否则她又会说"群里没人"）')
  assert.ok(/小时前/.test(prompt), '旧消息应标注"(X小时前)"，让她知道这是多久前的话')
})

test('普通回话：仍然只取 30 分钟内的上文（不把老对话塞进来）', async (t) => {
  const OLD_LINE = '很久以前的一句话'
  const FRESH_LINE = '刚刚说的话'
  const h = await bootKernel({
    config: { pluginConfig: { 'link-parser': { enabled: false }, 'gate-wake': { adminQq: ADMIN_QQ } } },
  })
  t.after(async () => { await h.dispose() })
  h.ctx.setPromptHandler(async () => '嗯')
  h.kernel.napcat.groupHistory = async () => [
    { message_id: 8901, time: Math.floor(Date.now() / 1000) - 2 * 3600,
      sender: { user_id: MEMBER_QQ, nickname: '群友' }, message: [{ type: 'text', data: { text: OLD_LINE } }] },
    { message_id: 8902, time: Math.floor(Date.now() / 1000) - 60,
      sender: { user_id: MEMBER_QQ, nickname: '群友' }, message: [{ type: 'text', data: { text: FRESH_LINE } }] },
  ]
  // 发一条 @ 她的消息，走普通回话
  const { emitRaw, groupAtEvent } = await import('./helpers.mjs')
  await emitRaw(h.kernel, groupAtEvent({ text: '@机器人 在吗', messageId: 8903, at: true }))
  await waitFor(() => (h.ctx._prompts || []).length > 0, 8000, '应起一轮回话')
  const prompt = JSON.stringify(h.ctx._prompts.at(-1)?.content || '')
  assert.ok(prompt.includes(FRESH_LINE), '新消息应在')
  assert.equal(prompt.includes(OLD_LINE), false, '普通回话不该塞 2 小时前的旧话')
})
