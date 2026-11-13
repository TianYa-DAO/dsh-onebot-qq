/**
 * test/local-qzone-selfpost.test.js — 「空间变成她自己的能力」后的发帖权限与额度。
 *
 * 改动（2026-11-11）：
 *   · 以前：只有主人私聊回合能发（群里一律拒）。
 *   · 现在：她自己想发就能发（任何会话），但必须过**共享额度**（每天上限 / 最小间隔），
 *     额度就是 qzd 配置里那两个值，白天对话里发完晚上就不会再发一条。
 *
 * ⚠️ 本测试全程用**本地 mock 服务**，绝不连真 qzd —— 测试永远不许真的发一条到她空间。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, groupAtEvent } from './helpers.mjs'

/** 起一个假 qzd：可配置已有说说、可记录发布。 */
async function mockQzd({ posts = [], cfg = {} } = {}) {
  const state = {
    posts: [...posts],
    cfg: { autoPost: false, minGapHours: 18, maxPerDay: 1, whoCanSee: 1, ...cfg },
    published: [],
    pending: [],
  }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const send = (o, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    if (u.pathname === '/api/qz/health') return send({ ok: true })
    if (u.pathname === '/api/qz/config') {
      if (req.method === 'POST') {
        let b = ''
        req.on('data', (c) => { b += c })
        req.on('end', () => { Object.assign(state.cfg, JSON.parse(b || '{}')); send({ ok: true, config: state.cfg }) })
        return
      }
      return send({ ok: true, config: state.cfg })
    }
    if (u.pathname === '/api/qz/feeds') {
      const num = Number(u.searchParams.get('num') || 20)
      return send({ ok: true, count: state.posts.length, items: state.posts.slice(-num).reverse() })
    }
    if (u.pathname === '/api/qz/pending') return send({ ok: true, items: state.pending })
    if (u.pathname === '/api/qz/publish' && req.method === 'POST') {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        const body = JSON.parse(b || '{}')
        const tid = `mock-${state.published.length + 1}`
        state.published.push({ ...body, tid })
        state.posts.push({ tid, content: body.content, created_at: Math.floor(Date.now() / 1000), pics: [] })
        send({ ok: true, tid })
      })
      return
    }
    send({ ok: false, error: 'not found' }, 404)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, state, close: () => new Promise((r) => server.close(r)) }
}

const nowSec = () => Math.floor(Date.now() / 1000)

async function kernelWith(key, qzd, extra = {}) {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: { 'link-parser': { enabled: false }, ...extra,
        qzone: { enabled: true, endpoint: qzd.url, masterQq: String(ADMIN_QQ), ...(extra.qzone || {}) } },
    },
  })
  return h
}

/** 让本轮是群聊（非主人）回合。 */
async function wakeInGroup(h, mid = 9500) {
  h.ctx.setPromptHandler(async () => {})
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: mid }))
  await waitFor(() => (h.ctx._prompts || []).length > 0, 4000)
}

test('她自己在群里想发 → 允许（额度够时真发出去）', async (t) => {
  const qzd = await mockQzd({ posts: [] })
  t.after(() => qzd.close())
  const h = await kernelWith('a', qzd)
  t.after(() => h.dispose())
  await wakeInGroup(h, 9501)

  const def = h.kernel.toolDefs.get('qzone_post')
  const r = await def.execute({ content: '今晚安静下来的时候，想起点事' })
  assert.equal(r.ok, true)
  assert.equal(qzd.state.published.length, 1, '应该真的发了一条（到 mock）')
  assert.equal(qzd.state.published[0].content, '今晚安静下来的时候，想起点事')
})

test('今天已经发满 → 拒绝，并告诉她下次', async (t) => {
  const qzd = await mockQzd({ posts: [{ tid: 'x1', content: '今天早先那条', created_at: nowSec() - 600 }] })
  t.after(() => qzd.close())
  const h = await kernelWith('b', qzd)
  t.after(() => h.dispose())
  await wakeInGroup(h, 9502)

  const def = h.kernel.toolDefs.get('qzone_post')
  let err = ''
  try { await def.execute({ content: '再发一条' }) } catch (e) { err = String(e?.message || e) }
  assert.ok(err.includes('今天已经发过'), `应因当日上限拒绝，实际：${err || '（没报错！）'}`)
  assert.equal(qzd.state.published.length, 0, '被拒时不能真的发出去')
})

test('离上一条太近（间隔不够）→ 拒绝', async (t) => {
  // 日上限调成 3：否则"2 小时前那条也算今天"，会先被日上限拦住，测不到间隔规则
  const qzd = await mockQzd({ posts: [{ tid: 'x2', content: '2 小时前那条', created_at: nowSec() - 2 * 3600 }], cfg: { maxPerDay: 3 } })
  t.after(() => qzd.close())
  const h = await kernelWith('c', qzd)
  t.after(() => h.dispose())
  await wakeInGroup(h, 9503)

  const def = h.kernel.toolDefs.get('qzone_post')
  let err = ''
  try { await def.execute({ content: '隔太近了' }) } catch (e) { err = String(e?.message || e) }
  assert.ok(err.includes('小时'), `应因间隔不够拒绝，实际：${err || '（没报错！）'}`)
  assert.equal(qzd.state.published.length, 0)
})

test('关掉「允许她主动发」→ 群里退回拒绝（兜底开关有效）', async (t) => {
  const qzd = await mockQzd({ posts: [] })
  t.after(() => qzd.close())
  const h = await kernelWith('d', qzd, { qzone: { allowSelfPost: false } })
  t.after(() => h.dispose())
  await wakeInGroup(h, 9504)

  const def = h.kernel.toolDefs.get('qzone_post')
  let err = ''
  try { await def.execute({ content: '不该发出去' }) } catch (e) { err = String(e?.message || e) }
  assert.ok(err.includes('主人'), `关掉开关后应拒绝，实际：${err || '（没报错！）'}`)
  assert.equal(qzd.state.published.length, 0)
})

test('主人私聊里发 → 不受额度限制（他明确要求的）', async (t) => {
  // 今天已经发过一条（额度用尽），但主人明确要求 → 仍然要能发
  const qzd = await mockQzd({ posts: [{ tid: 'x3', content: '今天发过了', created_at: nowSec() - 300 }] })
  t.after(() => qzd.close())
  const h = await kernelWith('e', qzd)
  t.after(() => h.dispose())

  // ⚠️ currentTurn 靠 AsyncLocalStorage 认线，测试里直接改 kernel.currentTurn 是无效的
  //    （那个引用不会被插件看到）。所以走**真实私聊回合**：在 prompt handler 里调工具。
  let result = null
  let errMsg = ''
  h.ctx.setPromptHandler(async () => {
    try {
      result = await h.kernel.toolDefs.get('qzone_post').execute({ content: '主人让发的' })
    } catch (e) { errMsg = String(e?.message || e) }
    return ''
  })
  const { privateEvent } = await import('./helpers.mjs')
  await emitRaw(h.kernel, privateEvent({ userId: ADMIN_QQ, text: '发条说说', messageId: 9601 }))
  await waitFor(() => result !== null || errMsg, 6000, '私聊回合里应该调过工具')

  assert.equal(errMsg, '', `主人私聊里不该被额度挡住，实际报错：${errMsg}`)
  assert.equal(result?.ok, true)
  assert.equal(qzd.state.published.length, 1, '主人明确要求时额度不该挡')
})
