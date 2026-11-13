/**
 * test/local-private-merge.test.js — 私聊合批（2026-11-12）
 *
 * ⚠️ 这个测试要**模拟真实打字节奏**：他隔一阵发第一句、然后 1~4 秒内连着补几句。
 *    最初写成"三条同步 emit"→ 掩盖了真 bug：第一句因为"慢聊直答"（gap > skipIfSlowMs）
 *    被立刻起轮，后面几句全被拆到第二轮。线上就是"感觉没合批"。
 *
 * 语义：
 *   · 私聊 = debounce 合批（边打边等，安静了才发车），**不受"慢聊直答"影响**
 *   · 群聊 = 各自成轮（两个人叫 → 各回各的），冷场仍可快答
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, emitRaw, waitFor, ADMIN_QQ } from './helpers.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot(t, pacing = {}) {
  const h = await bootKernel({
    config: {
      archive: { enabled: false, dir: 'logs/qq_chat' },
      pacing: {
        merge: { enabled: true, windowMs: 500, windowActiveMs: 2500, maxWaitMs: 6000, activeGapMs: 15000, skipIfSlowMs: 30000 },
        ...pacing,
      },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ },
      },
    },
  })
  t.after(() => h.dispose())
  return h
}

const privEvent = (text, id, userId = ADMIN_QQ, time = Date.now()) => ({
  post_type: 'message', message_type: 'private', user_id: userId,
  time: Math.floor(time / 1000),
  message_id: id, sender: { user_id: userId, nickname: '主人' },
  message: [{ type: 'text', data: { text } }],
})

test('真实节奏：隔一阵发第一句 + 1~2 秒内连补三句 → 只起一轮，四句都在', async (t) => {
  const h = await boot(t)
  const t0 = Date.now()
  await emitRaw(h.kernel, privEvent('在学习', 8001, ADMIN_QQ, t0))           // 距上一条很久（模拟真实）
  await sleep(1200)
  await emitRaw(h.kernel, privEvent('刚学完数学', 8002, ADMIN_QQ, Date.now()))
  await sleep(1800)
  await emitRaw(h.kernel, privEvent('现在要做英语', 8003, ADMIN_QQ, Date.now()))
  await sleep(1800)
  await emitRaw(h.kernel, privEvent('累累的', 8004, ADMIN_QQ, Date.now()))

  await waitFor(() => h.ctx._prompts.length >= 1, { label: '私聊起轮' })
  await sleep(1200)      // 留出"万一拆成两轮"的时间
  assert.equal(h.ctx._prompts.length, 1, `连发四句只该起一轮（实际 ${h.ctx._prompts.length} 轮）`)
  const text = JSON.stringify(h.ctx._prompts[0])
  for (const s of ['在学习', '刚学完数学', '现在要做英语', '累累的']) {
    assert.ok(text.includes(s), `四个片段都该并进同一轮（缺「${s}」）`)
  }
})

test('单条消息（隔很久才发一条）→ 也要在窗口后才发车，不是抢答（但很快就到）', async (t) => {
  const h = await boot(t)
  const t0 = Date.now()
  const started = Date.now()
  await emitRaw(h.kernel, privEvent('单独一句', 8101, ADMIN_QQ, t0))
  await waitFor(() => h.ctx._prompts.length >= 1, { label: '单条起轮' })
  const waited = Date.now() - started
  assert.ok(waited >= 400, `应该等 debounce 窗口（实际只用 ${waited}ms，等于没等）`)
})

test('群聊仍是各自成轮：两个人叫 → 两轮', async (t) => {
  const h = await boot(t)
  const groupEvent = (text, id) => ({
    post_type: 'message', message_type: 'group', group_id: 20001, user_id: 30001,
    message_id: id, sender: { user_id: 30001, nickname: '群友' },
    message: [{ type: 'at', data: { qq: String(h.kernel.napcat.selfId) } }, { type: 'text', data: { text } }],
  })
  await emitRaw(h.kernel, groupEvent('甲叫', 8201))
  await sleep(600)
  await emitRaw(h.kernel, groupEvent('乙叫', 8202))
  await waitFor(() => h.ctx._prompts.length >= 2, { label: '群聊两轮' })
  assert.equal(h.ctx._prompts.length, 2, '群里两个人叫应该各回各的')
})
