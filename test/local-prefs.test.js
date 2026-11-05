/**
 * test/local-prefs.test.js — 表情包喜好系统（本地补丁）。
 *
 * 覆盖：加权挑图（喜好高的更容易被选中）。
 * 淘汰/打分逻辑在 Python 侧（sticker-admin/tests/test_prefs.py）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickWeighted } from '../plugins/stickers/index.js'

function seq(values) {
  let i = 0
  return () => values[(i++) % values.length]
}

test('pickWeighted：喜好高的明显更容易被挑中', () => {
  const items = [
    { id: 1, pref: 95 },
    { id: 2, pref: 50 },
    { id: 3, pref: 10 },
  ]
  const counts = { 1: 0, 2: 0, 3: 0 }
  let seed = 12345
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  for (let i = 0; i < 6000; i++) counts[pickWeighted(items, rand).id]++
  assert.ok(counts[1] > counts[2], `95 分应比 50 分多：${counts[1]} vs ${counts[2]}`)
  assert.ok(counts[2] > counts[3], `50 分应比 10 分多：${counts[2]} vs ${counts[3]}`)
  assert.ok(counts[3] > 0, '低分也不至于完全发不出来')
})

test('pickWeighted：没写 pref 按 50 算；空列表返回 null', () => {
  assert.equal(pickWeighted([]), null)
  const items = [{ id: 1 }, { id: 2 }]
  const got = new Set()
  for (let i = 0; i < 200; i++) got.add(pickWeighted(items, () => i / 200).id)
  assert.deepEqual([...got].sort(), [1, 2], '两张都能被挑到')
})

test('pickWeighted：pref 越界被夹到 1~100', () => {
  const items = [{ id: 1, pref: 999 }, { id: 2, pref: -50 }]
  let high = 0
  for (let i = 0; i < 1000; i++) if (pickWeighted(items, Math.random).id === 1) high++
  assert.ok(high > 950, `999 分应几乎总是胜出（实际 ${high}/1000）`)
})
