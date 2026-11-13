/**
 * test/local-message-monitor.test.js — 消息监测规则（直接摘上游戏 2026-11-07 的实现 + matcher）
 *
 * 语义（与上游一致）：
 *   · 只在**明确配置的群**里匹配；空规则 = 不监测
 *   · `contains`（包含）/ `exact`（整条相等）两种匹配，首条命中的生效
 *   · 命中 → 设置 ev.wake = {kind:'monitor'} + 注入 hint（带规则名/消息ID/附加指令）
 *   · 同一规则同一群 30 秒冷却（可配 cooldownMs）；不消耗别的冷却、不发 QQ、不叫模型两次
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateRules, matchRule } from '../plugins/message-monitor/matcher.js'
import plugin from '../plugins/message-monitor/index.js'

const GROUP = 20001
const OTHER_GROUP = 20002

const mkRules = () => [
  { id: 'r1', match: 'contains', text: '开团', groups: [GROUP], instruction: '提醒大家今晚八点开团' },
  { id: 'r2', match: 'exact', text: '报名', groups: [GROUP], instruction: '把人加进报名表', cooldownMs: 0 },
]

test('validateRules：接受合法规则并补默认值', () => {
  const rules = validateRules(mkRules())
  assert.equal(rules.length, 2)
  assert.equal(rules[0].cooldownMs, 30000, '默认冷却 30 秒')
  assert.equal(rules[0].enabled, true)
  assert.equal(rules[1].cooldownMs, 0)
})

test('validateRules：拒绝非法规则（未知字段/坏 match/群号非数字）', () => {
  assert.throws(() => validateRules([{ id: 'a', match: 'fuzzy', text: 'x', groups: [1], instruction: 'y' }]), /match/)
  assert.throws(() => validateRules([{ id: 'a', match: 'contains', text: 'x', groups: ['20001'], instruction: 'y' }]), /groups/)
  assert.throws(() => validateRules([{ id: 'a', match: 'contains', text: 'x', groups: [1], instruction: 'y', extra: 1 }]), /未知字段/)
  assert.throws(() => validateRules('nope'), /数组/)
})

test('matchRule：包含匹配 / 整条匹配 / 别的群不命中', () => {
  const rules = validateRules(mkRules())
  assert.equal(matchRule(rules, { isGroup: true, groupId: GROUP, text: '今晚开团吗', sender: { qq: 1 } })?.id, 'r1')
  assert.equal(matchRule(rules, { isGroup: true, groupId: GROUP, text: '报名', sender: { qq: 1 } })?.id, 'r2')
  assert.equal(matchRule(rules, { isGroup: true, groupId: GROUP, text: '报名啦', sender: { qq: 1 } }), null, 'exact 不该命中"报名啦"，且"报名啦"不含"开团"')
  assert.equal(matchRule(rules, { isGroup: true, groupId: OTHER_GROUP, text: '开团', sender: { qq: 1 } }), null)
  assert.equal(matchRule(rules, { isGroup: true, groupId: GROUP, text: '开团', sender: { qq: 9 }, selfId: 9 }), null, '自己发的不算')
})

/** 造一个最小 bot：捕获 wake 阶段处理器 */
function makeBot(cfg = {}) {
  const handlers = []
  const stateMap = new Map()
  const bot = {
    id: 'message-monitor',
    cfg: { enabled: true, rulesJson: JSON.stringify(mkRules()), ...cfg },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    napcat: { selfId: 999 },
    state: { get(k) { if (!stateMap.has(k)) stateMap.set(k, {}); return stateMap.get(k) } },
    on(stage, fn) { handlers.push([stage, fn]) },
  }
  return { bot, handlers }
}

const ev = (text, { groupId = GROUP, qq = 12345, isGroup = true } = {}) => ({
  chatKey: `group:${groupId}`, isGroup, groupId, text, messageId: 4242,
  sender: { qq, name: '群友' }, hint: [], wake: null,
})

test('命中规则 → 设置 wake=monitor 并注入附加指令', async (t) => {
  const { bot, handlers } = makeBot()
  await plugin.setup(bot)
  const wake = handlers.find(([s]) => s === 'wake')
  assert.ok(wake, '应注册 wake 阶段')
  const e = ev('今晚开团吗')
  await wake[1](e)
  assert.equal(e.wake?.kind, 'monitor')
  assert.equal(e.wake.ruleId, 'r1')
  const hint = (e.hint || []).join('\n')
  assert.ok(hint.includes('消息监测指令'), '应标明这是控制台指令而非群友发言')
  assert.ok(hint.includes('4242'), '应带消息 ID')
  assert.ok(hint.includes('提醒大家今晚八点开团'), '应带附加指令')
})

test('冷却：同一规则同一群 30 秒内只触发一次', async (t) => {
  const { bot, handlers } = makeBot()
  await plugin.setup(bot)
  const wake = handlers.find(([s]) => s === 'wake')
  const a = ev('开团'); await wake[1](a)
  const b = ev('又开团'); await wake[1](b)
  assert.equal(a.wake?.kind, 'monitor', '第一次应触发')
  assert.equal(b.wake, null, '冷却期内不该再触发')
})

test('exact 规则 cooldownMs=0 → 连续两次都触发', async (t) => {
  const { bot, handlers } = makeBot()
  await plugin.setup(bot)
  const wake = handlers.find(([s]) => s === 'wake')
  const a = ev('报名'); await wake[1](a)
  const b = ev('报名'); await wake[1](b)
  assert.equal(a.wake?.kind, 'monitor')
  assert.equal(b.wake?.kind, 'monitor', '冷却 0 时每次都触发')
})

test('空规则 / 解析失败 → 不监测也不崩', async (t) => {
  for (const rulesJson of ['', 'not json']) {
    const { bot, handlers } = makeBot({ rulesJson })
    await plugin.setup(bot)
    const wake = handlers.find(([s]) => s === 'wake')
    const e = ev('开团')
    await wake[1](e)
    assert.equal(e.wake, null, `rulesJson=${JSON.stringify(rulesJson)} 时不该触发`)
  }
})

test('不覆盖已有唤醒（被人 @ 了就以 @ 为准）', async (t) => {
  const { bot, handlers } = makeBot()
  await plugin.setup(bot)
  const wake = handlers.find(([s]) => s === 'wake')
  const e = ev('开团')
  e.wake = { kind: 'at' }
  await wake[1](e)
  assert.equal(e.wake.kind, 'at', '已有唤醒不该被改写成 monitor')
})
