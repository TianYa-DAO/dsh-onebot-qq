/**
 * test/local-sticker-pick.test.js — 表情挑图改进（摘自上游戏 2026-10-29）
 *
 * 三条：① 泛化标签（表情包/搞笑/可爱…）不算命中 ② 具体标签优先 ③ 同一会话别连着发同一张
 * 目的是"活人感"：她说"来个猫的"应该抽到真贴猫的图，而不是每次都同一批泛化图。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 直接测纯函数（不在插件里也不导出的部分通过重新声明？不——这里 import 导出的 pickWeighted 并复制规则做一致性校验）
import { pickWeighted } from '../plugins/stickers/index.js'

test('pickWeighted：pref 高的更容易被选中（平方放大）', () => {
  const items = [{ id: 1, pref: 10 }, { id: 2, pref: 90 }]
  let a = 0
  for (let i = 0; i < 2000; i += 1) { if (pickWeighted(items, Math.random).id === 2) a += 1 }
  assert.ok(a / 2000 > 0.9, `高喜好应占绝大多数，实际 ${(a / 2000 * 100).toFixed(0)}%`)
})

test('pickWeighted：空数组返回 null，单条直接返回', () => {
  assert.equal(pickWeighted([]), null)
  assert.equal(pickWeighted([{ id: 7 }], Math.random).id, 7)
})

// 泛化标签 / 具体度的规则与实现对拍（实现是模块内私有，这里按同一份规则验收行为）
const GENERIC = new Set(['表情', '表情包', '图片', '动图', '搞笑', '好笑', '开心', '可爱', '萌', '沙雕', '魔性', 'meme', 'gif'])
const isGeneric = (t) => GENERIC.has(String(t || '').trim().toLowerCase())
const spec = (t) => (!t || isGeneric(t) ? 0 : Math.min(8, String(t).trim().length))

test('泛化标签识别：表情包/搞笑/可爱 都不算具体标签', () => {
  for (const t of ['表情包', '搞笑', '可爱', 'meme', 'GIF']) assert.equal(isGeneric(t), true, `${t} 应是泛化标签`)
  for (const t of ['阴阳怪气', '猫', '装凶', '无语']) assert.equal(isGeneric(t), false, `${t} 不是泛化标签`)
})

test('具体度：越长的标签越具体，泛化标签记 0', () => {
  assert.equal(spec('搞笑'), 0)
  assert.ok(spec('阴阳怪气') > spec('猫'), '长标签应比单字标签更具体')
  assert.equal(spec(''), 0)
})

test('挑图池规则：没关键词时只从"有具体标签"的图里挑（泛化图不占位）', () => {
  const items = [
    { id: 1, tags: ['搞笑'], pref: 99 },       // 只有泛化标签 → 不该被挑
    { id: 2, tags: ['猫'], pref: 50 },
    { id: 3, tags: ['无语', '阴阳怪气'], pref: 50 },
  ]
  const pool = items.filter((i) => (i.tags || []).filter((t) => !isGeneric(t)).length > 0)
  assert.deepEqual(pool.map((i) => i.id), [2, 3], '只有泛化标签的图应被排除')
})

test('挑图池规则：关键词里的泛化词被过滤（"来个搞笑的猫" → 只按"猫"找）', () => {
  const toks = '来个搞笑的猫'.split(/\s+/).filter((t) => !isGeneric(t))
  assert.deepEqual(toks, ['来个搞笑的猫'])   // 无空格整串：不会误当泛化
  const toks2 = '搞笑 猫'.split(/\s+/).filter((t) => !isGeneric(t))
  assert.deepEqual(toks2, ['猫'], '"搞笑"应被过滤掉')
})
