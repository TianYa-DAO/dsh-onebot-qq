/**
 * wake-groups — 「绘梨衣自己调各群唤醒词」的偏好层（平台级共享模块）
 *
 * 为什么单独一份文件（而不是改实例配置）
 * ======================================
 * 配置 `pluginConfig['gate-wake'].keywords` 是**主人**的意图（`*: 词` / `<群号>: 词`）；
 * 她按喜好微调属于另一层意图 —— 混进配置里，主人一改配置就会把她调的东西覆盖掉，
 * 也分不清"这个词是谁加的"。
 *
 * 所以她调的结果单独落盘：`~/.dsh/dsh-onebot-qq/state/wake-groups.json`
 *   { "<群号>": { add: ["阿梨"], remove: ["小怪兽"], at: 123, history: [{w:"+阿梨", at:123, why:"…"}] } }
 *
 * 最终生效 = （人设词 + 配置全局词 + 配置群专属词 + 她加的）− 她删的
 *
 * 纪律
 * ====
 * ① **只做词表合并**，不做匹配（匹配是 gate-wake 的事，包含匹配/大小写不敏感在那边）。
 * ② 文件读失败/写坏 → 当作没有覆盖，绝不能因此让唤醒失效（唤醒坏了 = 机器人变哑巴）。
 * ③ 上限兜底：每群最多 8 个自定义词，词长 1~8，禁空白/斜杠/正则符号（词会进包含匹配）。
 */
import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const MAX_ADD = 8
export const MAX_REMOVE = 8
export const MAX_LEN = 8
/** 每天每群最多调几次（防止她刷着玩） */
export const MAX_CHANGES_PER_DAY = 4

let _cache = { path: '', mtime: 0, data: {} }

export function wakeGroupsPath(dshDir) {
  return join(dshDir, 'dsh-onebot-qq', 'state', 'wake-groups.json')
}

export function readAll(path) {
  try {
    const st = statSync(path)
    if (_cache.path === path && _cache.mtime === st.mtimeMs) return _cache.data
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    const data = raw.trim() ? JSON.parse(raw) : {}
    _cache = { path, mtime: st.mtimeMs, data: data && typeof data === 'object' ? data : {} }
    return _cache.data
  } catch {
    return {} // 没文件 / 读坏 → 无覆盖
  }
}

let _writeChain = Promise.resolve()

export function writeAll(path, data) {
  // 原子写：tmp 名带随机后缀（固定 .tmp 名在并发写时会让 rename 抢同一个文件 → ENOENT/丢更新）
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8')
  renameSync(tmp, path)
  _cache = { path, mtime: 0, data } // 让下次 read 强制重读
}

/**
 * 串行化的「读-改-写」。同一进程内多个群回合可能同时调工具，
 * 各写各的会丢更新 —— 排队执行，保证每次改动都建立在最新内容上。
 * （跨进程仍有窗口：这类文件只有本插件写，风险已降到最低）
 */
export function mutateAtomic(path, fn) {
  const run = _writeChain.then(() => {
    const all = { ...(readAll(path) || {}) }
    const out = fn(all)
    writeAll(path, all)
    return out
  })
  _writeChain = run.catch(() => {})
  return run
}

/** 该群的覆盖记录（没有就返回空壳） */
export function overridesFor(dshDir, gid) {
  const all = readAll(wakeGroupsPath(dshDir))
  const rec = all[String(gid)] || {}
  return {
    add: Array.isArray(rec.add) ? rec.add.map(String) : [],
    remove: Array.isArray(rec.remove) ? rec.remove.map(String) : [],
    at: Number(rec.at) || 0,
    history: Array.isArray(rec.history) ? rec.history : [],
  }
}

/** 把她的偏好套到词表上（去重、小写、去空）。纯函数，好测。 */
export function applyOverrides(words, ov) {
  const norm = (list) => (Array.isArray(list) ? list : [])
    .map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean)
  const base = norm(words)
  const remove = new Set(norm(ov?.remove))
  const add = norm(ov?.add)
  const out = []
  const seen = new Set()
  for (const w of [...base, ...add]) {
    if (!w || remove.has(w) || seen.has(w)) continue
    seen.add(w)
    out.push(w)
  }
  return out
}

/** 校验一个词能不能用。返回 null = 可以，否则返回原因。 */
export function validateWord(word, prev = []) {
  const w = String(word ?? '').trim()
  if (!w) return '词不能为空'
  if (w.length > MAX_LEN) return `词太长（最多 ${MAX_LEN} 个字）`
  if (/\s/.test(w)) return '词里不能有空格'
  if (/[\\/|,;:*"'`<>()\[\]{}?+^$]/.test(w)) return '词里不能有标点或正则符号'
  if (prev.map((x) => String(x).toLowerCase()).includes(w.toLowerCase())) return '这个词已经生效了'
  return null
}

export function isTooGeneric(word) {
  const w = String(word ?? '').trim().toLowerCase()
  const generic = ['你', '他', '她', '我', '在吗', '有人', '大家', '群主', '管理', '机器人', 'bot', 'ai', '你好', 'hello', 'hi']
  return generic.includes(w)
}

/** 今天的变更次数（按 history 里 24h 内计数） */
export function changesToday(rec, now = Date.now()) {
  const h = Array.isArray(rec?.history) ? rec.history : []
  return h.filter((x) => now - Number(x?.at || 0) < 86400000).length
}

/** 追加一条变更记录（只留最近 40 条） */
export function pushHistory(rec, entry) {
  const h = Array.isArray(rec.history) ? rec.history.slice(-39) : []
  h.push({ ...entry, at: Number(entry?.at) || Date.now() })
  return h
}
