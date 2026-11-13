/** test/local-dream-narrative.test.js — 写梦（REM）：提示词 + 解析 + DREAMS.md 读写 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDreamPrompt, parseDreamOutput, FALLBACK_DREAM } from '../plugins/dream/narrative.js'
import { appendDream, readDreams, parseEntries } from '../plugins/dream/dreams-file.js'

const NOW = Date.parse('2026-11-13T23:00:00+08:00')

test('提示词：含素材、要求她用第一人称、禁止提"梦/AI"、给了 META 结构', () => {
  const p = buildDreamPrompt({
    fragments: ['22:10 群123｜甲: 今天降温了 ／ 我: 手都凉了'],
    interests: { topics: [{ name: '瓦夜' }], people: [{ name: '主人', qq: '10002' }] },
    recentDreams: ['上次梦到一条很长的走廊'],
    rhythm: { text: '才睡了两个小时' },
  })
  assert.ok(p.includes('今天降温了'), '素材要进去')
  assert.ok(p.includes('第一人称'), '要第一人称')
  assert.ok(p.includes('不许说') && p.includes('我在做梦'), '要禁掉"我在做梦"')
  assert.ok(p.includes('META:'), '要给出 META 结构')
  assert.ok(p.includes('delta'), '要说明 delta 怎么定')
  assert.ok(p.includes('瓦夜') && p.includes('主人'), '兴趣要带上')
  assert.ok(p.includes('别重复同样的意象'), '要防重复意象')
})

test('解析：正常两段（正文 + META）', () => {
  const raw = `DREAM: 路是会自己走的，我跟着它，走到一间亮着灯的店门口。店里有人在数货物，抬头冲我笑了一下。

META: {"themes":["路","灯"],"figures":[{"qq":"10002","name":"主人","delta":4,"why":"梦里他把伞给了我"}],"mood":1}`
  const r = parseDreamOutput(raw)
  assert.equal(r.degraded, false)
  assert.ok(r.content.includes('路是会自己走的'))
  assert.ok(!r.content.includes('META'), '正文里不该带 META')
  assert.deepEqual(r.meta.themes, ['路', '灯'])
  assert.equal(r.meta.figures[0].delta, 4)
  assert.equal(r.meta.mood, 1)
})

test('解析：delta 越界必须夹到 ±5；没有合法 QQ 的 figure 丢弃', () => {
  const raw = `DREAM: 有人一直在喊我。
META: {"themes":[],"figures":[{"qq":"111111","name":"甲","delta":100},{"qq":"bad","name":"乙","delta":-9}],"mood":-9}`
  const r = parseDreamOutput(raw)
  assert.equal(r.meta.figures.length, 1, 'QQ 不合法的要丢掉')
  assert.equal(r.meta.figures[0].delta, 5, '100 要夹到 5')
  assert.equal(r.meta.mood, -2, 'mood 要夹到 -2')
})

test('解析：只有正文没有 META → degraded，但正文保留', () => {
  const r = parseDreamOutput('DREAM: 下雨了，我在屋檐下站了很久。')
  assert.equal(r.degraded, true)
  assert.equal(r.reason, 'no-meta')
  assert.ok(r.content.includes('下雨了'))
  assert.deepEqual(r.meta.figures, [])
})

test('解析：垃圾输入 / 空 → degraded 且给兜底正文，不抛', () => {
  for (const raw of ['', '   ', '???', '```json\n{oops\n```']) {
    const r = parseDreamOutput(raw)
    assert.equal(r.degraded, true)
    assert.ok(r.content.length > 0, '必须有兜底正文')
  }
  assert.ok(FALLBACK_DREAM.length > 5)
})

test('写文件：新建 → 前插 → 同一天合并 → 裁剪', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-file-'))
  const file = path.join(d, 'DREAMS.md')
  assert.equal(appendDream({ file, content: '第一篇梦', nowMs: NOW }).ok, true)
  let entries = readDreams({ file, days: 5 })
  assert.equal(entries.length, 1)
  assert.ok(entries[0].content.includes('第一篇梦'))

  // 前一天 → 应该排在前面（新→旧）
  appendDream({ file, content: '第二篇梦', nowMs: NOW - 86400000 })
  entries = readDreams({ file, days: 5 })
  assert.equal(entries.length, 2)
  assert.ok(entries[0].content.includes('第一篇梦'), '新的在最上面')

  // 同一天再写 → 合并进同一段，不新增日期
  appendDream({ file, content: '同一天补的', nowMs: NOW })
  entries = readDreams({ file, days: 5 })
  assert.equal(entries.length, 2, '同一天不该多一段')
  assert.ok(entries[0].content.includes('同一天补的') && entries[0].content.includes('第一篇梦'))

  // 裁剪：只留 1 段
  appendDream({ file, content: '第三篇梦', nowMs: NOW - 2 * 86400000, keepDays: 1 })
  const parsed = parseEntries(fs.readFileSync(file, 'utf8'))
  assert.equal(parsed.entries.length, 1, 'keepDays=1 只留一段')
})

test('写文件：空内容不写；文件不存在时读取返回空', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-file2-'))
  const file = path.join(d, 'DREAMS.md')
  assert.equal(appendDream({ file, content: '   ', nowMs: NOW }).ok, false)
  assert.deepEqual(readDreams({ file, days: 3 }), [])
})
