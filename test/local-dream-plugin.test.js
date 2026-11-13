/** test/local-dream-plugin.test.js — 梦境插件整链：写梦 → 落盘 → 巩固 → 工具/提示 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin from '../plugins/dream/index.js'

const NOW = Date.now()
const H = 3600000

function makeBot({ dataDir, archiveDir, cfg = {}, modelText, pacing = {} }) {
  const tools = new Map()
  const stages = []
  const shared = {}
  const interests = []
  const moods = []
  const bot = {
    id: 'dream',
    cfg: { enabled: true, affectInterests: true, affectMood: true, keepDays: 60, minFragments: 3, ...cfg },
    log: { info() {}, warn() {}, debug() {}, error() {} },
    core: { dataDir, archive: { dir: archiveDir } },
    dsh: { runIsolatedTask: async () => ({ ok: true, text: modelText ?? 'DREAM: 一片很亮的水。\nMETA: {"themes":["水"],"figures":[],"mood":0}' }) },
    pacing: {
      interestsView: () => ({ topics: [{ name: '瓦夜', score: 70 }], people: [{ name: '主人', qq: '10002' }] }),
      quietWindowFor: () => ({ startMin: 150, sleepMin: 480, endMin: 630, allNighter: false, enabled: true }),
      inQuietHours: () => true,
      awakeBecauseNightWake: () => 0,
      noteInterest: (a) => interests.push(a),
      setMood: (m) => moods.push(m),
      ...pacing,
    },
    state: { get: () => ({}) },
    shared,
    registerTool(name, def) { tools.set(name, def) },
    on(stage, fn) { stages.push([stage, fn]) },
  }
  return { bot, tools, stages, shared, interests, moods }
}

function seedArchive(archiveDir) {
  fs.mkdirSync(archiveDir, { recursive: true })
  const rows = []
  for (let i = 0; i < 6; i += 1) {
    rows.push({ ts: NOW - 2 * H + i * 60000, dir: 'in', text: `今天第${i}句`, sender: { qq: '10002', name: '主人' } })
    rows.push({ ts: NOW - 2 * H + i * 60000 + 1000, dir: 'out', text: '嗯' })
  }
  fs.writeFileSync(path.join(archiveDir, 'private_10002.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function boot(t, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-boot-'))
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  seedArchive(archiveDir)
  const h = makeBot({ dataDir, archiveDir, ...opts })
  plugin.setup(h.bot)
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  return { ...h, dataDir, archiveDir, dreams: path.join(dataDir, 'dreams', 'DREAMS.md'), state: path.join(dataDir, 'state', 'dream.json') }
}

test('强制跑一次 → 写出梦境日记 + 状态 + 工具注册', async (t) => {
  const h = boot(t)
  assert.equal(typeof h.tools.get('read_dreams')?.execute, 'function', '应注册 read_dreams')
  const r = await h.shared.dreamRun({ force: true })
  assert.equal(r.ok, true, `应成功：${JSON.stringify(r)}`)
  assert.ok(fs.existsSync(h.dreams), '梦境日记得落盘')
  const text = fs.readFileSync(h.dreams, 'utf8')
  assert.ok(text.includes('一片很亮的水'), '正文要进去')
  const st = JSON.parse(fs.readFileSync(h.state, 'utf8'))
  assert.ok(st.lastDreamDay, '要记下今天做过梦')
})

test('兴趣：梦里出现的人（真实聊过）会按 delta 调；没聊过的人不调', async (t) => {
  const modelText = `DREAM: 有人在门边等我。
META: {"themes":["门"],"figures":[{"qq":"10002","name":"主人","delta":4,"why":"他一直等着"},{"qq":"999999","name":"陌生人","delta":-3,"why":"没见过"}],"mood":1}`
  const h = boot(t, { modelText })
  const r = await h.shared.dreamRun({ force: true })
  assert.equal(r.ok, true)
  assert.equal(h.interests.length, 1, '只该调真实聊过的那个')
  assert.equal(h.interests[0].qq, '10002')
  assert.equal(h.interests[0].delta, 4)
  assert.ok(String(h.interests[0].why).includes('梦见'))
})

test('心情：沉的梦 → setMood(penalty=1)；亮的不调', async (t) => {
  const sad = boot(t, { modelText: 'DREAM: 一直在下雨。\nMETA: {"themes":["雨"],"figures":[],"mood":-2}' })
  await sad.shared.dreamRun({ force: true })
  assert.equal(sad.moods.length, 1)
  assert.equal(sad.moods[0].penalty, 1)

  const bright = boot(t, { modelText: 'DREAM: 天很蓝。\nMETA: {"themes":["天"],"figures":[],"mood":2}' })
  await bright.shared.dreamRun({ force: true })
  assert.equal(bright.moods.length, 0, '亮梦不降档')
})

test('开关：关掉 affectInterests/affectMood → 不产生任何影响，但梦照写', async (t) => {
  const modelText = 'DREAM: 有人来过。\nMETA: {"themes":["人"],"figures":[{"qq":"10002","name":"主人","delta":5,"why":"x"}],"mood":-2}'
  const h = boot(t, { cfg: { affectInterests: false, affectMood: false }, modelText })
  const r = await h.shared.dreamRun({ force: true })
  assert.equal(r.ok, true)
  assert.equal(h.interests.length, 0)
  assert.equal(h.moods.length, 0)
  assert.ok(fs.existsSync(h.dreams))
})

test('素材不足 → 不做梦（不调模型、不写文件）', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-few-'))
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.writeFileSync(path.join(archiveDir, 'group_123456.jsonl'), JSON.stringify({ ts: NOW - H, dir: 'in', text: '有人吗', sender: { qq: '1', name: 'x' } }) + '\n')
  const h = makeBot({ dataDir, archiveDir, cfg: { minFragments: 3 } })
  plugin.setup(h.bot)
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  let called = false
  h.bot.dsh.runIsolatedTask = async () => { called = true; return { ok: true, text: '' } }
  const r = await h.shared.dreamRun()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'too-few-fragments')
  assert.equal(called, false, '不该调模型')
  assert.equal(fs.existsSync(path.join(dataDir, 'dreams', 'DREAMS.md')), false)
})

test('同一天第二次 → already（幂等，不重复调模型）', async (t) => {
  const h = boot(t)
  await h.shared.dreamRun({ force: true })
  let called = 0
  h.bot.dsh.runIsolatedTask = async () => { called += 1; return { ok: true, text: 'DREAM: x\nMETA: {"themes":[],"figures":[],"mood":0}' } }
  const r = await h.shared.dreamRun()
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'already')
  assert.equal(called, 0)
})

test('before-turn：当天有梦 → 每会话只提示一次，不贴正文', async (t) => {
  const h = boot(t)
  await h.shared.dreamRun({ force: true })
  const before = h.stages.find(([s]) => s === 'before-turn')[1]
  const ev1 = { chatKey: 'group:100', wake: { kind: 'at' }, hint: [] }
  const ev2 = { chatKey: 'group:100', wake: { kind: 'at' }, hint: [] }
  const ev3 = { chatKey: 'private:200', wake: { kind: 'private' }, hint: [] }
  before(ev1); before(ev2); before(ev3)
  assert.equal(ev1.hint.length, 1, '第一次要提示')
  assert.equal(ev2.hint.length, 0, '同会话第二次不提示')
  assert.equal(ev3.hint.length, 1, '另一个会话可以再提示一次')
  assert.ok(ev1.hint[0].includes('昨晚做了个梦'))
  assert.ok(!ev1.hint[0].includes('一片很亮的水'), '不许把梦的内容贴进提示')
})

test('read_dreams 工具：能读到刚写的梦；days 越界夹紧；没文件返回空', async (t) => {
  const h = boot(t)
  await h.shared.dreamRun({ force: true })
  const tool = h.tools.get('read_dreams')
  const r = await tool.execute({ days: 3 })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.ok(r.entries[0].content.includes('一片很亮的水'))
  const r2 = await tool.execute({ days: 999 })
  assert.equal(r2.days, 30, '越界要夹到 30')
})

test('模型失败 → 不写文件、记 lastError、不抛', async (t) => {
  const h = boot(t)
  h.bot.dsh.runIsolatedTask = async () => { throw new Error('provider down') }
  const r = await h.shared.dreamRun({ force: true })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'model-failed')
  assert.equal(fs.existsSync(h.dreams), false)
  const st = JSON.parse(fs.readFileSync(h.state, 'utf8'))
  assert.ok(String(st.lastError).includes('provider down'))
})
