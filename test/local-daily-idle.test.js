/**
 * test/local-daily-idle.test.js — 每日模式下的「会话级沉淀（闲置触发）」（2026-11-12）
 *
 * 主人问的正是这个设定：单个会话长时间没动静 → 立刻把它沉淀进记忆，不用等每日 04:00。
 *   · 设定：group-memory.accumulateIdleMin（安静多少分钟，默认 30）
 *           group-memory.accumulateIdleMinMsgs（至少几条别人的消息，默认 3）
 *   · 纪律：最后一条是她说的 → 先不收（可能还在聊）；同一会话 10 分钟内不重复；
 *           只处理点名的会话（不动轮转游标）；0 = 关闭
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDailyAccumulator } from '../plugins/group-memory/daily.js'

const GROUP = '1122334455'
// ⚠️ daily 的 baselineAt = 构造时刻，**早于它的行会被直接过滤**。
// 所以：ROW_BASE 取"构造之后一分钟"，NOW（检查时刻）再往后一小时 → 既在基线内、又已经安静够久。
const NOW = Date.now() + 90 * 60000
const ROW_BASE = Date.now() + 60000

function setup(t, cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-idle-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const archive = path.join(dir, 'archive')
  const memory = path.join(dir, 'memory')
  fs.mkdirSync(archive, { recursive: true })
  const calls = []
  let acc
  acc = createDailyAccumulator({
    bot: {
      core: { archive: { dir: archive } },
      dsh: { runIsolatedTask: async (req) => { calls.push(req.prompt); acc.submit({ target: `group:${GROUP}`, operations: '[]', batchId: /batchId="([^"]+)"/.exec(req.prompt)[1] }) } },
    },
    cfg,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dataDirOf: () => dir,
    memoryDirOf: () => memory,
    invalidateMemoryOf() {},
  })
  // 不调 stop()：createDailyAccumulator 自己不会启动定时器，stop 会让 tickIdle 直接返回
  const write = (rows) => {
    fs.writeFileSync(path.join(archive, `group_${GROUP}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  return { acc, write, calls, dir, archive }
}

/** 造 n 轮"人说话 + 她回"的互动，最后一条是谁说的可控 */
function convo(n, { lastIsBot = false, baseTs = ROW_BASE } = {}) {
  const rows = []
  for (let i = 0; i < n; i += 1) {
    const ts = baseTs + i * 120000
    rows.push({ ts, dir: 'in', messageId: 1000 + i, text: `第${i}句`, sender: { qq: 30001, name: '群友' } })
    rows.push({ ts: ts + 1000, dir: 'out', messageId: -1000 - i, text: '嗯', triggerMsgId: 1000 + i })
  }
  if (!lastIsBot) rows.push({ ts: baseTs + n * 120000, dir: 'in', messageId: 9000, text: '最后一句', sender: { qq: 30001, name: '群友' } })
  return rows
}

test('安静够久 + 有新互动 → 只沉淀这个会话（一次模型调用）', async (t) => {
  const h = setup(t, { accumulateIdleMin: 30, accumulateIdleMinMsgs: 3 })
  h.write(convo(3, { baseTs: ROW_BASE }))            // 半小时前聊完 → 安静够了
  const r = h.acc.tickIdle(NOW)
  assert.equal(r.started, true, '应该触发沉淀')
  assert.deepEqual(r.keys, [GROUP], '只处理这个会话')
  await new Promise((res) => setTimeout(res, 50))
  assert.equal(h.calls.length, 1, '只对它调一次模型（不是整轮全扫）')
})

test('才安静了 5 分钟 → 不沉淀（避免提炼半截对话）', (t) => {
  const h = setup(t, { accumulateIdleMin: 30, accumulateIdleMinMsgs: 3 })
  h.write(convo(3, { baseTs: NOW - 6 * 60000 }))
  const r = h.acc.tickIdle(NOW)
  assert.equal(r.started, false)
})

test('最后一条是她自己说的 → 先不收（可能还在聊）', (t) => {
  const h = setup(t, { accumulateIdleMin: 30, accumulateIdleMinMsgs: 3 })
  h.write(convo(3, { lastIsBot: true, baseTs: ROW_BASE }))
  assert.equal(h.acc.tickIdle(NOW).started, false)
})

test('新互动太少（不够 minMsgs）→ 不值得调模型', (t) => {
  const h = setup(t, { accumulateIdleMin: 30, accumulateIdleMinMsgs: 10 })
  h.write(convo(2, { baseTs: ROW_BASE }))
  assert.equal(h.acc.tickIdle(NOW).started, false)
})

test('accumulateIdleMin = 0 → 关闭闲置沉淀', (t) => {
  const h = setup(t, { accumulateIdleMin: 0 })
  h.write(convo(5, { baseTs: ROW_BASE }))
  assert.equal(h.acc.tickIdle(NOW).started, false)
})

test('同一会话 10 分钟内不重复沉淀', async (t) => {
  const h = setup(t, { accumulateIdleMin: 30, accumulateIdleMinMsgs: 3 })
  h.write(convo(3, { baseTs: ROW_BASE }))
  assert.equal(h.acc.tickIdle(NOW).started, true)
  await new Promise((res) => setTimeout(res, 80))
  assert.equal(h.acc.tickIdle(NOW + 60000).started, false, '冷却期内不该重复跑')
})

test('闲置沉淀不动轮转游标（不会打乱每日那轮的公平分批）', async (t) => {
  const h = setup(t, { accumulateIdleMin: 30, accumulateIdleMinMsgs: 3 })
  h.write(convo(3, { baseTs: NOW - 60 * 60000 }))
  h.acc.tickIdle(NOW)
  await new Promise((res) => setTimeout(res, 80))
  const st = JSON.parse(fs.readFileSync(path.join(h.dir, 'state', 'group-memory-daily.json'), 'utf8'))
  assert.ok(!st.cursor || st.cursor === undefined, `闲置触发不该写游标（实际 ${st.cursor}）`)
})

// ── 私聊也走同一条链路（主人 2026-11-12 追问「私聊呢」）──────────────────
const PRIV_QQ = '10002'
function setupPrivate(t, cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-idle-priv-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const archive = path.join(dir, 'archive')
  const memory = path.join(dir, 'memory')
  fs.mkdirSync(archive, { recursive: true })
  const calls = []
  const acc = createDailyAccumulator({
    bot: {
      core: { archive: { dir: archive } },
      dsh: { runIsolatedTask: async (req) => {
        calls.push(req.prompt)
        const batchId = /batchId="([^"]+)"/.exec(req.prompt)[1]
        // 私聊的 target 是 private:<QQ>（不是 group:），提交时按提示里的会话键走
        const m = /仅属于 (private:\d+|group:\d+|\d+)/.exec(req.prompt)
        const target = m && m[1].startsWith('private:') ? m[1] : `private:${PRIV_QQ}`
        acc.submit({ target, operations: '[]', batchId })
      } },
    },
    cfg,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    dataDirOf: () => dir,
    memoryDirOf: () => memory,
    invalidateMemoryOf() {},
  })
  return { acc, calls, dir, memory, archive }
}

test('私聊：安静够久 + 有新互动 → 只沉淀这个私聊会话', async (t) => {
  const h = setupPrivate(t, { accumulateIdleMin: 30, accumulateIdleMinMsgs: 3 })
  const rows = []
  for (let i = 0; i < 3; i += 1) {
    const ts = ROW_BASE + i * 120000
    rows.push({ ts, dir: 'in', messageId: 5000 + i, text: `第${i}句`, sender: { qq: PRIV_QQ, name: '主人' } })
    rows.push({ ts: ts + 900, dir: 'out', messageId: -5000 - i, text: '嗯嗯', triggerMsgId: 5000 + i })
  }
  rows.push({ ts: ROW_BASE + 40 * 60000, dir: 'in', messageId: 6000, text: '那我先睡啦', sender: { qq: PRIV_QQ, name: '主人' } })
  fs.writeFileSync(path.join(h.archive, `private_${PRIV_QQ}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const r = h.acc.tickIdle(NOW)
  assert.equal(r.started, true, '私聊闲置也该触发沉淀')
  assert.deepEqual(r.keys, [`private:${PRIV_QQ}`], '应点为私聊会话键')
  await new Promise((res) => setTimeout(res, 80))
  assert.equal(h.calls.length, 1, '只调一次模型')
  assert.ok(h.calls[0].includes(`private:${PRIV_QQ}`), '提示词里应指明是哪个私聊会话')
})

test('私聊：最后一条是她自己说的 → 先不收', (t) => {
  const h = setupPrivate(t, { accumulateIdleMin: 30, accumulateIdleMinMsgs: 3 })
  const rows = []
  for (let i = 0; i < 3; i += 1) {
    const ts = ROW_BASE + i * 120000
    rows.push({ ts, dir: 'in', messageId: 7000 + i, text: `第${i}句`, sender: { qq: PRIV_QQ, name: '主人' } })
    rows.push({ ts: ts + 900, dir: 'out', messageId: -7000 - i, text: '嗯', triggerMsgId: 7000 + i })
  }
  fs.writeFileSync(path.join(h.archive, `private_${PRIV_QQ}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  assert.equal(h.acc.tickIdle(NOW).started, false, '她刚说完就先不收')
})

test('空会话（没有她的互动）跑过一次后 → 1 小时内不再重扫', async (t) => {
  const h = setup(t, { accumulateIdleMin: 30, accumulateIdleMinMsgs: 3 })
  // 只有别人说话、她从来没回过 → selectInteractions 为空 → round 会 skip
  const rows = []
  for (let i = 0; i < 5; i += 1) {
    rows.push({ ts: ROW_BASE + i * 1000, dir: 'in', messageId: 4000 + i, text: `第${i}句`, sender: { qq: 30001, name: '群友' } })
  }
  h.write(rows)
  const r1 = h.acc.tickIdle(ROW_BASE + 31 * 60000)     // 距最后一条 31 分钟，过了 idleMin
  assert.equal(r1.started, true, '第一次应该选中它')
  await new Promise((res) => setTimeout(res, 120))
  // ⚠️ emptyAt 写的是"真实当前时间"，所以重扫判定也要用接近真实的时间
  const t2 = Date.now() + 41 * 60000                    // 空会话跑的 41 分钟后（< 1 小时）
  assert.equal(h.acc.tickIdle(t2).started, false, '1 小时内不该重扫（没东西可收）')
  const t3 = Date.now() + 70 * 60000                    // 70 分钟后允许再看
  assert.equal(h.acc.tickIdle(t3).started, true, '过了重扫间隔应允许再看一次')
})
