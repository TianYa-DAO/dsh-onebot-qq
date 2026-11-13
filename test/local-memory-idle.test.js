/**
 * test/local-memory-idle.test.js — 会话级沉淀（群安静 N 分钟后立刻提炼）+ 记忆摘要视图。
 *
 * 背景：原来是固定 8 小时一轮，中间那段聊天的细节最容易漏。
 *       借 OpenViking 的 autoCommit 思路：聊完（安静下来）就收一次。
 * 为什么必须等安静：聊天中途提炼，模型看到的是半截对话，写进记忆就是错的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin from '../plugins/group-memory/index.js'

const GROUP = '1122334455'
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

function makeBot({ dataDir, archiveDir, cfg = {}, runner }) {
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
    dsh: runner ? { runIsolatedTask: runner } : {},
    on(stage, fn) { stages.push([stage, fn]) },
    registerTool(name, def) { tools.set(name, def) },
    currentTurn: () => ({ chatKey: `group:${GROUP}`, target: `group:${GROUP}` }),
  }
  return { bot, shared, tools, stages }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-idle-'))
const msg = (ts, qq, nick, text) => ({ ts, dir: 'in', chat: `group:${GROUP}`, sender: { qq, nickname: nick }, text, messageId: ts })

function writeArchive(archiveDir, rows, gid = GROUP) {
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.writeFileSync(path.join(archiveDir, `group_${gid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

test('群安静够久 + 有新消息 → 立刻触发一次沉淀', async (t) => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const now = Date.now()
  writeArchive(archiveDir, Array.from({ length: 30 }, (_, i) =>
    msg(now - 20 * 60000 + i * 1000, 10001 + i, `群友${i}`, `第 ${i} 条消息`)))
  let modelCalls = 0
  const runner = async () => { modelCalls++; return { text: '## 唤醒\n- 测试' } }
  const { bot, shared } = makeBot({
    dataDir, archiveDir, runner,
    cfg: { accumulateIntervalHours: 24, accumulateIdleMin: 5, accumulateMinNewMsgs: 1 },
  })
  await plugin.setup(bot)
  t.after(() => { try { shared.memoryAccumulateStop?.() } catch {} })

  const p = shared.memoryAccumulateTickIdle()
  assert.ok(p, '应该返回一个进行中的 Promise（说明触发了沉淀）')
  await p.promise
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(modelCalls > 0, '闲置够久就该调一次模型去提炼')
})

test('群还在聊（最后一条刚发）→ 不触发，避免提炼半截对话', async (t) => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const now = Date.now()
  writeArchive(archiveDir, Array.from({ length: 30 }, (_, i) =>
    msg(now - 5000 + i * 100, 10001 + i, `群友${i}`, `第 ${i} 条消息`))) // 5 秒前刚说完
  let modelCalls = 0
  const runner = async () => { modelCalls++; return { text: '## 唤醒\n- 测试' } }
  const { bot, shared } = makeBot({
    dataDir, archiveDir, runner,
    cfg: { accumulateIntervalHours: 24, accumulateIdleMin: 30, accumulateMinNewMsgs: 1 },
  })
  await plugin.setup(bot)
  t.after(() => { try { shared.memoryAccumulateStop?.() } catch {} })

  const r = shared.memoryAccumulateTickIdle()
  assert.equal(r, null, '还在聊就不该触发')
  assert.equal(modelCalls, 0, '不该调用模型')
})

test('accumulateIdleMin = 0 → 关闭会话级沉淀，退回只按固定间隔', async (t) => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const now = Date.now()
  writeArchive(archiveDir, Array.from({ length: 30 }, (_, i) =>
    msg(now - 60 * 60000 + i * 1000, 10001 + i, `群友${i}`, `第 ${i} 条消息`)))
  const { bot, shared } = makeBot({
    dataDir, archiveDir,
    runner: async () => ({ text: '' }),
    cfg: { accumulateIntervalHours: 24, accumulateIdleMin: 0, accumulateMinNewMsgs: 1 },
  })
  await plugin.setup(bot)
  t.after(() => { try { shared.memoryAccumulateStop?.() } catch {} })
  assert.equal(shared.memoryAccumulateTickIdle(), null, '关掉时不该触发')
  assert.equal(shared.memoryAccumulateStatus().idleMinutes, 0, 'status 要反映关闭状态')
})

test('read_memory 默认给摘要视图，detail:true 才给全文', async (t) => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const memDir = path.join(dataDir, 'qq-memory')
  fs.mkdirSync(memDir, { recursive: true })
  const full = [
    '# 群 1122334455 · 对话记忆',
    '> 最后更新：2026-11-11',
    '## 唤醒与对话风格',
    '- 靠 @全体 点名，晚上常开黑。',
    '## 群里的人',
    '- **天天(10002)**：喜欢深空当铺，晚上要讨论服务器。',
    '- **小默(305542342)**：还在等 MC 正版号。',
  ].join('\n')
  fs.writeFileSync(path.join(memDir, `${GROUP}.md`), full)
  writeArchive(archiveDir, [msg(Date.now(), 1, '甲', '你好')])

  const { bot, tools } = makeBot({ dataDir, archiveDir, cfg: { enabled: true, dir: memDir } })
  await plugin.setup(bot)
  const tool = tools.get('read_memory')
  assert.ok(tool, '应注册 read_memory')

  // 摘要模式：只要"记过什么"的轮廓
  const sum = await tool.execute({ target: `group:${GROUP}` })
  assert.equal(sum.mode, 'summary')
  assert.ok(sum.chars < full.length, '摘要必须比全文短')
  assert.ok(sum.memory.includes('群里的人'), '摘要要保留小节标题')
  assert.ok(!sum.memory.includes('MC 正版号'), '摘要里不该有细节正文')

  // 全文模式
  const det = await tool.execute({ target: `group:${GROUP}`, detail: true })
  assert.equal(det.mode, 'full')
  assert.ok(det.memory.includes('MC 正版号'), 'detail:true 要能看到细节')
})

// ─────────────────────────────────────────────────────────────
// 空转防护（2026-11-11 主人提的问题）：
//   主动接话 → 群安静 30 分钟 → 沉淀记忆 → 又主动接话 → 又沉淀 …
//   如果"她自己说的话"也算新消息，这个循环永远停不下来，而且记忆会被灌成她的自言自语。
// ─────────────────────────────────────────────────────────────
test('群里只有她自己在自言自语 → 不触发沉淀（防空转）', async (t) => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const now = Date.now()
  // 全是 out（她自己发的），而且已经过了很久
  const rows = Array.from({ length: 6 }, (_, i) =>
    ({ ts: now - 60 * 60000 + i * 1000, dir: 'out', chat: `group:${GROUP}`,
       sender: { qq: 843640570, nickname: '绘梨衣' }, text: `我自己说的第${i}句`, messageId: now + i }))
  writeArchive(archiveDir, rows)
  let modelCalls = 0
  const { bot, shared } = makeBot({
    dataDir, archiveDir,
    runner: async () => { modelCalls++; return { text: '## 唤醒\n- 不该写' } },
    cfg: { accumulateIntervalHours: 24, accumulateIdleMin: 5, accumulateIdleMinMsgs: 3, accumulateMinNewMsgs: 1 },
  })
  await plugin.setup(bot)
  t.after(() => { try { shared.memoryAccumulateStop?.() } catch {} })

  const r = shared.memoryAccumulateTickIdle()
  assert.equal(r, null, '只有她自己的话时不该触发沉淀')
  assert.equal(modelCalls, 0, '不该调模型')
})

test('有别人的消息 + 已静下来 → 触发沉淀；最后一条是她说的则不触发', async (t) => {
  const mk = async (tailOutbound) => {
    const dataDir = tmp()
    const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
    const now = Date.now()
    const base = [
      { ts: now - 40 * 60000, dir: 'in', chat: `group:${GROUP}`, sender: { qq: 10001, nickname: '甲' }, text: '今天打本吗', messageId: now + 1 },
      { ts: now - 39 * 60000, dir: 'in', chat: `group:${GROUP}`, sender: { qq: 10002, nickname: '乙' }, text: '我想打', messageId: now + 2 },
      { ts: now - 38 * 60000, dir: 'in', chat: `group:${GROUP}`, sender: { qq: 10001, nickname: '甲' }, text: '那就八点', messageId: now + 3 },
    ]
    if (tailOutbound) base.push({ ts: now - 30 * 60000, dir: 'out', chat: `group:${GROUP}`,
      sender: { qq: 843640570, nickname: '绘梨衣' }, text: '我也去', messageId: now + 4 })
    writeArchive(archiveDir, base)
    let modelCalls = 0
    const { bot, shared } = makeBot({
      dataDir, archiveDir,
      runner: async () => { modelCalls++; return { text: '## 唤醒\n- 八点打本' } },
      cfg: { accumulateIntervalHours: 24, accumulateIdleMin: 5, accumulateIdleMinMsgs: 3, accumulateMinNewMsgs: 1 },
    })
    await plugin.setup(bot)
    return { shared, calls: () => modelCalls, stop: () => { try { shared.memoryAccumulateStop?.() } catch {} } }
  }

  // ① 三条别人的话 + 静了 38 分钟 → 该收
  const a = await mk(false)
  t.after(a.stop)
  const ra = a.shared.memoryAccumulateTickIdle()
  assert.ok(ra, '别人的话够了、也静下来了，应该触发沉淀')
  await ra.promise
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(a.calls() > 0, '应该真的调模型去提炼')

  // ② 同样三条别人的话，但最后一句是她说的（她在自言自语）→ 不触发
  const b = await mk(true)
  t.after(b.stop)
  assert.equal(b.shared.memoryAccumulateTickIdle(), null, '她刚自说自话完，不该当成"聊完了"去沉淀')
  assert.equal(b.calls(), 0)
})
