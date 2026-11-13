/**
 * test/local-forward-block.test.js — 合并转发内容必须进「正文块」，不能塞在 hint 末尾（2026-11-13）
 *
 * 事故：她收到主人转发的聊天记录后回"我一句都没收到"。
 * 根因：内容被塞进 ev.hint，和"只写正文收不到"这种系统提示混在一起排在 prompt 最末尾，
 *      模型当成元数据忽略了。现在改成紧跟正文的独立块，并明说"你能看到内容"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPromptText } from '../kernel/format.js'

const ev = () => ({
  chatKey: 'private:10002', isGroup: false, messageId: 123, text: '你刚刚服务器崩了一下，你看看',
  sender: { qq: 10002, name: '主人' }, hint: ['[提醒:只写正文收不到]'], wake: { kind: 'private' },
})

test('forwardBlock 出现在正文之后、hint 之前', () => {
  const e = ev()
  e._scratch = { forwardBlock: '[他用「合并转发」发来的聊天记录 · 3 条（原文见下，你能看到内容）]\n[a(QQ:1)]: 失眠\n[b(QQ:2)]: 想你了' }
  const p = buildPromptText(e, { greeted: true, forwardBlock: e._scratch.forwardBlock })
  const iText = p.indexOf('你刚刚服务器崩了一下')
  const iFwd = p.indexOf('合并转发」发来的聊天记录')
  const iHint = p.indexOf('[提醒:只写正文收不到]')
  assert.ok(iText >= 0 && iFwd > iText, '转发块应在正文之后')
  assert.ok(iHint > iFwd, '转发块应在 hint 之前（hint 在最末尾）')
  assert.ok(p.includes('失眠') && p.includes('想你了'), '三条内容都要在')
  assert.ok(p.includes('你能看到内容'), '要有明确提示，避免她说"没收到"')
})

test('没有 forwardBlock 时不引入多余段落', () => {
  const p = buildPromptText(ev(), { greeted: true })
  assert.ok(!p.includes('合并转发'), '不应凭空出现合并转发段')
})
