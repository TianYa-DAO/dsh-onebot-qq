/**
 * test/local-proactive-ctx.test.js — 主动接话必须真的读到群上文（回归测试）。
 *
 * 背景（2026-11-05 线上事故）：
 *   fetchGroupContext 的返回值从「字符串」改成 { block, images } 之后，
 *   主动接话那条路径仍在调用 `.replace()` → 抛 "block.replace is not a function"，
 *   上文注入失败但异常被吞掉（只 warn），于是她以为群里没人说话。
 *   表现：被提醒主动接话时，她会说「群里没人说话」之类，而不接真实话题。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, waitFor, GROUP_ID, MEMBER_QQ } from './helpers.mjs'

const HOUR = 3600_000

test('主动接话：能读到群上文（回归 block.replace 事故）', async (t) => {
  const warns = []
  const h = await bootKernel({
    config: {
      pacing: {
        merge: { enabled: false },
        reply: {
          enabled: true,
          groups: [GROUP_ID],
          hourlyMax: 20,
          sensitivity: 0,          // 不挑时机
          silenceEnabled: true,    // 冷场找话
          coldSilenceMs: 60_000,   // 安静 1 分钟就算冷场
          minGapMs: 0,
        },
      },
      pluginConfig: { 'link-parser': { enabled: false } },
    },
  })
  t.after(() => h.dispose())

  // 群上文里要有可辨认的内容
  const HISTORY_LINE = '群友刚刚在聊今晚吃什么'
  h.kernel.napcat.groupHistory = async () => [
    // 故意早于水位之外，且时间新鲜
    { message_id: 9001, time: Math.floor(Date.now() / 1000) - 30,
      sender: { user_id: MEMBER_QQ, nickname: '群友' }, message: [{ type: 'text', data: { text: HISTORY_LINE } }] },
    { message_id: 9002, time: Math.floor(Date.now() / 1000) - 25,
      sender: { user_id: MEMBER_QQ, nickname: '群友' }, message: [{ type: 'text', data: { text: '火锅还是烤肉' } }] },
  ]

  const origWarn = h.kernel.log?.warn
  if (h.kernel.log) {
    h.kernel.log.warn = (...a) => { warns.push(a.join(' ')); origWarn?.(...a) }
  }

  h.ctx.setPromptHandler(async () => '嗯')
  // 让「群安静了」成立：把最后入站时间推早
  h.kernel.state.get(`group:${GROUP_ID}`).lastInboundAt = Date.now() - 10 * 60_000

  // 直接起一轮主动接话（内核暴露了 runProactiveTurn，绕过 30s 定时器与机会窗口）
  assert.equal(typeof h.kernel.runProactiveTurn, 'function', '内核应暴露 runProactiveTurn 便于测试/手动触发')
  await h.kernel.runProactiveTurn({ chatKey: `group:${GROUP_ID}`, groupId: GROUP_ID, reason: 'silence' })

  // 等模型被叫到（主动轮）
  await waitFor(() => (h.ctx._prompts || []).length > 0, 6000, '主动接话轮应起一轮模型调用')
  const prompt = JSON.stringify(h.ctx._prompts.at(-1)?.content || '')
  assert.ok(prompt.includes(HISTORY_LINE), '群上文必须进 prompt（否则她以为没人说话）')
  const bad = warns.filter((w) => /block\.replace/.test(w))
  assert.equal(bad.length, 0, `不该再出现 block.replace 报错：${bad.join(' | ')}`)
})
