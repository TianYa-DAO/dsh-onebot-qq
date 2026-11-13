/**
 * test/local-forward-context.test.js — 群上文里的「合并转发」必须能读出正文。
 *
 * 线上反馈（2026-11-09）：群里有人转了一份聊天记录，她说"看不了合并转发的聊天记录"。
 * 原因：extractText 是纯函数（不碰网络），对 forward 段只产出占位符「[合并转发]」，
 *      fetchGroupContext 又只取 parsed.text → 正文被丢掉。
 *        · @她 + 同条带转发 → 走 index.js，正常
 *        · 引用一条转发   → 走 index.js 的被引反查，正常
 *        · **转发在上文里** → 只有占位符（本测试钉的就是这条）
 * 修法：fetchGroupContext 内解析 parsed.forwards（内联优先，其次 get_forward_msg），
 *      并按"消息条数"取窗口，避免转发正文把别的消息挤出去。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, waitFor, emitRaw, GROUP_ID, MEMBER_QQ, ADMIN_QQ } from './helpers.mjs'

const now = () => Math.floor(Date.now() / 1000)

function atEvent(selfId, text, messageId) {
  return {
    post_type: 'message', message_type: 'group', group_id: GROUP_ID,
    user_id: MEMBER_QQ, message_id: messageId,
    sender: { user_id: MEMBER_QQ, nickname: '群友' },
    message: [
      { type: 'at', data: { qq: String(selfId) } },
      { type: 'text', data: { text: ` ${text}` } },
    ],
  }
}

test('上文里的合并转发（内联正文）：正文要进 prompt，不能只有占位符', async (t) => {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: { 'link-parser': { enabled: false }, 'gate-wake': { adminQq: ADMIN_QQ } },
    },
  })
  t.after(async () => { await h.dispose() })
  h.ctx.setPromptHandler(async () => '嗯')
  h.kernel.napcat.groupHistory = async () => [
    { message_id: 7001, time: now() - 60, sender: { user_id: 111, nickname: '甲' },
      message: [{ type: 'forward', data: { id: 'fwd-inline', content: [
        { sender: { user_id: 111, nickname: '甲' }, message: [{ type: 'text', data: { text: '转发里的第一句' } }] },
        { sender: { user_id: 222, nickname: '乙' }, message: [{ type: 'text', data: { text: '转发里的第二句' } }] },
      ] } }] },
  ]
  await emitRaw(h.kernel, atEvent(h.kernel.napcat.selfId, '你看上面那个', 7002))
  await waitFor(() => (h.ctx._prompts || []).length > 0, 8000, '应起一轮回话')

  const prompt = JSON.stringify(h.ctx._prompts.at(-1)?.content || '')
  assert.ok(prompt.includes('转发里的第一句'), '转发正文必须在 prompt 里（否则她只说"看不了"）')
  assert.ok(prompt.includes('转发里的第二句'), '转发里每一句都要带上')
})

test('上文里的合并转发（只有 id）：要回退打 get_forward_msg，且同样进 prompt', async (t) => {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: { 'link-parser': { enabled: false }, 'gate-wake': { adminQq: ADMIN_QQ } },
    },
  })
  t.after(async () => { await h.dispose() })
  h.ctx.setPromptHandler(async () => '嗯')
  let calls = 0
  h.kernel.napcat.getForwardMsg = async () => {
    calls++
    return { messages: [{ sender: { user_id: 111, nickname: '甲' }, message: [{ type: 'text', data: { text: '只有id的转发正文' } }] }] }
  }
  h.kernel.napcat.groupHistory = async () => [
    { message_id: 7101, time: now() - 60, sender: { user_id: 111, nickname: '甲' },
      message: [{ type: 'forward', data: { id: 'fwd-only-id' } }] },
  ]
  await emitRaw(h.kernel, atEvent(h.kernel.napcat.selfId, '这里面说啥', 7102))
  await waitFor(() => (h.ctx._prompts || []).length > 0, 8000, '应起一轮回话')

  const prompt = JSON.stringify(h.ctx._prompts.at(-1)?.content || '')
  assert.ok(prompt.includes('只有id的转发正文'), '内联缺失时要回退打接口，正文仍要进 prompt')
  assert.ok(calls >= 1, '应调用 get_forward_msg')
})

test('同一条转发反复出现在上文里：只打一次接口（缓存）', async (t) => {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: { 'link-parser': { enabled: false }, 'gate-wake': { adminQq: ADMIN_QQ } },
    },
  })
  t.after(async () => { await h.dispose() })
  h.ctx.setPromptHandler(async () => '嗯')
  let calls = 0
  h.kernel.napcat.getForwardMsg = async () => {
    calls++
    return { messages: [{ sender: { user_id: 1, nickname: '甲' }, message: [{ type: 'text', data: { text: '缓存测试正文' } }] }] }
  }
  h.kernel.napcat.groupHistory = async () => [
    { message_id: 7201, time: now() - 60, sender: { user_id: 111, nickname: '甲' },
      message: [{ type: 'forward', data: { id: 'fwd-cache' } }] },
  ]
  await emitRaw(h.kernel, atEvent(h.kernel.napcat.selfId, '第一问', 7202))
  await waitFor(() => (h.ctx._prompts || []).length >= 1, 8000)
  const afterFirst = calls
  await emitRaw(h.kernel, atEvent(h.kernel.napcat.selfId, '第二问', 7203))
  await waitFor(() => (h.ctx._prompts || []).length >= 2, 8000)
  assert.equal(calls, afterFirst, '同一个转发 id 第二次不该再打接口')
})

test('转发正文很长时：不会把别的消息挤出上文窗口', async (t) => {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      outbound: { groupContextCount: 5 },
      pluginConfig: { 'link-parser': { enabled: false }, 'gate-wake': { adminQq: ADMIN_QQ } },
    },
  })
  t.after(async () => { await h.dispose() })
  h.ctx.setPromptHandler(async () => '嗯')
  const longInner = Array.from({ length: 8 }, (_, i) => ({
    sender: { user_id: 300 + i, nickname: '人' + i },
    message: [{ type: 'text', data: { text: `转发正文第${i}条` } }],
  }))
  h.kernel.napcat.groupHistory = async () => [
    { message_id: 7301, time: now() - 120, sender: { user_id: 111, nickname: '甲' },
      message: [{ type: 'forward', data: { id: 'fwd-long', content: longInner } }] },
    { message_id: 7302, time: now() - 90, sender: { user_id: 111, nickname: '甲' }, message: [{ type: 'text', data: { text: '普通消息A' } }] },
    { message_id: 7303, time: now() - 60, sender: { user_id: 111, nickname: '甲' }, message: [{ type: 'text', data: { text: '普通消息B' } }] },
    { message_id: 7304, time: now() - 30, sender: { user_id: 111, nickname: '甲' }, message: [{ type: 'text', data: { text: '普通消息C' } }] },
  ]
  await emitRaw(h.kernel, atEvent(h.kernel.napcat.selfId, '说说看', 7305))
  await waitFor(() => (h.ctx._prompts || []).length > 0, 8000)
  const prompt = JSON.stringify(h.ctx._prompts.at(-1)?.content || '')
  assert.ok(prompt.includes('普通消息A') && prompt.includes('普通消息C'), '转发再长也不能把别的消息挤掉')
  assert.ok(prompt.includes('转发正文第0条'), '转发正文也要在')
})

test('取不到转发内容时：不崩、不塞垃圾占位', async (t) => {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: { 'link-parser': { enabled: false }, 'gate-wake': { adminQq: ADMIN_QQ } },
    },
  })
  t.after(async () => { await h.dispose() })
  h.ctx.setPromptHandler(async () => '嗯')
  h.kernel.napcat.getForwardMsg = async () => { throw new Error('消息已过期或者为内层消息') }
  h.kernel.napcat.groupHistory = async () => [
    { message_id: 7401, time: now() - 60, sender: { user_id: 111, nickname: '甲' },
      message: [{ type: 'forward', data: { id: 'fwd-dead' } }] },
    { message_id: 7402, time: now() - 30, sender: { user_id: 111, nickname: '甲' }, message: [{ type: 'text', data: { text: '还在聊别的' } }] },
  ]
  await emitRaw(h.kernel, atEvent(h.kernel.napcat.selfId, '继续', 7403))
  await waitFor(() => (h.ctx._prompts || []).length > 0, 8000, '取不到转发也不能挡住这一轮')
  const prompt = JSON.stringify(h.ctx._prompts.at(-1)?.content || '')
  assert.ok(prompt.includes('还在聊别的'), '别的消息照常进上文')
  assert.equal(prompt.includes('取不到'), false, '不该塞"内容取不到"这类垃圾给模型')
})
