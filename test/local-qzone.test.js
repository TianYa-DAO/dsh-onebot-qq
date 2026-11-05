/**
 * test/local-qzone.test.js — QQ空间子插件（本地补丁）。
 *
 * 只测**读**和**权限**：自动化测试绝不真发说说（会出现在主人的空间里）。
 * qzd 没起时自动跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, groupAtEvent, privateEvent } from './helpers.mjs'

const QZD = process.env.QZ_ENDPOINT || 'http://127.0.0.1:18083'

async function up() {
  try {
    const r = await fetch(`${QZD}/api/qz/health`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch { return false }
}

async function toolOf(h, name) {
  return h.kernel.toolDefs.get(name)
}

test('空间工具已注册（看/发/删）', async (t) => {
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } }, pluginConfig: { 'link-parser': { enabled: false }, qzone: { enabled: true, endpoint: QZD } } },
  })
  t.after(() => h.dispose())
  const names = [...h.kernel.toolDefs.keys()]
  for (const n of ['qzone_list', 'qzone_post', 'qzone_delete', 'qzone_pending', 'qzone_approve', 'qzone_reject']) {
    assert.ok(names.includes(n), `应注册 ${n}（实际：${names.join(',')}）`)
  }
})

test('qzone_post 在群里被拒（说说公开可见，只认主人私聊）', async (t) => {
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } }, pluginConfig: { 'link-parser': { enabled: false }, qzone: { enabled: true, endpoint: QZD } } },
  })
  t.after(() => h.dispose())
  h.ctx.setPromptHandler(async () => {})
  await emitRaw(h.kernel, groupAtEvent({ text: '发个说说', messageId: 9301 }))
  await waitFor(() => (h.ctx._prompts || []).length > 0, { label: '模型被调用', timeout: 4000 })

  const def = await toolOf(h, 'qzone_post')
  let err = ''
  try {
    await def.execute({ content: '测试内容' })
  } catch (e) { err = String(e?.message || e) }
  assert.ok(err.includes('主人'), `群聊里应拒绝发说说，实际错误：${err || '（没报错！）'}`)
})

test('qzone_list 能读到说说（真连 qzd，只读）', async (t) => {
  if (!(await up())) { t.skip('qzd 未启动'); return }
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } }, pluginConfig: { 'link-parser': { enabled: false }, qzone: { enabled: true, endpoint: QZD } } },
  })
  t.after(() => h.dispose())
  const def = await toolOf(h, 'qzone_list')
  const r = await def.execute({ num: 3 })
  assert.equal(r.ok, true)
  assert.ok(typeof r.count === 'number', '应返回条数')
  assert.ok(Array.isArray(r.items), '应返回列表')
})

test('涉及别人的说说：批准/拒绝也只有主人私聊能做', async (t) => {
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } }, pluginConfig: { 'link-parser': { enabled: false }, qzone: { enabled: true, endpoint: QZD, masterQq: String(ADMIN_QQ) } } },
  })
  t.after(() => h.dispose())
  h.ctx.setPromptHandler(async () => {})
  await emitRaw(h.kernel, groupAtEvent({ text: '看看草稿', messageId: 9401 }))
  await waitFor(() => (h.ctx._prompts || []).length > 0, { label: '模型被调用', timeout: 4000 })

  for (const name of ['qzone_approve', 'qzone_reject']) {
    const def = h.kernel.toolDefs.get(name)
    let err = ''
    try { await def.execute({ id: 'd1793376999' }) } catch (e) { err = String(e?.message || e) }
    assert.ok(err.includes('主人'), `${name} 在群里应拒绝，实际：${err || '（没报错）'}`)
  }
})

test('主人私聊里：待批准列表可读；批准不存在的草稿会报错（不误发）', async (t) => {
  if (!(await up())) { t.skip('qzd 未启动'); return }
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } }, pluginConfig: { 'link-parser': { enabled: false }, qzone: { enabled: true, endpoint: QZD, masterQq: String(ADMIN_QQ) } } },
  })
  t.after(() => h.dispose())
  const pending = h.kernel.toolDefs.get('qzone_pending')
  const r = await pending.execute({})
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.items), '应返回待批准列表')

  // 让 currentTurn 指向主人私聊
  const sid = await h.kernel.dsh.ensureSession(`private:${ADMIN_QQ}`)
  const orig = h.kernel.currentTurn
  h.kernel.currentTurn = () => ({ chatKey: `private:${ADMIN_QQ}`, sessionId: sid })
  t.after(() => { h.kernel.currentTurn = orig })

  const approve = h.kernel.toolDefs.get('qzone_approve')
  let err = ''
  try { await approve.execute({ id: 'd1790000000' }) } catch (e) { err = String(e?.message || e) }
  assert.ok(err.length > 0, '不存在的草稿应报错，不能静默成功')
})
