/**
 * test/local-memgraph.test.js — 长期记忆插件（本地补丁）集成测试。
 *
 * 会连**真实的** memd（127.0.0.1:18082）：先塞一条测试记忆 → 走一轮回话 →
 * 断言提示词里出现了「[长期记忆]」指针 → 清理测试数据。
 * 服务没起时自动跳过（不阻塞 CI）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, groupAtEvent } from './helpers.mjs'

const MEMD = process.env.MEM_ENDPOINT || 'http://127.0.0.1:18082'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function memdUp() {
  try {
    const r = await fetch(`${MEMD}/api/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

async function addMem(content, topics) {
  const r = await fetch(`${MEMD}/api/add`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat: `group:${GROUP_ID}`, content, topics, importance: 0.9 }),
    signal: AbortSignal.timeout(3000),
  })
  const j = await r.json()
  return j.id
}

async function delMem(id) {
  try {
    await fetch(`${MEMD}/api/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }), signal: AbortSignal.timeout(3000),
    })
  } catch { /* 忽略 */ }
}

async function boot(t, cfg = {}) {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: {
        'link-parser': { enabled: false },
        'gate-wake': { adminQq: ADMIN_QQ },
        'mem-graph': { enabled: true, endpoint: MEMD, pointerEnabled: true, pointerMinChars: 4, recallK: 5, ...cfg },
      },
    },
  })
  t.after(() => h.dispose())
  return h
}

test('长期记忆：回话前注入一行指针（真连 memd）', async (t) => {
  if (!(await memdUp())) { t.skip('memd 未启动'); return }
  const id = await addMem('测试记忆：阿测试下周要面试，紧张到睡不着', ['阿测试', '面试', '紧张'])
  t.after(() => delMem(id))

  const h = await boot(t)
  h.ctx.setPromptHandler(async () => {})

  await emitRaw(h.kernel, groupAtEvent({ text: '阿测试面试准备得怎么样了', messageId: 9101 }))
  await waitFor(() => (h.ctx._prompts || []).length > 0, { label: '模型被调用', timeout: 4000 })
  await sleep(120)

  const all = (h.ctx._prompts || []).map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n')
  assert.ok(all.includes('[长期记忆]'), '提示词里应出现长期记忆指针')
  assert.ok(all.includes('阿测试'), '指针里应带上最相关那条的摘要')
})

test('长期记忆：关掉插件后不再注入', async (t) => {
  if (!(await memdUp())) { t.skip('memd 未启动'); return }
  const id = await addMem('测试记忆：阿测试面试很紧张', ['阿测试', '面试'])
  t.after(() => delMem(id))

  const h = await boot(t, { enabled: false })
  h.ctx.setPromptHandler(async () => {})
  await emitRaw(h.kernel, groupAtEvent({ text: '阿测试面试准备得怎么样了', messageId: 9102 }))
  await waitFor(() => (h.ctx._prompts || []).length > 0, { label: '模型被调用', timeout: 4000 })
  await sleep(120)
  const all = (h.ctx._prompts || []).map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n')
  assert.ok(!all.includes('[长期记忆]'), '关掉后不该有指针')
})

test('长期记忆：群聊检索排除私聊记忆（保密）', async (t) => {
  if (!(await memdUp())) { t.skip('memd 未启动'); return }
  // 一条「私聊来源」的记忆，内容带独特词
  const r = await fetch(`${MEMD}/api/add`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat: 'private:10002', content: '秘密记忆：紫罗兰计划已经启动', topics: ['紫罗兰计划'], importance: 0.9, secret: true }),
    signal: AbortSignal.timeout(3000),
  })
  const id = (await r.json()).id
  t.after(() => delMem(id))

  const h = await boot(t)
  h.ctx.setPromptHandler(async () => {})
  await emitRaw(h.kernel, groupAtEvent({ text: '紫罗兰计划是什么情况', messageId: 9103 }))
  await waitFor(() => (h.ctx._prompts || []).length > 0, { label: '模型被调用', timeout: 4000 })
  await sleep(120)
  const all = (h.ctx._prompts || []).map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n')
  // 注意：不能断言「紫罗兰计划」——它出现在我们自己发的消息正文里
  assert.ok(!all.includes('秘密记忆：'), '群聊里不该出现私聊来源的记忆正文')
  assert.ok(!all.includes('已经启动'), '群聊里不该出现私聊来源的记忆正文')
})
