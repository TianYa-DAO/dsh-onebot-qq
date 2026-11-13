/**
 * test/local-desire.test.js — 她自己决定感兴趣的话题/人 + 自主起念 + 半夜自己醒来（2026-11-12）
 *
 * 主人要的活人感：
 *   · 兴趣是她**自己的**判断（interest_note 工具写，不是主人让她记的）
 *   · 清醒时偶尔"突然想说话"，按她自己的兴趣挑话题/人
 *   · 睡着时小概率半夜醒一会儿：醒来能主动、也能回话，然后回去睡
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPacing, REPLY_DEFAULTS } from '../kernel/pacing.js'

const QQ = '10002'
const GROUP = '20001'
const quiet = { info() {}, warn() {}, debug() {}, error() {} }
const H = 3600000

function mk({ reply = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desire-'))
  let t = new Date(2026, 10, 15, 15, 0, 0).getTime()
  const state = { _s: new Map(), get(k) { if (!this._s.has(k)) this._s.set(k, {}); return this._s.get(k) } }
  const p = createPacing({ log: quiet, state, clock: { now: () => t }, stateDir: path.join(dir, 'state') })
  p.apply({ merge: { enabled: false }, reply: {
    enabled: true, groups: [GROUP], hourlyMax: 100, sensitivity: 0, minGapMs: 0,
    silenceEnabled: false, coldSilenceMs: 60000,
    privateAllow: [QQ], privateColdHours: 6,
    desire: { enabled: true, minGapMin: 0, hourlyMax: 99, nightWakePct: 0, awakeMinMin: 20, awakeMaxMin: 60 },
    quiet: { enabled: true, wakeOnCall: true, baseBedtime: '02:30', baseSleepHours: 7.5, driftMin: 60,
      durationJitterMin: 30, minSleepHours: 5.5, maxSleepHours: 9.5, allNighterPct: 0, revertPct: 30 },
    continuation: { ...REPLY_DEFAULTS.continuation, enabled: false },
    ...reply,
  } })
  // 固定作息 02:00~10:00
  const f = path.join(dir, 'state', 'pacing-rhythm.json')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ day: '2026-11-15', bedtime: 120, sleepMin: 480, allNighter: false }))
  const fired = []
  p.start({ onProactiveTurn: (a) => fired.push(a), isBusy: () => false, onRepeat: () => {} })
  p.stop()
  return {
    p, fired, dir,
    setTime: (h, m = 0, d = 15) => { t = new Date(2026, 10, d, h, m, 0).getTime() },
    now: () => t,
    async tick(n = 1) { for (let i = 0; i < n; i += 1) { p.tickNow(); await new Promise((r) => setImmediate(r)) } },
    rhythmFile: f,
  }
}

test('兴趣画像：她记话题 → 分数累计、排序、能读出来', (t) => {
  const c = mk()
  c.p.noteInterest({ kind: 'topic', name: '瓦夜', delta: 20, why: '群里都在等' })
  c.p.noteInterest({ kind: 'topic', name: '瓦夜', delta: 15 })
  c.p.noteInterest({ kind: 'topic', name: '做饭', delta: -30 })
  const v = c.p.interestsView()
  const waye = v.topics.find((x) => x.name === '瓦夜')
  assert.ok(waye, '应记住「瓦夜」')
  assert.ok(waye.score > 60, `多次记录应累计（实际 ${waye.score}）`)
  assert.equal(v.topics[0].name, '瓦夜', '兴趣分最高的排第一')
  assert.equal(v.topics.find((x) => x.name === '做饭').score, 20, '负数会减淡')
})

test('兴趣画像：她记人 → 好感度', (t) => {
  const c = mk()
  const r = c.p.noteInterest({ kind: 'person', qq: QQ, name: '主人', delta: 25, why: '他总陪我聊' })
  assert.equal(r.ok, true)
  assert.ok(r.affinity > 50)
  const v = c.p.interestsView()
  assert.equal(v.people[0].qq, QQ)
  assert.ok(v.people[0].why.includes('陪我'))
})

test('兴趣会随时间变淡（不主动碰就慢慢忘）', (t) => {
  const c = mk()
  c.p.noteInterest({ kind: 'topic', name: '瓦夜', delta: 40 })
  const before = c.p.interestsView().topics[0].score
  // 直接改状态文件里的时间戳到 10 天前
  const doc = JSON.parse(fs.readFileSync(path.join(c.dir, 'state', 'pacing-interests.json'), 'utf8'))
  doc.topics[0].at -= 10 * 86400000
  fs.writeFileSync(path.join(c.dir, 'state', 'pacing-interests.json'), JSON.stringify(doc))
  const after = c.p.interestsView().topics[0].score
  assert.ok(after < before, `10 天后应更淡（${before} → ${after}）`)
})

test('自主起念：清醒时会按兴趣挑目标起念（reason=desire）', async (t) => {
  const c = mk()
  c.setTime(15, 0)
  c.p.noteInterest({ kind: 'topic', name: '瓦夜', delta: 30 })
  c.p.noteInterest({ kind: 'person', qq: QQ, name: '主人', delta: 30 })
  // 概率触发：每分钟掷一次（6%），逐分钟推进直到出现
  for (let m = 0; m < 59; m += 1) {
    c.setTime(15, m, 15)
    await c.tick(1)
    if (c.fired.some((f) => f.reason === 'desire')) break
  }
  const ok = c.fired.some((f) => f.reason === 'desire')
  assert.ok(ok, '清醒时应该出现自主起念')
  const d = c.fired.find((f) => f.reason === 'desire')
  assert.ok(d.chatKey, '应带目标会话')
  assert.ok(d.topic || d.person, '应带她感兴趣的话题或人')
})

test('自主起念：关掉后不再自己冒念头', async (t) => {
  const c = mk({ reply: { desire: { enabled: false } } })
  c.setTime(15, 0)
  await c.tick(20)
  assert.equal(c.fired.filter((f) => f.reason === 'desire').length, 0)
})

test('夜醒：开着概率时，睡着会自己醒来一段，这段时间算清醒', async (t) => {
  const c = mk({ reply: { desire: { enabled: true, nightWakePct: 100 } } })
  c.setTime(3, 0)                      // 凌晨 3 点，在睡（02:00~10:00）
  assert.equal(c.p.inQuietHours(), true, '3 点本来在睡')
  await c.tick(1)
  const woke = c.fired.find((f) => f.reason === 'night-wake')
  assert.ok(woke, '夜里应该自己醒来一次')
  assert.equal(c.p.awakeBecauseNightWake(c.now()) > 0, true, '夜醒期间应标记为清醒')
  assert.equal(c.p.inQuietHours(), true, '免打扰窗口本身没变')
  // 醒着的时候别人叫她 → 会回（sleepingNow 应为 false）
  assert.equal(c.p.awakeBecauseNightWake(c.now()) > 0, true)
})

test('夜醒：一晚只醒一次（不会反复醒）', async (t) => {
  const c = mk({ reply: { desire: { enabled: true, nightWakePct: 100 } } })
  c.setTime(3, 0)
  await c.tick(1)
  const first = c.fired.filter((f) => f.reason === 'night-wake').length
  for (let i = 0; i < 10; i += 1) { c.setTime(4, i * 5); await c.tick(1) }
  const after = c.fired.filter((f) => f.reason === 'night-wake').length
  assert.equal(first, 1)
  assert.equal(after, 1, '一晚只该醒一次')
})
