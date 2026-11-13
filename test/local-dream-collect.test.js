/** test/local-dream-collect.test.js — 梦境素材抽取（Light 阶段，纯本地） */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectFragments } from '../plugins/dream/collect.js'

const NOW = Date.parse('2026-11-13T23:00:00+08:00')
const H = 3600000

function dir(rowsByFile) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-collect-'))
  for (const [name, rows] of Object.entries(rowsByFile)) {
    fs.writeFileSync(path.join(d, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  }
  return d
}
const row = (dir_, ts, text, extra = {}) => ({ dir: dir_, ts, text, ...extra })

test('只收她回过话的轮次（in → out 成对）', (t) => {
  const d = dir({
    'group_100.jsonl': [
      row('in', NOW - 3 * H, '今天降温了', { sender: { name: '甲' } }),
      row('out', NOW - 3 * H + 60000, '手都凉了'),
      row('in', NOW - 2 * H, '有人在吗', { sender: { name: '乙' } }),   // ← 她没回，不算
      row('in', NOW - 1 * H, '我去睡了', { sender: { name: '丙' } }),   // ← 也没回
    ],
  })
  const r = collectFragments({ archiveDir: d, nowMs: NOW })
  assert.equal(r.lines.length, 1, '只有她回过的那一轮该进素材')
  assert.ok(r.lines[0].includes('今天降温了'))
  assert.ok(r.lines[0].includes('手都凉了'))
})

test('占位消息（[图片]/[表情]）不进梦', (t) => {
  const d = dir({
    'private_200.jsonl': [
      row('in', NOW - H, '[图片]'),
      row('out', NOW - H + 1000, '看到了'),
      row('in', NOW - 30 * 60000, '[表情]'),
      row('out', NOW - 30 * 60000 + 1000, '嗯'),
    ],
  })
  const r = collectFragments({ archiveDir: d, nowMs: NOW })
  assert.equal(r.lines.length, 0, '纯占位不该长出梦')
})

test('超过 24 小时的不收；数量与字数有上限', (t) => {
  const rows = []
  for (let i = 0; i < 50; i += 1) {
    rows.push(row('in', NOW - 30 * H + i * 60000, `很早的话${i}`, { sender: { name: 'x' } }))
    rows.push(row('out', NOW - 30 * H + i * 60000 + 1000, '嗯'))
  }
  rows.push(row('in', NOW - H, '昨晚的话', { sender: { name: 'y' } }))
  rows.push(row('out', NOW - H + 1000, '记得'))
  const d = dir({ 'group_300.jsonl': rows })
  const r = collectFragments({ archiveDir: d, nowMs: NOW, maxItems: 5, maxChars: 1000 })
  assert.ok(r.lines.length <= 5, `最多 5 行，实际 ${r.lines.length}`)
  assert.ok(r.lines.join('\n').length <= 1000)
  assert.ok(r.lines.some((l) => l.includes('昨晚的话')), '24h 内的必须留下')
  assert.ok(!r.lines.some((l) => l.includes('很早的话')), '30 小时前的必须丢掉')
})

test('有情绪词/有人名的优先保留', (t) => {
  const rows = []
  for (let i = 0; i < 10; i += 1) {
    rows.push(row('in', NOW - 2 * H + i * 1000, `普通一句${i}`, { sender: { name: '甲' } }))
    rows.push(row('out', NOW - 2 * H + i * 1000 + 500, '哦'))
  }
  rows.push(row('in', NOW - 90 * 60000, '我今天特别难过', { sender: { name: '小默' } }))
  rows.push(row('out', NOW - 90 * 60000 + 500, '怎么了'))
  const d = dir({ 'group_400.jsonl': rows })
  const r = collectFragments({ archiveDir: d, nowMs: NOW, maxItems: 3, maxChars: 4000 })
  assert.ok(r.lines.some((l) => l.includes('特别难过')), '情绪句必须挤进前几行')
})

test('结果按时间正序（梦里的时间是顺的）', (t) => {
  const d = dir({
    'group_500.jsonl': [
      row('in', NOW - 5 * H, '早上那句', { sender: { name: 'a' } }),
      row('out', NOW - 5 * H + 1000, '嗯'),
      row('in', NOW - 1 * H, '晚上那句', { sender: { name: 'b' } }),
      row('out', NOW - 1 * H + 1000, '嗯嗯'),
    ],
  })
  const r = collectFragments({ archiveDir: d, nowMs: NOW })
  assert.equal(r.lines.length, 2)
  assert.ok(r.lines[0].includes('早上那句'), '第一行应是最早的')
  assert.ok(r.lines[1].includes('晚上那句'))
})

test('归档目录不存在 / 空 → 返回空，不抛', (t) => {
  assert.deepEqual(collectFragments({ archiveDir: '/tmp/definitely-not-here', nowMs: NOW }).lines, [])
  const d = dir({})
  assert.deepEqual(collectFragments({ archiveDir: d, nowMs: NOW }).lines, [])
})
