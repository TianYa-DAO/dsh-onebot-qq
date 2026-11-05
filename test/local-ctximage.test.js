/**
 * test/local-ctximage.test.js — 群上文图片进模型（本地补丁）。
 *
 * 断两件事：
 *   ① 上文里有人发的图 → 真的作为 image part 送进模型（不再只是「[图片]」）
 *   ② 提示里说明「这些是上文图片」，避免模型当成刚发的新图
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, groupAtEvent } from './helpers.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 造一张 1x1 的真 PNG（sharp 能处理就行） */
function tinyPng() {
  const p = path.join(os.tmpdir(), `ctx-img-${process.pid}.png`)
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  fs.writeFileSync(p, Buffer.from(b64, 'base64'))
  return p
}

test('群上文的图片会作为图片送进模型，并在提示里标注来源', async (t) => {
  const img = tinyPng()
  t.after(() => { try { fs.unlinkSync(img) } catch { /* 忽略 */ } })

  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } }, pluginConfig: { 'link-parser': { enabled: false } } },
  })
  t.after(() => h.dispose())

  const now = Math.floor(Date.now() / 1000)
  h.kernel.napcat.groupHistory = async () => [
    { message_id: 501, time: now - 60, sender: { user_id: 30001, nickname: '拍图的群友' }, message: [
      { type: 'text', data: { text: '你看这个' } },
      { type: 'image', data: { file: img, url: '' } },
    ] },
    { message_id: 502, time: now - 30, sender: { user_id: 30002, nickname: '另一个' }, message: [
      { type: 'text', data: { text: '哈哈' } },
    ] },
  ]

  const prompts = []
  h.ctx.setPromptHandler(async (req) => { prompts.push(req) })

  await emitRaw(h.kernel, groupAtEvent({ text: '这张图什么意思', messageId: 503 }))
  await waitFor(() => prompts.length > 0, { label: '模型被调用', timeout: 5000 })
  await sleep(200)

  const req = prompts[0]
  const parts = Array.isArray(req.content) ? req.content : []
  const imgs = parts.filter((p) => p && (p.mediaType || p.type === 'image'))
  const text = parts.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')

  assert.ok(imgs.length >= 1, `上文图片应进模型，实际图片 part = ${imgs.length}`)
  assert.ok(text.includes('[上文图片]'), '提示里应标注这是上文图片')
  assert.ok(text.includes('拍图的群友'), '提示里应带上发图的人')
})

test('上文图片关闭后（groupContextImages=0）不再带图', async (t) => {
  const img = tinyPng()
  t.after(() => { try { fs.unlinkSync(img) } catch { /* 忽略 */ } })

  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      outbound: { groupContextImages: 0 },
      pluginConfig: { 'link-parser': { enabled: false } },
    },
  })
  t.after(() => h.dispose())

  const now = Math.floor(Date.now() / 1000)
  h.kernel.napcat.groupHistory = async () => [
    { message_id: 511, time: now - 60, sender: { user_id: 30001, nickname: '群友' }, message: [
      { type: 'image', data: { file: img, url: '' } },
    ] },
  ]
  const prompts = []
  h.ctx.setPromptHandler(async (req) => { prompts.push(req) })
  await emitRaw(h.kernel, groupAtEvent({ text: '随便说句话', messageId: 512 }))
  await waitFor(() => prompts.length > 0, { label: '模型被调用', timeout: 5000 })
  await sleep(150)

  const parts = Array.isArray(prompts[0].content) ? prompts[0].content : []
  assert.equal(parts.filter((p) => p && (p.mediaType || p.type === 'image')).length, 0, '关掉后不该带图')
})

test('额度分配：真图优先，表情包补位（上限 2 时留 1 真图 + 1 表情）', async (t) => {
  const img = tinyPng()
  t.after(() => { try { fs.unlinkSync(img) } catch { /* 忽略 */ } })

  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      outbound: { groupContextImages: 2 },
      pluginConfig: { 'link-parser': { enabled: false } },
    },
  })
  t.after(() => h.dispose())

  const now = Math.floor(Date.now() / 1000)
  const mk = (mid, sticker, sec) => ({
    message_id: mid, time: now - sec, sender: { user_id: 30000 + mid, nickname: `人${mid}` },
    message: [{ type: 'image', data: { file: img, url: '', sub_type: sticker ? 1 : 0, summary: sticker ? '[动画表情]' : '' } }],
  })
  h.kernel.napcat.groupHistory = async () => [
    mk(601, true, 40), mk(602, true, 30), mk(603, false, 20), mk(604, true, 10),
  ]
  const prompts = []
  h.ctx.setPromptHandler(async (req) => { prompts.push(req) })
  await emitRaw(h.kernel, groupAtEvent({ text: '这些表情啥意思', messageId: 605 }))
  await waitFor(() => prompts.length > 0, { label: '模型被调用', timeout: 5000 })
  await sleep(200)

  const parts = Array.isArray(prompts[0].content) ? prompts[0].content : []
  const nImg = parts.filter((p) => p && (p.mediaType || p.type === 'image')).length
  const text = parts.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
  assert.equal(nImg, 2, `上限 2 应正好 2 张（实际 ${nImg}）`)
  assert.ok(text.includes('表情包'), '提示里应说明其中有表情包')
})

test('关掉表情包图（groupContextStickers=false）只带真图', async (t) => {
  const img = tinyPng()
  t.after(() => { try { fs.unlinkSync(img) } catch { /* 忽略 */ } })

  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      outbound: { groupContextImages: 5, groupContextStickers: false },
      pluginConfig: { 'link-parser': { enabled: false } },
    },
  })
  t.after(() => h.dispose())

  const now = Math.floor(Date.now() / 1000)
  h.kernel.napcat.groupHistory = async () => [
    { message_id: 611, time: now - 30, sender: { user_id: 30001, nickname: '甲' }, message: [
      { type: 'image', data: { file: img, url: '', sub_type: 1, summary: '[动画表情]' } }] },
    { message_id: 612, time: now - 20, sender: { user_id: 30002, nickname: '乙' }, message: [
      { type: 'image', data: { file: img, url: '', sub_type: 0 } }] },
  ]
  const prompts = []
  h.ctx.setPromptHandler(async (req) => { prompts.push(req) })
  await emitRaw(h.kernel, groupAtEvent({ text: '刚才那张照片', messageId: 613 }))
  await waitFor(() => prompts.length > 0, { label: '模型被调用', timeout: 5000 })
  await sleep(150)
  const parts = Array.isArray(prompts[0].content) ? prompts[0].content : []
  assert.equal(parts.filter((p) => p && (p.mediaType || p.type === 'image')).length, 1, '只带那张真图')
})
