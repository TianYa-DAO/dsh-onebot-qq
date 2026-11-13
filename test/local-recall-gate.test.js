/**
 * test/local-recall-gate.test.js — 「引用 + 撤回」必须两道闸（摘自上游戏 2026-11-09 线上事故修复）。
 *
 * 事故：群友引用别人的消息、正文里写了「撤销工具」，结果**别人那句**被撤了。
 * 我们的两道闸（比上游更严一层）：
 *   ① 正文必须整条就是一句「撤回」（动词只认 撤回/撤了；撤销/回收/删除/撤掉 不算）
 *   ② 被引那条必须是**本机自己发的**（反查不到也当不是本机）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, emitRaw, GROUP_ID, MEMBER_QQ, ADMIN_QQ } from './helpers.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot(t, { quotedFrom = 'self', quotedExists = true } = {}) {
  const h = await bootKernel({
    config: {
      archive: { enabled: false, dir: 'logs/qq_chat' },
      pacing: { merge: { enabled: false } },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ },
      },
    },
  })
  t.after(() => { h.dispose?.() })
  h.recalled = []
  h.kernel.napcat.recall = async (id) => { h.recalled.push(Number(id)); return { ok: true } }
  h.kernel.napcat.msgById = async () => {
    if (!quotedExists) return null
    const uid = quotedFrom === 'self' ? h.kernel.napcat.selfId : 39999
    return { message_id: 777, sender: { user_id: uid }, message: [{ type: 'text', data: { text: '原话' } }] }
  }
  return h
}

let seq = 5000
function recallEvent(text, quotedId = '777') {
  seq += 1
  return {
    post_type: 'message', message_type: 'group', group_id: GROUP_ID,
    user_id: MEMBER_QQ, message_id: seq,
    sender: { user_id: MEMBER_QQ, nickname: '群友' },
    message: [
      { type: 'reply', data: { id: String(quotedId) } },
      { type: 'text', data: { text } },
    ],
  }
}

test('被引的是本机消息 + 正文「撤回」→ 撤掉，且同一条只试一次', async (t) => {
  const h = await boot(t, { quotedFrom: 'self' })
  await emitRaw(h.kernel, recallEvent('撤回'))
  await sleep(300)
  assert.deepEqual(h.recalled, [777], '应撤掉一次')
  await emitRaw(h.kernel, recallEvent('撤回'))
  await sleep(300)
  assert.deepEqual(h.recalled, [777], '同一条只试一次')
})

test('被引的是**别人**的消息 → 绝不撤（这是 11-09 线上事故）', async (t) => {
  const h = await boot(t, { quotedFrom: 'other' })
  await emitRaw(h.kernel, recallEvent('撤回'))
  await sleep(400)
  assert.deepEqual(h.recalled, [], '不许撤别人的消息')
})

test('反查不到被引消息（超时/已删）→ 当不是本机，不撤', async (t) => {
  const h = await boot(t, { quotedExists: false })
  await emitRaw(h.kernel, recallEvent('撤回'))
  await sleep(400)
  assert.deepEqual(h.recalled, [], '反查不到就不撤')
})

test('正文不是"整条撤回指令"（如「撤销工具」）→ 不撤，走正常对话', async (t) => {
  const h = await boot(t, { quotedFrom: 'self' })
  for (const tx of ['撤销工具', '撤销', '回收', '删除这条', '撤回功能不好用']) {
    await emitRaw(h.kernel, recallEvent(tx))
  }
  await sleep(500)
  assert.deepEqual(h.recalled, [], '这些都不该触发撤回')
})
