/**
 * test/local-msg-sticker.test.js — send_message 的 sticker 参数（摘上游戏）。
 *
 * 行为：正文先发（工具返回值里带 message_id），随后顺手带一张表情。
 * 表情插件没启用时**不能影响正文**，只是如实说"参数被忽略"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootKernel, GROUP_ID } from './helpers.mjs'

test('send_message 带 sticker：正文发出 + 顺手一张表情', async (t) => {
  const h = await bootKernel({
    config: { pluginConfig: {
      pacing: { enabled: false },
      stickers: { enabled: true, dir: 'qq-stickers', collectGroupsOnly: true },
    } },
  })
  t.after(async () => { await h.dispose() })
  // 塞一张可用表情进库（1x2 px PNG 足够过魔数判定）
  const path = await import('node:path')
  const fs = await import('node:fs')
  const dir = path.join(h.dataDir, 'qq-stickers')
  fs.mkdirSync(dir, { recursive: true })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
  fs.writeFileSync(path.join(dir, '1-aaaa.png'), png)
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items: [
    { id: 1, hash: 'aaaa', file: '1-aaaa.png', tags: ['无语'], tagged: true, blocked: false },
  ], nextId: 2 }))

  const send = h.kernel.toolDefs.get('send_message')
  const before = h.sent.length
  const r = await send.execute({ target: `group:${GROUP_ID}`, text: '嗯', sticker: '无语' }, { agent: {} })
  assert.equal(r.ok, true, '正文应发出')
  assert.ok(r.sticker, '返回值里应带 sticker 结果')
  assert.equal(r.sticker.ok, true, `表情应发出：${JSON.stringify(r.sticker)}`)
  assert.equal(h.sent.length, before + 2, '正文一条 + 表情一条')
})

test('send_message 带 sticker：表情插件没启用时正文照发，不报错', async (t) => {
  const h = await bootKernel({ config: { pluginConfig: { stickers: { enabled: false } } } })
  t.after(async () => { await h.dispose() })
  const send = h.kernel.toolDefs.get('send_message')
  const r = await send.execute({ target: `group:${GROUP_ID}`, text: '嗯', sticker: '无语' }, { agent: {} })
  assert.equal(r.ok, true, '正文必须照发（不能因为表情没发就不回话）')
  assert.equal(r.sticker?.ok, false)
  assert.match(String(r.sticker?.reason || ''), /表情|未启用/)
})
