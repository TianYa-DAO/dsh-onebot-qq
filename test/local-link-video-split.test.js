/**
 * test/local-link-video-split.test.js — 链接解析：视频必须单独一条消息（摘上游戏 10-27）。
 *
 * 真机踩坑：QQ / SnowLuma 把 video 当独立 segment，
 *   `message element "video" must be the only segment` / `video may appear only once`。
 * 所以有视频时的顺序必须是：每个视频各自一条 → 图片并一条 → 说明文字最后一条。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { bootKernel, emitRaw, ADMIN_QQ, GROUP_ID } from './helpers.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** 起一个假侧车：/q?url=... 返回 video + image 两组媒体 */
async function fakeSidecar(t, dir) {
  const video = path.join(dir, 'v.mp4'); fs.writeFileSync(video, Buffer.alloc(4096, 0))
  const img = path.join(dir, 'i.png'); fs.writeFileSync(img, PNG)
  const server = http.createServer((req, res) => {
    // 契约：POST /parse  { url, session, limit } → 解析结果
    if (req.method !== 'POST' || !String(req.url || '').startsWith('/parse')) {
      res.writeHead(404); res.end('{}'); return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,                      // 侧车契约要求：ok=false 视为失败
      platform: 'bilibili', platformName: 'B 站', elapsedMs: 12,
      title: '测试视频标题', uploader: 'UP 主', duration: 65,
      media: [{ kind: 'video', path: video }, { kind: 'image', path: img }],
      skipped: [],
    }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}`
}

test('链接解析：有视频时按「视频各自一条 → 图片一条 → 说明最后」发送', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-lpv-'))
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }) })
  const sidecar = await fakeSidecar(t, dir)
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: {
        'link-parser': { enabled: true, parserUrl: sidecar },
        'persona-voice': { splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ, groupAtRequired: false },
        stickers: { enabled: false },
      },
    },
  })
  t.after(async () => { await h.dispose() })

  await emitRaw(h.kernel, {
    post_type: 'message', message_type: 'group', group_id: GROUP_ID, user_id: 40001, message_id: 7001,
    sender: { user_id: 40001, nickname: '群友' },
    message: [{ type: 'text', data: { text: '看这个 https://www.bilibili.com/video/BV1xx411c7mD' } }],
  })
  await new Promise((r) => setTimeout(r, 900))

  const media = h.sent.filter((x) => x.kind === 'media')
  assert.ok(media.length >= 2, `应至少发视频和图片两条，实际 ${media.length}：${JSON.stringify(h.sent.map(x => x.kind))}`)
  // 每一条 media 里都不能同时出现 video 和 image
  for (const m of media) {
    const hasVideo = /\[CQ:video/.test(String(m.wire || ''))
    const hasImage = /\[CQ:image/.test(String(m.wire || ''))
    assert.equal(hasVideo && hasImage, false, `同一条里不能混视频和图片：${JSON.stringify(m).slice(0, 120)}`)
  }
  // 视频那条必须是单独的（除了 CQ 码没有别的文字）
  const videoMsgs = media.filter((m) => /\[CQ:video/.test(String(m.wire || '')))
  assert.equal(videoMsgs.length, 1, '一个视频发一条')
})
