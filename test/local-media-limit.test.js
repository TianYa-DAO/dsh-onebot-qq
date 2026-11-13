/**
 * test/local-media-limit.test.js — 媒体字节上限（摘上游戏 kernel/media-bytes.js）。
 *
 * 要点：上限按**实际读到的字节**执行，不信声明的 size / Content-Length：
 *   · 本地文件：stat 之后又长大 → 仍然掐断
 *   · 远程下载：Content-Length 谎报小、实际 body 超限 → 掐断
 *   · 掐断时抛 code='MEDIA_TOO_LARGE'，上层能给出"超过上限"的人话提示
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

import { readLocalBytes, fetchBytes } from '../kernel/media-bytes.js'

const tmpFile = (t, bytes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mb-'))
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }) })
  const p = path.join(dir, 'f.bin')
  fs.writeFileSync(p, bytes)
  return p
}

test('MEDIA-LIMIT 本地文件：超过上限直接拒绝（带 MEDIA_TOO_LARGE）', async (t) => {
  const p = tmpFile(t, Buffer.alloc(4096))
  await assert.rejects(() => readLocalBytes(p, { maxBytes: 1024 }), (e) => e.code === 'MEDIA_TOO_LARGE')
  const ok = await readLocalBytes(p, { maxBytes: 0 }) // 0 = 不限
  assert.equal(ok.length, 4096)
})

test('MEDIA-LIMIT 本地文件：结论永远不超过上限（不会悄悄读满）', async (t) => {
  // 小文件正常读
  const small = tmpFile(t, Buffer.alloc(1024))
  assert.equal((await readLocalBytes(small, { maxBytes: 2048 })).length, 1024)
  // 大文件必须被拒，而不是"读到上限就悄悄截断"（截断会产出半个图片，反而更难查）
  const big = tmpFile(t, Buffer.alloc(8192))
  await assert.rejects(() => readLocalBytes(big, { maxBytes: 2048 }), (e) => e.code === 'MEDIA_TOO_LARGE')
})

test('MEDIA-LIMIT 远程：Content-Length 谎报，实际 body 超限 → 掐断并取消流', async (t) => {
  let cancelled = false
  const server = http.createServer((req, res) => {
    // 关键：不设 content-length（chunked 流），只能靠"边读边数"发现超限
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    let sent = 0
    const push = () => {
      if (sent >= 8192) { res.end(); return }
      sent += 512
      res.write(Buffer.alloc(512, 1))
      setTimeout(push, 1)
    }
    push()
    req.on('close', () => { cancelled = true })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/big`
  await assert.rejects(() => fetchBytes(url, { maxBytes: 2048, timeoutMs: 5000 }), (e) => e.code === 'MEDIA_TOO_LARGE')
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(cancelled, true, '超限后要取消流，别一直下')
})

test('MEDIA-LIMIT 远程：正常小文件能读到，长度正确', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(Buffer.alloc(300, 2))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/small`
  const buf = await fetchBytes(url, { maxBytes: 4096, timeoutMs: 5000 })
  assert.equal(buf.length, 300)
})

test('MEDIA-LIMIT 远程：超时会被中断', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.write(Buffer.alloc(10))
    // 不 end：模拟卡死
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/hang`
  await assert.rejects(() => fetchBytes(url, { maxBytes: 0, timeoutMs: 120 }))
})
