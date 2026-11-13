/**
 * group-memory — 群记忆子插件（id: 'group-memory'，order: 90）
 *
 * 设计：**没有数据库** —— 每个群一篇人可读的 Markdown（`<群号>.md`），文件本身就是全部状态。
 *
 * 两部分职责：
 *   A. **读取侧**（每次回话前）：① before-turn 给一行"指针"；② 工具 read_memory 按群读那一篇；③ 按 mtime+size 缓存。
 *   B. **积累侧**（后台定时）：按配置的间隔，取各群最近的聊天留档 → 交给模型合并/更新这一篇 Markdown。
 *      实现拆在同目录 `accumulate.js`（同一子插件、同一组配置），由本文件 setup 时接线。
 *
 * 三条纪律（踩出来的结论，别改）：
 *  ① **只给指针，绝不贴正文**。历史上曾把记忆正文拼进 prompt → 它拼在**用户消息**里，模型会误当成
 *     "群友说的话"（出错概率高）；每次更新还往历史里再塞一份，白烧上下文。正文只在模型**自己调工具**时进上下文。
 *  ② **写盘只有一处**：`writeMemory()`（备份到 `.revisions/` → 原子写）。读取侧永远不写。
 *  ③ **认人只看 QQ 号**：条目形如 `- **昵称(QQ)**：…`，群友常换昵称、号码不变；同一人换了名字仍是同一人。
 *     指针与工具描述里都把这条写给模型。
 *
 * 平台边界：默认目录是相对 dataDir 的短路径（内核 resolve 成绝对）；读文件剥 UTF-8 BOM（Windows 编辑器常见）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { stripBom } from '../../platform/atomic.js'
import { createAccumulator } from './accumulate.js'

export default {
  id: 'group-memory',
  title: '群记忆',
  order: 90,

  configSchema: {
    skipGroups: {
      type: 'group', default: [], group: '群记忆', label: '不积累记忆的群',
      hint: '勾上的群不留记忆、也不注入（比如闲聊灌水群）。别的群不受影响。',
    },
    enabled: { type: 'bool', default: true, group: '群记忆', label: '群记忆（指针注入）', hint: '开：把本群历史要点作为提示注入上下文，帮它记住群里的事；关：不读记忆。' },
    dir: {
      type: 'str', default: 'qq-memory', group: '群记忆', label: '记忆目录',
      hint: '相对路径由内核按数据目录解析；每群一篇 <群号>.md',
    },
    maxBytes: {
      type: 'int', default: 24000, min: 1000, max: 200000, step: 1000, group: '群记忆', label: '单篇读取上限（字节）',
      hint: '超了按**整行**截断（不切碎多字节字符），末尾注明"过长已截断"',
    },

    // ── 自动积累（本插件自带定时器，不需要外部 cron）──────────────────
    accumulateEnabled: {
      type: 'bool', default: true, group: '群记忆', label: '自动积累群记忆',
      hint: '开：按下面的间隔，把各群最近的聊天交给模型，自动更新记忆文件；关：完全不跑（仍可手动「立刻积累一轮」）。',
    },
    mutedChats: {
      type: 'group', default: [], group: '群记忆', label: '单独关掉记忆的会话',
      hint: '填 `group:群号` 或 `private:QQ号`，多个用逗号分隔（如 group:10001,private:10002）。'
        + '关掉的会话：不注入指针、不读、不积累，但已有记忆仍可在控制台查看/编辑/删除。留空 = 全部开启。',
    },
    accumulateSchedule: {
      type: 'enum', default: 'daily', group: '群记忆', label: '积累调度',
      options: [{ value: 'daily', label: '每日整理互动（推荐）' }, { value: 'interval', label: '旧版间隔积累（兼容）' }],
      hint: '每日模式：每天定时（见下）逐会话整理本机的互动，结构化增删改（稳定/近期/约定三区）；'
        + '间隔模式：保留旧版「每 N 小时一轮 + 聊完就收一次」的增量行为。'
        + '每日模式更不容易漂移，但需要多一次后台模型调用/会话/天。',
    },
    accumulateDailyTime: {
      type: 'str', default: '04:00', group: '群记忆', label: '每日执行时间',
      hint: '24 小时制 HH:mm，按下面的时区执行。停机错过后恢复会补跑一次。',
    },
    accumulateTimezone: {
      type: 'str', default: 'Asia/Shanghai', group: '群记忆', label: '执行时区',
      hint: 'IANA 时区名，例如 Asia/Shanghai。填错会停止调度并在状态里显示错误。',
    },
    accumulateRecentDays: {
      type: 'int', default: 14, min: 1, max: 90, group: '群记忆', label: '近期经历保留天数', unit: '天',
      hint: '只有「近期记忆」会自动到期；「稳定记忆」「约定与承诺」不按这个时间自动删除。',
    },
    accumulateModelProvider: {
      type: 'str', default: '', group: '群记忆', label: '记忆分析模型 · provider（可留空）',
      hint: '留空 = 跟日常模型一致。要和下一项**成对填写**；只填一个会报错并保留待处理素材。',
    },
    accumulateModel: {
      type: 'str', default: '', group: '群记忆', label: '记忆分析模型 · model（可留空）',
      hint: '留空 = 跟日常模型一致。填了会走隔离的后台会话，不影响她日常聊天的模型。',
    },
    accumulateIntervalHours: {
      type: 'int', default: 8, min: 1, max: 24, step: 1, group: '群记忆', label: '积累间隔', unit: '小时',
      hint: '多久跑一轮。每轮只处理「有新消息的群」；默认一批一次模型调用（群多时按下面的上限自动拆批）。',
    },
    accumulateMode: {
      type: 'enum', default: 'digest', group: '群记忆', label: '积累方式',
      options: [
        { value: 'digest', label: '增量要点（推荐：一轮一次调用，只提炼新信息）' },
        { value: 'rewrite', label: '重写全文（一轮一次，模型重写各群完整记忆）' },
        { value: 'per-group', label: '逐群（每群一次调用，仅排障用）' },
      ],
      hint: '增量要点 = 把本轮所有群合成一次调用，模型只输出「新增要点」，本地合并进记忆文件（快、省、输出小）；重写全文 = 模型输出各群完整记忆再整篇替换（记忆更整，但输出大、慢）；逐群 = 每个群单独调用一次。',
    },
    accumulateBatchMaxChars: {
      type: 'int', default: 200000, min: 20000, max: 600000, step: 10000, group: '群记忆', label: '单次提示词上限', unit: '字',
      hint: '一轮里所有群（聊天正文）加起来超过这个上限就自动拆成多次调用；越大越省调用次数，但单次更慢。',
    },
    accumulateLookbackHours: {
      type: 'int', default: 72, min: 1, max: 240, step: 1, group: '群记忆', label: '回看最近多少小时', unit: '小时',
      hint: '首次积累/水位之前最多回看多久的聊天（已消化过的不会重复喂）；一般与「原始记录保留天数」对齐即可。',
    },
    accumulateKeepDays: {
      type: 'int', default: 3, min: 0, max: 30, step: 1, group: '群记忆', label: '原始记录保留天数', unit: '天',
      hint: '车轮式清理：每轮写完记忆后，删掉「已消化 且 超过 N 天」的聊天留档（保留今天+前 N-1 天）；0 = 永不删。未消化的记录不会删。',
    },
    accumulateKeepRows: {
      type: 'int', default: 0, min: 0, max: 100000, step: 100, group: '群记忆', label: '每群最多保留多少行',
      hint: '在「保留天数」之外的额外行数上限（只裁已消化的最旧行）；0 = 不限。',
    },
    accumulateSectionMaxItems: {
      type: 'int', default: 80, min: 10, max: 500, step: 10, group: '群记忆', label: '每节条目上限',
      hint: '增量合并时每个小节（群里的人/对话风格/其它）最多保留多少条，超出从最早的开始丢（防记忆文件无限膨胀）。',
    },
    accumulateMsgPerGroup: {
      type: 'int', default: 200, min: 20, max: 1000, step: 20, group: '群记忆', label: '每群最多取多少条',
      hint: '从最近的消息往前取；条数越多越准，token 也越多。',
    },
    accumulateMaxChars: {
      type: 'int', default: 8000, min: 1000, max: 30000, step: 500, group: '群记忆', label: '每群正文上限', unit: '字',
      hint: '喂给模型的聊天正文最多多少字符（超出从最早的消息开始丢）。',
    },
    accumulateMinNewMsgs: {
      type: 'int', default: 20, min: 0, max: 500, step: 5, group: '群记忆', label: '少于多少条就跳过',
      hint: '某个群最近消息太少时跳过、不调模型（省 token）。0 = 只要有一条就积累。',
    },
    accumulateIdleMin: {
      type: 'int', default: 30, min: 0, max: 720, step: 5, group: '群记忆', label: '聊完多久后立刻沉淀',
      unit: '分钟',
      hint: '会话（群或私聊）安静这么多分钟后，不等每日定时，立刻把这个会话这轮聊的内容提炼进记忆。'
        + '聊天中途沉淀会提炼出半截对话，所以等安静了再收。0 = 关闭，只按每日定时积累。',
      label: '聊完多久后立刻沉淀（闲置触发）',
    },
    accumulateIdleMinMsgs: {
      type: 'int', default: 3, min: 1, max: 100, step: 1, group: '群记忆', label: '聊完沉淀至少几条',
      hint: '会话级沉淀（聊完就收）要求至少有几条**别人**的消息。她自己的自言自语不算 ——'
        + '否则死群里她主动接话、没人应、30 分钟后又把那几句话沉淀回记忆，会空转重复录入。',
    },
    accumulateRetainRevisions: {
      type: 'int', default: 20, min: 0, max: 200, step: 5, group: '群记忆', label: '保留多少历史版本',
      hint: '每次改写前把旧版备份到 .revisions/，只保留最近 N 份（0 = 不备份；控制台手改的 -manual 备份也按这个数清理）。',
    },
    accumulateMaxGroupsPerRound: {
      type: 'int', default: 12, min: 1, max: 200, step: 1, group: '群记忆', label: '单轮最多处理多少个群',
      hint: '群很多时一轮只处理这么多个群，其余下轮轮转处理（不会永远饿死大号段群）。调大 = 单轮更久、可能拆批。',
    },
  },

  setup(bot) {
    const cfg = bot.cfg || {}
    const log = bot.log
    // 目录以实例配置为准（内核已解析成绝对路径）；缺省退回 <dataDir>/qq-memory
    const dataDirOf = () => String(bot.core?.dataDir || '.')
    const dirOf = () => String(cfg.dir || '').trim() || path.join(dataDirOf(), 'qq-memory')
    const maxBytesOf = () => Math.max(1000, Number(cfg.maxBytes) || 24000)
    const rawCache = new Map() // 文件路径 -> { stamp, text }：原文（不截断）；读写两侧共用，只读一次盘
    const fallbackSeen = new Map() // 当 bot.state 不可用时的兜底

    function getSeen(chatKey) {
      const st = bot.state?.get?.(chatKey)
      if (st) return st._scratch?.['group-memory:seen']
      return fallbackSeen.get(chatKey)
    }
    function setSeen(chatKey, stamp) {
      const st = bot.state?.get?.(chatKey)
      if (st) {
        st._scratch = st._scratch || Object.create(null)
        st._scratch['group-memory:seen'] = stamp
      } else {
        fallbackSeen.set(chatKey, stamp)
      }
    }

    function groupIdOf(ev) {
      if (!ev || !ev.isGroup) return null
      const gid = String(ev.groupId ?? '')
      if (/^\d{4,12}$/.test(gid)) return gid
      const m = /^group:(\d{4,12})$/.exec(String(ev.chatKey || ''))
      return m ? m[1] : null
    }

    /** 超过上限按**整行**截断：先按字节砍到上限，再退到最后一个换行（免得切碎多字节字符）。 */
    function clip(text) {
      const maxBytes = maxBytesOf()
      if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
      const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
      const nl = cut.lastIndexOf('\n')
      return cut.slice(0, nl > 0 ? nl : cut.length).replace(/\r$/, '') + '\n…（本群记忆过长已截断，请精简文件）'
    }

    /**
     * 会话键：`group:<群号>` / `private:<QQ号>`。私聊也有自己的一篇长期记忆（摘自上游戏 2026-11-06）。
     * 私聊记忆放在 `<记忆目录>/private/<QQ>.md`，与群记忆分目录 —— 群号/QQ 号可能撞数字，混在一起会串。
     */
    const chatKeyOf = (ev) => {
      if (!ev) return null
      if (ev.isGroup) {
        const gid = String(ev.groupId ?? '')
        if (/^\d{4,12}$/.test(gid)) return `group:${gid}`
        const m = /^group:(\d{4,12})$/.exec(String(ev.chatKey || ''))
        return m ? `group:${m[1]}` : null
      }
      const qq = String(ev.sender?.qq ?? '')
      if (/^\d{4,12}$/.test(qq)) return `private:${qq}`
      const m = /^private:(\d{4,12})$/.exec(String(ev.chatKey || ''))
      return m ? `private:${m[1]}` : null
    }
    /** 会话键 → 记忆文件路径（也是防路径穿越的唯一出入口：键里只允许数字） */
    const fileOfKey = (key) => {
      const k = String(key || '')
      const g = /^group:(\d{4,12})$/.exec(k)
      if (g) return path.join(dirOf(), `${g[1]}.md`)
      const pv = /^private:(\d{4,12})$/.exec(k)
      if (pv) return path.join(dirOf(), 'private', `${pv[1]}.md`)
      return null
    }
    /** 每个会话可以单独关掉记忆（不注入指针、不读、不积累）；已有记忆仍可查看/编辑。 */
    const mutedOf = (key) => {
      const list = Array.isArray(cfg.mutedChats) ? cfg.mutedChats.map(String) : []
      return list.includes(String(key || ''))
    }
    const fileOf = (gid) => fileOfKey(`group:${gid}`)

    /**
     * 读原文（只剥 BOM 与行尾记账注释，**不按 maxBytes 截断**）。
     * `stamp = mtimeMs:size`：文件没改就不重复读盘；改了（积累器/控制台写回）就自然换新版。
     *
     * ⚠️ 积累器必须用原文：它的「合并 → 整篇写回」如果拿截断后的文本当基准，
     *    超过 maxBytes 的尾部每轮都会丢（旧版的 bug，见读写口径分离）。
     */
    /** 允许传 `group:123` / `private:123` / 纯群号（旧调用），统一成文件路径 */
    const asKey = (k) => (/^(group|private):\d{4,12}$/.test(String(k || '')) ? String(k) : `group:${k}`)
    function loadRaw(keyOrGid) {
      const file = fileOfKey(asKey(keyOrGid)) // 键里只允许数字 → 不会有路径穿越
      if (!file) return null
      let st
      try { st = fs.statSync(file) } catch { return null } // 没文件 = 没记忆
      const stamp = `${st.mtimeMs}:${st.size}`
      const hit = rawCache.get(file)
      if (hit && hit.stamp === stamp) return hit
      let text
      try { text = stripBom(fs.readFileSync(file, 'utf8')) } catch { return null }
      // 剥掉条目尾部的记账注释（`<!-- n=3 ... -->`）：机器人不该看到记账信息，也省 token
      text = text.replace(/[ \t]*<!--[^>]*-->[ \t]*$/gm, '')
      const rec = { stamp, text, bytes: Buffer.byteLength(text, 'utf8') }
      rawCache.set(file, rec)
      return rec
    }

    /** 给积累器/备份用：不截断。 */
    function readRaw(key) {
      const r = loadRaw(key)
      return r ? { text: r.text, stamp: r.stamp, bytes: r.bytes } : null
    }

    /** 给模型用：按 maxBytes 截断（只影响进上下文的文本，不影响写盘基准）。 */
    function readMemory(key) {
      const r = loadRaw(key)
      if (!r) return null
      const text = clip(r.text).trim()
      return { text, stamp: r.stamp, clipped: text.length < r.text.trim().length, bytes: r.bytes }
    }

    // ── 入口 ①：before-turn 只推一行指针（首次 / 有更新；未变化 0 字符） ──────────
    bot.on('before-turn', (ev) => {
      if (cfg.enabled === false || !ev.wake) return // 没唤醒的消息不进模型，提示串也没用
      if (ev.wake.kind === 'welcome') return // 入群欢迎轮不该被"读记忆"的指针分心
      const key = chatKeyOf(ev)
      if (!key) return
      if (mutedOf(key)) { log.debug(`[记忆] ${key} 已单独关闭 → 不注入指针`); return }
      const mem = readMemory(key)
      if (!mem) return // 没记忆文件 = 什么都不加（积累器还没跑过）
      const isPrivate = key.startsWith('private:')
      const prev = getSeen(ev.chatKey)
      if (!prev) {
        setSeen(ev.chatKey, mem.stamp)
        ev.hint.push(isPrivate
          ? '[本私聊记忆: 调工具 read_memory 可看你和这个人的长期记忆（他的近况、说过的事、约定）；'
            + '第一次跟他聊建议先读一次。**认人只看 QQ 号**]'
          : '[本群记忆: 调工具 read_memory 可看本群的说话风格与群友画像；'
            + '第一次在本群回话前建议先读一次。**认人只看 QQ 号**（群友常换昵称，同一人换了名字仍是同一人）]')
        log.debug(`[记忆] ${key} 本会话首次 → 只给指针（${mem.text.length} 字不再贴正文）`)
      } else if (prev !== mem.stamp) {
        setSeen(ev.chatKey, mem.stamp)
        ev.hint.push(isPrivate ? '[本私聊记忆已更新，需要时调 read_memory 重读]' : '[本群记忆已更新，需要时调 read_memory 重读]')
        log.debug(`[记忆] ${key} 内容有更新 → 只给指针`)
      } else {
        log.debug(`[记忆] ${key} 未变化，本轮不提示`) // 0 字符
      }
    })

    /**
     * 把整篇群记忆压成「摘要视图」（L0/L1 思路，借自 OpenViking）：
     *   开场前言（两三行）+ 每个小节只给标题和首行。
     * 为什么需要：单群记忆会涨到 20KB，模型一眼读进来全是 token；
     *   而绝大多数时候它只想确认"这个群我记过什么、有没有这个人"，不需要每条细节。
     * 纯派生自现有文件 —— 不改沉淀 prompt、不额外调模型、不动数据格式。
     */
    function compactMemory(text, limit = 700) {
      const lines = String(text || '').split('\n')
      const preamble = []
      const sections = []
      let cur = null
      for (const line of lines) {
        const m = /^##\s+(.+?)\s*$/.exec(line)
        if (m) { cur = { title: m[1], first: '' }; sections.push(cur); continue }
        if (cur) {
          if (!cur.first && line.trim()) cur.first = line.trim()
        } else if (line.trim()) preamble.push(line.trim())
      }
      const out = []
      if (preamble.length) out.push(preamble.slice(0, 3).join('\n'))
      for (const sec of sections) {
        out.push(sec.first ? `## ${sec.title}\n${clipOne(sec.first, 80)}` : `## ${sec.title}`)
      }
      let s2 = out.join('\n')
      if (s2.length > limit) s2 = `${s2.slice(0, limit)}…`
      return { text: s2, sections: sections.length }
    }
    function clipOne(t, n) {
      const s0 = String(t || '')
      return s0.length > n ? `${s0.slice(0, n)}…` : s0
    }

    // ── 入口 ②：工具 read_memory（只读本群那一篇；群里没有文件权限，这是唯一的"翻记忆"路） ──
    bot.registerTool('read_memory', {
      description:
        '读本会话的长期记忆：群里是「这个群怎么把机器人叫起来、该怎么回话、群里每个人的特点」；'
        + '私聊是「你和这个人之间的事、他的近况与约定」。\n'
        + '这份记忆与人设解耦：里面提到机器人自己一律用「我」，不写人设。'
        + '**认人只看 QQ 号**：条目形如 `- **昵称(QQ)**：…`，群里的人常换昵称，同一个 QQ 换了名字仍是同一个人'
        + '（按 QQ 对上他，别当成新面孔）。第一次在本群回话前建议先读一次；同一会话读一次就够，'
        + '之后收到「本群记忆已更新」提示时再重读。只对群会话有效，读不到本群以外的任何文件。\n'
        + '**默认返回摘要视图**（每个小节只给标题+首行）：确认"记过什么、有没有这个人"够用了。'
        + '确实需要某条细节（比如某人的完整印象）时，再传 detail:true 读全文。',
      // DSH `defineTool` 的 parameters 是**扁平**的「属性名 → 值 schema」映射；required 写在属性上。
      parameters: {
        target: { type: 'string', required: true, description: '会话目标，形如 group:123456（通常填本轮会话，见开头 [QQ会话 …]）' },
        detail: { type: 'boolean', description: 'true = 返回全文（长，几百到上万字）；默认 false = 摘要视图（各小节标题+首行）' },
      },
      execute(args) {
        const target = String(args?.target || '')
        // 群、私聊都支持（私聊记忆 2026-11-12 摘自上游戏）：4–12 位纯数字顺手挡路径穿越
        const m = /^(group|private):(\d{4,12})$/.exec(target)
        if (!m) throw new Error('read_memory 的 target 形如 group:123456 或 private:123456')
        if (cfg.enabled === false) throw new Error('记忆读取已关闭')
        if (mutedOf(target)) throw new Error('这个会话的记忆被单独关掉了（设置里 🔕）')
        const gid = m[2]
        // 只读本群：拿本轮会话当边界。别的群号不可能是本轮 → 拒绝，别让这条路变成读别的群
        const turn = bot.currentTurn()
        // fail-closed：认不出本轮会话就拒绝（超长回合 currentTurn 可能是 null，
        // 旧写法 turn 为 null 时直接放行 → 模型传别的群号就能读任意群的记忆）
        if (!turn || !turn.chatKey) throw new Error('读不到本轮会话，暂时不能读群记忆（请在本群回话时再读）')
        if (turn.chatKey !== target) {
          throw new Error(`只能读本群记忆（本轮会话是 ${turn.chatKey}，不是 ${target}）`)
        }
        const mem = readMemory(target)
        if (!mem) return { ok: true, target, memory: '', hint: '这个会话还没有记忆文件（积累器还没跑过）' }
        const wantDetail = args?.detail === true
        if (!wantDetail) {
          const cv = compactMemory(mem.text)
          log.info(`[群记忆] 自读(摘要) ${gid} → ${cv.text.length} 字 / 全文 ${mem.text.length} 字 / ${cv.sections} 节`)
          // 超限信息在两种模式下都要报：摘要视图也要让人知道"原文其实更大、被截过"
          const clipNote = mem.clipped
            ? `⚠️ 记忆原文 ${mem.bytes} 字节，超过读取上限 ${mem.text.length} 字，已按整行截断；` 
            : ''
          return {
            ok: true, target, group_id: gid, mode: 'summary',
            chars: cv.text.length, full_chars: mem.text.length, sections: cv.sections,
            ...(mem.clipped ? { clipped: true } : {}),
            memory: cv.text,
            hint: `${clipNote}这是摘要视图（各小节只给首行）。需要某人的完整印象或某条细节时，再调一次 read_memory 并传 detail:true 读全文。`,
          }
        }
        log.info(`[群记忆] 自读(全文) ${gid} → ${mem.text.length} 字${mem.clipped ? '（已按上限截断）' : ''}`)
        return {
          ok: true, target, group_id: gid, mode: 'full', chars: mem.text.length, memory: mem.text,
          ...(mem.clipped ? { clipped: true, hint: `记忆原文 ${mem.bytes} 字节，超过读取上限，已按整行截断；需要完整内容请让人在控制台调大 maxBytes 或精简文件` } : {}),
        }
      },
    })

    // ── 入口 ③：工具 memory_append（只给积累后台任务用；结构化提交，替代 `<<<GROUP>>>` 文本解析）──
    // 内核的工具守卫只允许「群记忆积累后台会话」调用它；普通 QQ 会话调会被拒。
    bot.registerTool('memory_append', {
      description:
        '群记忆积累**后台任务专用**：把从最近聊天里提炼出的「新增要点」按群提交，插件会去重后合并进该群记忆文件'
        + '（群聊会话调不到、也不需要它）。每个群调一次：group_id = 群号；points = 新增要点 Markdown 列表行；'
        + '没有值得记的写「（无新增）」。调用成功后不要再重复提交同一个群。',
      parameters: {
        group_id: { type: 'string', required: true, description: '群号（prompt 里【群 号码】的号码，原样抄）' },
        points: { type: 'string', required: true, description: '本群新增要点：Markdown 列表行（- **昵称(QQ)**：… / - 风格：… / - 其它：…）；没有新增写「（无新增）」' },
      },
      execute(args, exec) {
        const submit = bot.shared.memoryAccumulateSubmit
        if (typeof submit !== 'function') throw new Error('群记忆积累器未启用，无法提交')
        return submit(args, exec)
      },
    })

    // ── 积累侧：实现拆在同目录 accumulate.js（同一子插件、同一组配置），这里只负责接线 ──
    const accumulator = createAccumulator({
      bot,
      cfg,
      log,
      dataDirOf,
      memoryDirOf: dirOf,
      readMemoryOf: readRaw,
      invalidateMemoryOf: (key) => rawCache.delete(fileOfKey(asKey(key))),
      maxBytesOf,
      mutedOf,
    })
    bot.shared.memoryAccumulate = accumulator.manual
    bot.shared.memoryAccumulateStatus = accumulator.status
    bot.shared.memoryAccumulateSync = accumulator.sync
    bot.shared.memoryAccumulateSubmit = accumulator.submit
    bot.shared.memoryAccumulateStop = accumulator.stop
    bot.shared.memoryAccumulateTickIdle = accumulator.tickIdle   // 测试/控制台：手动跑一次「聊完沉淀」扫描
    accumulator.start()
    // fiber 卸载时清掉 60s 定时器：旧版 start() 的 timer 直接丢弃，内核 dispose 也不清，
    // 插件重载会叠出第二个定时器。onDispose 是内核的新能力，老内核没有 → 可选调用。
    try { bot.onDispose?.(() => { try { accumulator.stop() } catch { /* ignore */ } }) } catch { /* ignore */ }
  },
}
