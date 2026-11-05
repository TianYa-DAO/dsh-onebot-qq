/**
 * test/local-wakewords.test.js — 「绘梨衣自己调各群唤醒词」。
 *
 * 覆盖：偏好层纯函数 + 真唤醒行为（加了词能叫醒、删了词叫不醒）。
 * 她的偏好落在 $DSH_HOME/dsh-onebot-qq/state/wake-groups.json，测试用临时 DSH_HOME。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applyOverrides, validateWord, isTooGeneric, changesToday } from '../platform/wake-groups.js'
import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, groupAtEvent } from './helpers.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wake-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(() => {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function writeOverride(home, gid, rec) {
  const p = path.join(home, 'dsh-onebot-qq', 'state', 'wake-groups.json')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ [String(gid)]: rec }, null, 1))
}

test('applyOverrides：加词 / 删词 / 去重 / 小写', () => {
  assert.deepEqual(applyOverrides(['绘梨衣', '梨衣'], { add: ['阿梨'], remove: [] }), ['绘梨衣', '梨衣', '阿梨'])
  assert.deepEqual(applyOverrides(['绘梨衣', '梨衣'], { add: [], remove: ['梨衣'] }), ['绘梨衣'])
  assert.deepEqual(applyOverrides(['绘梨衣'], { add: ['绘梨衣'], remove: [] }), ['绘梨衣'], '重复不加')
  assert.deepEqual(applyOverrides(['绘梨衣'], { add: ['阿梨'], remove: ['阿梨'].map((x) => x) }), ['绘梨衣'], '删优先')
  assert.deepEqual(applyOverrides(['绘梨衣'], {}), ['绘梨衣'], '没有覆盖 = 原样')
})

test('validateWord / isTooGeneric：挡住会误唤醒和写坏文件的词', () => {
  assert.equal(validateWord('阿梨', []), null)
  assert.ok(validateWord('', []), '空词拒绝')
  assert.ok(validateWord('太长太长太长太长啦', []), '超长拒绝')
  assert.ok(validateWord('阿 梨', []), '空格拒绝')
  assert.ok(validateWord('阿/梨', []), '斜杠拒绝')
  assert.ok(validateWord('阿*', []), '正则符号拒绝')
  assert.ok(validateWord('阿梨', ['阿梨']), '已存在拒绝')
  assert.equal(isTooGeneric('在吗'), true)
  assert.equal(isTooGeneric('阿梨'), false)
})

test('changesToday：只数 24 小时内的变更', () => {
  const now = Date.now()
  const rec = { history: [{ at: now - 1000 }, { at: now - 90000000 }, { at: now }] }
  assert.equal(changesToday(rec, now), 2)
})

test('真唤醒：她加了「阿梨」→ 群里喊阿梨能被叫醒', async (t) => {
  const home = tmpHome(t)
  writeOverride(home, GROUP_ID, { add: ['阿梨'], remove: [], at: Date.now(), history: [] })
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } }, pluginConfig: { 'link-parser': { enabled: false } } },
  })
  t.after(() => h.dispose())
  h.ctx.setPromptHandler(async () => {})
  await emitRaw(h.kernel, groupAtEvent({ text: '阿梨今天怎么这么安静', messageId: 9501, at: false }))
  await waitFor(() => (h.ctx._prompts || []).length > 0, { label: '被「阿梨」唤醒', timeout: 4000 })
})

test('真唤醒：她删了「梨衣」→ 只喊「梨衣」叫不醒', async (t) => {
  const home = tmpHome(t)
  writeOverride(home, GROUP_ID, { add: [], remove: ['梨衣', '绘梨衣'], at: Date.now(), history: [] })
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false } }, pluginConfig: { 'link-parser': { enabled: false } } },
  })
  t.after(() => h.dispose())
  h.ctx.setPromptHandler(async () => {})
  await emitRaw(h.kernel, groupAtEvent({ text: '梨衣今天怎么这么安静', messageId: 9502, at: false }))
  await sleep(700)
  assert.equal((h.ctx._prompts || []).length, 0, '删掉的词不该再唤醒她')
})
