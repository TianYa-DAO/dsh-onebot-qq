/**
 * test/local-private-memory.test.js — 私聊长期记忆 + 每会话单独开关（摘自上游戏 2026-11-06）。
 *
 * 要点：
 *   · 私聊也有自己的一篇记忆，存在 `<记忆目录>/private/<QQ>.md`（与群记忆分目录，防撞号）
 *   · read_memory 支持 private:<QQ>，且只能读**本轮会话**那一篇
 *   · mutedChats 里的会话：不注入指针、不读、不积累（已有文件仍可直接读盘）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin from '../plugins/group-memory/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'priv-mem-'))
const PRIV_QQ = '305542342'
const GROUP = '1122334455'

function makeBot({ dataDir, archiveDir, cfg = {}, turnChatKey = null }) {
  const shared = Object.create(null)
  const tools = new Map()
  const stages = []
  const bot = {
    id: 'group-memory',
    cfg: { dir: path.join(dataDir, 'qq-memory'), enabled: true, accumulateSchedule: 'interval', ...cfg },
    log: quiet,
    core: { dataDir, archive: { dir: archiveDir } },
    state: { get: () => undefined },
    shared,
    dsh: {},
    on(stage, fn) { stages.push([stage, fn]) },
    registerTool(name, def) { tools.set(name, def) },
    currentTurn: () => (turnChatKey ? { chatKey: turnChatKey } : null),
  }
  return { bot, shared, tools, stages }
}

function writeMem(dataDir, rel, text) {
  const f = path.join(dataDir, 'qq-memory', rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, text)
  return f
}

test('私聊记忆存在 private/ 子目录，read_memory 能读（target=private:QQ）', async (t) => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const key = `private:${PRIV_QQ}`
  writeMem(dataDir, path.join('private', `${PRIV_QQ}.md`),
    '# 私聊 · 305542342\n> 最后更新：2026-11-12\n## 这个人的近况\n- **小默(305542342)**：在等 MC 正版号。\n')
  const { bot, tools } = makeBot({ dataDir, archiveDir, turnChatKey: key })
  await plugin.setup(bot)
  const tool = tools.get('read_memory')
  const r = await tool.execute({ target: key, detail: true })
  assert.equal(r.ok, true)
  assert.ok(String(r.memory).includes('MC 正版号'), '应读到私聊记忆正文')
})

test('read_memory 不能读别的会话（本轮是私聊，就不能读群记忆）', async (t) => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  writeMem(dataDir, `${GROUP}.md`, '# 群记忆\n## 群里的人\n- 某某\n')
  const { bot, tools } = makeBot({ dataDir, archiveDir, turnChatKey: `private:${PRIV_QQ}` })
  await plugin.setup(bot)
  let err = ''
  try { await tools.get('read_memory').execute({ target: `group:${GROUP}` }) } catch (e) { err = String(e?.message || e) }
  assert.ok(err.includes('只能读'), `应拒绝跨会话读取，实际：${err || '（没报错）'}`)
})

test('mutedChats 里的会话：read_memory 直接拒绝', async (t) => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const key = `private:${PRIV_QQ}`
  writeMem(dataDir, path.join('private', `${PRIV_QQ}.md`), '# 私聊\n## 近况\n- x\n')
  const { bot, tools } = makeBot({ dataDir, archiveDir, cfg: { mutedChats: [key] }, turnChatKey: key })
  await plugin.setup(bot)
  let err = ''
  try { await tools.get('read_memory').execute({ target: key }) } catch (e) { err = String(e?.message || e) }
  assert.ok(err.includes('关掉'), `静音的会话应拒绝读取，实际：${err || '（没报错）'}`)
})

test('mutedChats 里的会话：before-turn 不推指针', async (t) => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const key = `group:${GROUP}`
  writeMem(dataDir, `${GROUP}.md`, '# 群记忆\n## 群里的人\n- 某某\n')
  const { bot, stages } = makeBot({ dataDir, archiveDir, cfg: { mutedChats: [key] }, turnChatKey: key })
  await plugin.setup(bot)
  const before = stages.find(([stage]) => stage === 'before-turn')
  assert.ok(before, '应注册 before-turn')
  const ev = { wake: { kind: 'at' }, isGroup: true, groupId: GROUP, chatKey: key, hint: [], sender: { qq: 10002 } }
  await before[1](ev)
  assert.deepEqual(ev.hint, [], '静音的会话不该收到记忆指针')
})
