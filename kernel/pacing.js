import fs from 'node:fs'
/**
 * kernel/pacing.js — 回复节奏：**静默合批** + **主动接话**。
 *
 * 一块是时间维度、一块是"要不要自己开口"，都只有内核知道：
 *   · 合批：同群几百毫秒内的多条**被叫**消息并成一​轮（省 token，也更像"等别人说完"）
 *   · 主动接话：没人叫也偶尔接一句。一次"机会"= 最多一轮模型调用；
 *     到点后等一个**合适的时机**（按语境打分），拿不到就放弃这一次，绝不硬凑。
 *     命中后发一条**候选入站**给模型，由模型自己判断接不接（不调发送工具 = 不接）。
 *
 * 纪律：
 *   · 本模块**不发消息**（出站只有 deliver，由内核那一侧负责），也不碰 prompt。
 *   · 参数全部来自实例配置的 `pacing.reply` / `pacing.merge`（控制台可改，热生效）。
 *   · 主动接话轮 `wake.kind='proactive'`，出站强制不 @ 不引用（内核 decorate 钩子硬挡）。
 *   · **默认不启用主动接话**（配置里 `pacing.reply.enabled` 默认 false）：不启用时不装调度定时器、
 *     也不起念；只有显式开启后才 start/apply 起来。
 *
 * 频率口径（控制台/文档只认这一种，别再搞第二套算法）：
 *   相邻两次机会至少间隔 `minGapMs`；同时 3600s ÷ `hourlyMax` 也是间隔下限 →
 *   实际间隔 = max(minGapMs, 3600s/hourlyMax)，所以"每小时最多 N 次"是**硬上限**。
 */

const HOUR = 3600000
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const log1p = (v) => Math.log1p(Math.max(0, Number(v) || 0))

/** 主动接话默认参数：配置缺键时用它（与 config-store v2 的默认配置对齐，改默认值只改这里） */
export const REPLY_DEFAULTS = {
  enabled: false,            // 默认关：不装调度、不起念
  hourlyMax: 6,              // 每小时最多几次"机会"（0 = 关）
  minGapMs: 480000,          // 两次机会最小间隔（8 分钟）
  coldSilenceMs: 180000,     // 群安静多久算冷场（3 分钟）
  /**
   * 免打扰（她自己的作息）：只拦「冷场找话」，不拦正常回话，也不拦"群里正有人聊"的接话。
   * 为什么不是死钟点：主人要的是"她可以熬夜、也可以不熬夜" ——
   *   · 基线窗口 = 她平时的睡点/醒点（下面 start/end，本地时间）；
   *   · 每天按日期**确定性地**抖一次（jitterMin），所以有时两点才睡、有时十二点就睡了；
   *   · 周末再整体后移（weekendShiftMin），周末熬夜。
   *   · 夜里群里有人说话 → 她照样能接（熬夜陪着）；没人说话才安静（去睡）。
   */
  /**
   * 私聊主动聊天：允许她主动给这些 QQ 发消息（留空 = 不主动私聊任何人）。
   * 比群里更克制：默认 6 小时没说话才想起一次，睡觉时不发（跟着同一个作息）。
   */
  privateAllow: [],
  privateColdHours: 6,      // 私聊安静多久才会主动开口
  privateColdJitterMin: 30, // 这个门槛的随机抖动（±N 分钟）：免得每次都卡在同一分钟想起他
  /**
   * 自主起念 / 自主醒来：她有**自己的**兴趣和念头，不是只等调度器安排。
   *   · 兴趣画像（话题/人 + 好感分）由她自己用 interest_note 工具记；
   *   · 清醒时偶尔"突然想聊点什么/想找谁说话" → 按她的兴趣选目标；
   *   · 睡着时有小概率半夜醒来（像人半夜睡不着刷手机），醒一会儿再睡。
   */
  desire: {
    enabled: true,
    minGapMin: 150,         // 两次"自己想起话"至少隔多久
    hourlyMax: 1,           // 每小时最多几次
    nightWakePct: 12,       // 每晚"半夜醒来"的概率（%）
    awakeMinMin: 20,        // 夜里醒来至少清醒多久
    awakeMaxMin: 60,        // 最多清醒多久
  },
  quiet: {
    enabled: true,
    wakeOnCall: true,        // 睡着时有人叫也不回（攒着，醒了再逐条回）
    bedtimeGraceMin: 30,     // 睡点前这段她还醒着：会回，但带困意
    start: '01:30',          // 基线睡点（本地时间）
    end: '09:30',            // 基线醒点（本地时间）
    jitterMin: 90,           // 每天在基线上随机前后抖多少分钟（0 = 不抖，固定钟点）
    weekendShiftMin: 60,     // 周六/周日整体后移多少分钟（熬夜）
  },
  silenceEnabled: true,      // 冷场找话：关 = 只在群里有新消息时才可能接话（不定时找话）
  topicWindowMs: 600000,     // 机会窗口：到点后再等多久的合适时机（10 分钟）
  repeatEnabled: true,       // 复读机：群里在刷同一句话时，跟着刷一句一模一样的
  repeatMin: 3,              // 连着几个人说同一句，才跟着复读
  repeatWindowMin: 3,        // 这些重复要发生在多少分钟内
  repeatCooldownMin: 10,     // 复读冷却（同一个群）
  // 按群覆盖上面这些参数：{ "群号": { hourlyMax, minGapMs, sensitivity, repeatEnabled, repeatMin, ... } }
  // 没写的字段沿用全局值
  groupOverrides: {},
  // 按时间段覆盖（例如白天少、晚上多）：[{ from:'09:00', to:'18:00', hourlyMax:1, sensitivity:0.8 }, ...]
  // 跨零点写法：from '22:00' to '02:00'。优先级：群覆盖 > 时间段 > 全局
  timeProfiles: [],
  topicMinMsgs: 3,           // 窗口内至少几条消息才按"话题"挑时机（防单条消息就接）
  sensitivity: 0.45,         // 语境敏感度 0~1（越高越挑"值得接"的时机）
  maxChars: 140,             // 主动接话单条字数上限（提示用；超了照发但记日志）
  groups: [],                // 允许主动接话的群号（数组或 {"群号": true} 对象都认）
  // ── 连续对话（摘自上游戏 2026-10-27）─────────────────────────────────
  // 真人叫过她、她也回过话之后，隔一会儿把这期间的新消息塞回模型再判一次"要不要补一句"。
  // 判据复用主动接话那 9 个权重 + bonus，不另起一套；默认关。
  continuation: {
    enabled: false,
    delayMs: 120000,        // 回完话后等多久再检查（2 分钟）
    bonus: 1.5,             // 续聊分 = sigmoid(主动接话 logit + bonus)
    hourlyMax: 5,           // 每群每小时最多续几次
    minGapMs: 300000,       // 两次续聊最小间隔
    maxPerChain: 1,         // 一次唤醒最多检查几次（1 = 补一次就收手，防自转）
    requireNewMessage: true,// 她回完之后必须有人类新消息才检查
    quoteLastHuman: false,  // 续聊是否引用最后一条人类消息
  },
  style: {
    splitEnabled: true,
    splitProbability: 0.5,   // 拆条概率（0~1）
    splitMinLen: 12,
    splitDelayMs: 1000,
    stickerEnabled: true,
    stickerProbability: 0.8, // 表情包概率（0~1）
  },
  weights: {                 // 语境权重（MaiBot 日志拟合值；一般不用动，改「语境敏感度」就够了）
    intercept: -1.2005,
    mentionBot: 1.5852,
    atOther: -1.1157,
    hasQuestion: 0.4807,
    placeholderOnly: -1.0281,
    selfRatio: 2.6525,
    recentCount: -0.0367,
    logSecondsSinceBot: 0.0571,
    pendingCount: 0.1012,
  },
}

/** 合批默认参数（与 config-store v2 的默认配置对齐） */
export const MERGE_DEFAULTS = {
  enabled: true,
  windowMs: 2000,         // 冷清时（上一条隔了很久）窗口 —— 单条提问要快
  windowActiveMs: 4000,   // 对话进行中（上一条 ≤ activeGapMs）等更久，收得住连发
  activeGapMs: 15000,     // 距上一条 ≤ 这么多毫秒 = 还在同一个对话里
  maxWaitMs: 6000,        // 硬上限：一群人刷屏时也必须发车
  skipIfSlowMs: 30000,    // 距上一条 > 这么多 = 不是连发，直接回答（**私聊不适用**）
  privateWindowMs: 3000,  // 私聊 debounce 窗口：他安静这么久就发车（比群里短，回得更跟手）
}

/** 兴趣分：把一条群消息按权重算成 0~1 的"值得接吗"（纯函数，自检直接用） */
export function scoreFeatures(f = {}, weights = REPLY_DEFAULTS.weights) {
  const w = { ...REPLY_DEFAULTS.weights, ...(weights || {}) }
  const logit = num(w.intercept, -1.2)
    + num(w.mentionBot, 0) * (f.mentionBot ? 1 : 0)
    + num(w.atOther, 0) * (f.atOther ? 1 : 0)
    + num(w.hasQuestion, 0) * (f.hasQuestion ? 1 : 0)
    + num(w.placeholderOnly, 0) * (f.placeholderOnly ? 1 : 0)
    + num(w.selfRatio, 0) * clamp01(f.selfRatio)
    + num(w.recentCount, 0) * Math.max(0, num(f.recentCount, 0))
    + num(w.logSecondsSinceBot, 0) * log1p(f.secondsSinceBot)
    + num(w.pendingCount, 0) * Math.max(0, num(f.pendingCount, 0))
  const p = 1 / (1 + Math.exp(-logit))
  return { score: p, logit }
}

/** 语境敏感度 → 触发门槛：0% = 0.15（几乎来什么接什么）；50% = 0.50；100% = 0.85（很挑） */
export function thresholdForSensitivity(sensitivity) {
  return Math.max(0, Math.min(0.95, 0.15 + 0.7 * clamp01(sensitivity)))
}

/** 时间段里允许覆盖的字段（= 主动接话的所有节奏参数） */
export const TIME_PROFILE_FIELDS = [
  'hourlyMax', 'minGapMs', 'topicWindowMs', 'topicMinMsgs', 'sensitivity',
  'coldSilenceMs', 'silenceEnabled', 'repeatEnabled', 'repeatMin',
  'repeatWindowMin', 'repeatCooldownMin', 'maxChars',
]

/** 'H:M' / 'HH:MM' / '9' → 一天里的分钟数；不合法返回 null */
export function normalizeHm(v) {
  if (v == null) return null
  const m = /^\s*(\d{1,2})\s*[:：]?\s*(\d{1,2})?\s*$/.exec(String(v))
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2] || 0)
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 24 || mi > 59) return null
  if (h === 24 && mi > 0) return null
  return (h % 24) * 60 + mi
}

/** 一天中的分钟数（本地时区） */
export function minutesOfDay(date) {
  const d = date instanceof Date ? date : new Date(Number(date) || Date.now())
  return d.getHours() * 60 + d.getMinutes()
}

/** 把 Date / {dow,dom,month} 归一成 { dow:0-6(周日=0), dom:1-31, month:1-12 } */
export function normalizeWhen(when) {
  if (when instanceof Date) {
    return { dow: when.getDay(), dom: when.getDate(), month: when.getMonth() + 1 }
  }
  const w = when && typeof when === 'object' ? when : {}
  return {
    dow: Number.isFinite(Number(w.dow)) ? Number(w.dow) : null,
    dom: Number.isFinite(Number(w.dom)) ? Number(w.dom) : null,
    month: Number.isFinite(Number(w.month)) ? Number(w.month) : null,
  }
}

/**
 * 挑出当前时刻命中的时间段（支持跨零点 + 星期/日期/月份过滤；先命中先用）。
 * 条目里 `days`（0=周日…6=周六）、`dates`（每月几号）、`months`（1~12）都是可选过滤器，
 * 不写就不限；写了必须命中。
 * @param {Array<{from:number,to:number,days?:number[],dates?:number[],months?:number[]}>} profiles
 * @param {number} min 当前分钟数
 * @param {Date|{dow:number,dom:number,month:number}} [when] 日期上下文（不传则不筛星期/日期/月份）
 * @returns {object} 命中的那段，没命中返回 {}
 */
/** 把 {dow,dom,month} 往前挪一天（跨天时段「算开始那天」要用昨天的星期/日期）。 */
function shiftWhenBackOneDay(w, when) {
  if (!w) return w
  if (when instanceof Date) {
    const d = new Date(when.getTime() - 86400000)
    return { dow: d.getDay(), dom: d.getDate(), month: d.getMonth() + 1 }
  }
  if (w.dom != null) {
    // 只有数字时只能退化处理：日期/月份减一（跨月不精确，仅当调用方没给 Date 时发生）
    const dom = Number(w.dom) - 1
    const month = dom >= 1 ? Number(w.month) : (Number(w.month) > 1 ? Number(w.month) - 1 : 12)
    return { dow: w.dow == null ? null : (Number(w.dow) + 6) % 7, dom: dom >= 1 ? dom : 31, month }
  }
  return { dow: w.dow == null ? null : (Number(w.dow) + 6) % 7, dom: null, month: w.month == null ? null : Number(w.month) }
}

/**
 * 挑出当前时刻命中的时间段（支持跨零点 + 星期/日期/月份过滤；先命中先用）。
 * 条目里 `days`（0=周日…6=周六）、`dates`（每月几号）、`months`（1~12）都是可选过滤器，
 * 不写就不限；写了必须命中。
 *
 * 跨零点（from > to）有**两种星期语义**：
 *   · 默认（`ownStartDay` 不为 true）：星期/日期/月份按**当前这一天**判。
 *     于是 `22:00~02:00` + 勾「周五」= 周五 22:00~23:59 和 周五 00:00~01:59（后者其实是周四晚的尾巴）。
 *   · `ownStartDay: true`：尾巴（00:00~to）按**前一天**判。
 *     于是 `22:00~02:00` + 勾「周五」= 周五 22:00 一直到**周六 02:00**，正是"周五晚上的整段"。
 * @param {Array<{from:number,to:number,days?:number[],dates?:number[],months?:number[],ownStartDay?:boolean}>} profiles
 * @param {number} min 当前分钟数
 * @param {Date|{dow:number,dom:number,month:number}} [when] 日期上下文（不传则不筛星期/日期/月份）
 * @returns {object} 命中的那段，没命中返回 {}
 */
export function pickTimeProfile(profiles, min, when = null) {
  if (!Array.isArray(profiles) || !profiles.length) return {}
  const now = Number(min)
  if (!Number.isFinite(now)) return {}
  const w = when == null ? null : normalizeWhen(when)
  for (const p of profiles) {
    const from = Number(p.from)
    const to = Number(p.to)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    const cross = from !== to && from > to
    const inTail = cross && now < to            // 落在"次日凌晨"那一截
    const hit = from === to ? true : (from < to ? (now >= from && now < to) : (now >= from || inTail))
    if (!hit) continue
    if (w) {
      // 跨天 + 勾了「算在开始那天」→ 尾巴用昨天的星期/日期/月份判
      const ww = (inTail && p.ownStartDay === true) ? shiftWhenBackOneDay(w, when) : w
      if (Array.isArray(p.days) && p.days.length && ww.dow != null && !p.days.includes(ww.dow)) continue
      if (Array.isArray(p.dates) && p.dates.length && ww.dom != null && !p.dates.includes(ww.dom)) continue
      if (Array.isArray(p.months) && p.months.length && ww.month != null && !p.months.includes(ww.month)) continue
    }
    return p
  }
  return {}
}

/**
 * 算一段时段在**一周里实际覆盖哪些窗口**（给控制台显示"实际覆盖"用）。
 * 返回 [{ dow, from, to }]，dow = 0(周日)…6(周六)，from/to 是分钟数（to 可能 ≤ from 表示跨到次日，已拆成两段）。
 * 说明：只算"这一段自己"的覆盖，不含其它时段。
 */
export function profileCoverage(p, { ownStartDayOverride = null } = {}) {
  const from = Number(p?.from)
  const to = Number(p?.to)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return []
  if (from < 0 || from > 1439 || to < 0 || to > 1439) return []   // 非法时间不参与覆盖计算
  const ownStart = ownStartDayOverride == null ? p?.ownStartDay === true : ownStartDayOverride === true
  const days = Array.isArray(p?.days) && p.days.length ? [...new Set(p.days.map(Number))].filter((d) => d >= 0 && d <= 6) : [0, 1, 2, 3, 4, 5, 6]
  const out = []
  if (from === to) { for (const d of days) out.push({ dow: d, from: 0, to: 1440 }); return out }
  if (from < to) { for (const d of days) out.push({ dow: d, from, to }); return out }
  // 跨零点
  for (const d of days) {
    out.push({ dow: d, from, to: 1440 })                                  // 当天的晚上那截
    const tailDay = ownStart ? (d + 1) % 7 : d                            // 尾巴算哪天
    out.push({ dow: tailDay, from: 0, to })
  }
  return out
}

/** 把 days/dates/months 这类过滤器归一成数字数组（去重、去非法值） */
export function normalizeFilterList(v, lo, hi) {
  if (v == null) return undefined
  const arr = Array.isArray(v) ? v : String(v).split(/[,，\s]+/)
  const out = []
  for (const x of arr) {
    const t = String(x).trim()
    if (!t) continue
    const n = Number(t)
    if (!Number.isInteger(n) || n < lo || n > hi) continue
    if (!out.includes(n)) out.push(n)
  }
  return out.length ? out : undefined
}

/** 把实例配置的 `pacing` 段归一成"每块都齐全"的配置（数组/对象两种群号写法都认） */
function normalize(rawPacing) {
  const p = rawPacing && typeof rawPacing === 'object' ? rawPacing : {}
  const r = p.reply && typeof p.reply === 'object' ? p.reply : {}
  const style = r.style && typeof r.style === 'object' ? r.style : {}
  const weights = r.weights && typeof r.weights === 'object' ? r.weights : {}
  const groups = {}
  if (Array.isArray(r.groups)) {
    for (const g of r.groups) if (String(g || '').trim()) groups[String(g).trim()] = true
  } else if (r.groups && typeof r.groups === 'object') {
    for (const [g, on] of Object.entries(r.groups)) if (on === true) groups[String(g)] = true
  }
  const m = p.merge && typeof p.merge === 'object' ? p.merge : {}
  // 按群覆盖：只收对象；值保持原样（用的时候才做数字/布尔归一）
  const groupOverrides = {}
  if (r.groupOverrides && typeof r.groupOverrides === 'object' && !Array.isArray(r.groupOverrides)) {
    for (const [gid, ov] of Object.entries(r.groupOverrides)) {
      const g = String(gid || '').trim()
      if (!/^\d{4,12}$/.test(g) || !ov || typeof ov !== 'object' || Array.isArray(ov)) continue
      const copy = { ...ov }
      if (Array.isArray(copy.timeProfiles)) {
        const arr = []
        for (const raw of copy.timeProfiles) {
          if (!raw || typeof raw !== 'object') continue
          const from = normalizeHm(raw.from)
          const to = normalizeHm(raw.to)
          if (from == null || to == null) continue
          const entry = { from, to }
          for (const k of TIME_PROFILE_FIELDS) if (raw[k] !== undefined) entry[k] = raw[k]
          const days = normalizeFilterList(raw.days, 0, 6)
          const dates = normalizeFilterList(raw.dates, 1, 31)
          const months = normalizeFilterList(raw.months, 1, 12)
          if (days) entry.days = days
          if (dates) entry.dates = dates
          if (months) entry.months = months
          arr.push(entry)
        }
        copy.timeProfiles = arr
      } else {
        delete copy.timeProfiles
      }
      groupOverrides[g] = copy
    }
  }

  // 时间段覆盖：{from:'HH:MM', to:'HH:MM', 任意 reply 字段}
  const timeProfiles = []
  if (Array.isArray(r.timeProfiles)) {
    for (const raw of r.timeProfiles) {
      if (!raw || typeof raw !== 'object') continue
      const from = normalizeHm(raw.from)
      const to = normalizeHm(raw.to)
      if (from == null || to == null) continue
      const entry = { from, to }
      for (const k of TIME_PROFILE_FIELDS) if (raw[k] !== undefined) entry[k] = raw[k]
      const days = normalizeFilterList(raw.days, 0, 6)
      const dates = normalizeFilterList(raw.dates, 1, 31)
      const months = normalizeFilterList(raw.months, 1, 12)
      if (days) entry.days = days
      if (dates) entry.dates = dates
      if (months) entry.months = months
      timeProfiles.push(entry)
    }
  }

  return {
    reply: {
      ...REPLY_DEFAULTS,
      ...Object.fromEntries(Object.entries(r).filter(([k]) => !['style', 'weights', 'groups'].includes(k))),
      continuation: { ...REPLY_DEFAULTS.continuation, ...(r.continuation && typeof r.continuation === 'object' ? r.continuation : {}) },
      style: { ...REPLY_DEFAULTS.style, ...style },
      weights: { ...REPLY_DEFAULTS.weights, ...weights },
      groups,
      groupOverrides,
      timeProfiles,
    },
    merge: { ...MERGE_DEFAULTS, ...m },
  }
}

/**
 * @param {{log?: object, state: object}} deps
 *   state — ChatState（用它的 map / get()，不新开一套会话状态）
 */
export function createPacing({ log = console, state, clock = null, stateDir = '' }) {
  // clock：自检用（可传函数/对象把"现在"钉住）；运行时一律真实时间
  const nowMs = () => {
    const v = typeof clock === 'function' ? Number(clock()) : (clock && typeof clock.now === 'function' ? Number(clock.now()) : NaN)
    return Number.isFinite(v) ? v : Date.now()
  }
  let cfg = normalize(null)
  let lastLogged = ''
  let timer = null
  let onProactiveTurn = null
  // 梦境情绪残留：{ day:'YYYY-MM-DD', penalty:0|1 } —— 只影响"主动找话"的上限，不动人格与回复
  let moodPenalty = { day: '', penalty: 0 }
  let onRepeat = null
  let isBusy = () => false

  // ── 合批 ────────────────────────────────────────────────────
  const pending = new Map()  // chatKey → { evs, firstAt, timer, run }
  const inbound = new Map()  // chatKey → [ts…]（最近 20 条入站，合批判"慢群"用）
  const outbound = new Map() // chatKey → [ts…]（最近 20 条出站，算"自己发言占比"）

  // ── 主动接话 ────────────────────────────────────────────────
  const rings = new Map()    // chatKey → [{ ts, text, mentionBot, atOther, hasQuestion, placeholderOnly, short }]
  const opp = new Map()      // chatKey → { dueAt, windowUntil, fired, missed }
  const fired = []           // 最近主动接话事件 [{ at, chatKey, gid, reason, score, sent }]
  const lastRepeat = new Map() // chatKey → ts（复读冷却）
  const MAX_RING = 60
  const RING_TTL = 30 * 60000

  function pushRing(map, key, ts, max = 20) {
    const list = map.get(key) || []
    list.push(ts)
    while (list.length > max) list.shift()
    map.set(key, list)
  }

  /** 当前生效的群集合（Set<群号字符串>） */
  function allowedGroups() {
    return new Set(Object.keys(cfg.reply.groups || {}))
  }

  // ── 按群覆盖：某个群的生效配置 = 全局值 + 该群 groupOverrides ──────────
  const gidOfKey = (chatKey) => String(chatKey || '').replace(/^group:/, '')
  /** 当前命中的时间段（群的优先，没有就用全局的） */
  function currentProfile(chatKey = '') {
    const at = new Date(nowMs())
    const now = minutesOfDay(at)
    const ov = (cfg.reply.groupOverrides || {})[gidOfKey(chatKey)]
    if (ov && Array.isArray(ov.timeProfiles) && ov.timeProfiles.length) {
      const gp = pickTimeProfile(ov.timeProfiles, now, at)
      if (gp && Object.keys(gp).length) return gp
    }
    return pickTimeProfile(cfg.reply.timeProfiles || [], now, at)
  }

  /**
   * 四层取值（从最具体到最笼统）：
   *   ① 该群自己的时段表  ② 该群的固定覆盖  ③ 全局时段表  ④ 全局值
   */
  function layered(chatKey, field) {
    const at = new Date(nowMs())
    const now = minutesOfDay(at)
    const ov = (cfg.reply.groupOverrides || {})[gidOfKey(chatKey)]
    if (ov) {
      if (Array.isArray(ov.timeProfiles) && ov.timeProfiles.length) {
        const gp = pickTimeProfile(ov.timeProfiles, now, at)
        if (gp && gp[field] !== undefined) return gp[field]
      }
      if (ov[field] !== undefined) return ov[field]
    }
    const prof = pickTimeProfile(cfg.reply.timeProfiles || [], now, at)
    if (prof && prof[field] !== undefined) return prof[field]
    return cfg.reply[field]
  }

  /** 取某群生效的 reply 字段值（数字） */
  function rnum(chatKey, field, dflt) {
    return num(layered(chatKey, field), dflt)
  }
  /** 取某群生效的布尔字段（未设置时用 dflt） */
  function rbool(chatKey, field, dflt = true) {
    const v = layered(chatKey, field)
    return v === undefined ? dflt : v !== false
  }

  /** 写一条进"最近群消息环"（只收允许主动接话的群；自检也用它造样本） */
  function remember(ev) {
    const key = String(ev?.chatKey ?? '')
    if (!key || !ev?.isGroup) return
    const gid = String(ev.groupId ?? key.replace(/^group:/, ''))
    if (!allowedGroups().has(gid)) return
    const now = Number(ev.time) > 0 ? Number(ev.time) : nowMs()
    const text = String(ev.text || '')
    const list = rings.get(key) || []
    list.push({
      ts: now,
      id: ev.messageId ?? null,
      text: text.slice(0, 200),
      mentionBot: !!ev.mentionedSelf,
      atOther: /@\d{4,}/.test(text),
      hasQuestion: /[?？]/.test(text),
      placeholderOnly: /^\s*\[(表情包|图片|语音|文件|卡片)/.test(text),
      short: text.replace(/[\s\p{P}\p{S}]/gu, '').length < 4,
    })
    while (list.length > MAX_RING) list.shift()
    while (list.length && now - list[0].ts > RING_TTL) list.shift()
    rings.set(key, list)
  }

  /** 记录一条入站（内核在最前面调；必须在管线之前） */
  function noteInbound(ev) {
    const key = String(ev?.chatKey ?? '')
    if (!key) return
    const ts = Number(ev.time) > 0 ? Number(ev.time) : nowMs()
    const st = state.get(key)
    st.lastInboundAt = ts
    // 有人说话了 → 之前"她自言自语没人接"的计数清零（退避解除）
    if (Number(st.proactiveUnanswered) > 0) st.proactiveUnanswered = 0
    pushRing(inbound, key, ts)
    remember(ev)
  }

  /** 记录一条出站（内核的 afterSend 调；用于"自己发言占比"） */
  function noteOutbound(target) {
    const key = String(target ?? '')
    if (!key) return
    pushRing(outbound, key, nowMs())
  }

  /** 主动接话轮里真的发出了一条 → 记在最近事件上（控制台"最近"里显示已接） */
  function markSent(chatKey) {
    for (let i = fired.length - 1; i >= 0; i -= 1) {
      if (fired[i].chatKey === chatKey && !fired[i].sent && nowMs() - fired[i].at < 10 * 60000) {
        fired[i].sent = true
        return
      }
    }
  }

  function hourIntervalMs(chatKey = '') {
    const n = Math.max(0, rnum(chatKey, 'hourlyMax', 0))
    return n > 0 ? HOUR / n : Infinity
  }

  function opportunityGapMs(chatKey = '') {
    return Math.max(rnum(chatKey, 'minGapMs', 900000), hourIntervalMs(chatKey))
  }

  /** 某群的"下一次机会"状态（懒创建；开机后第一次随机错开，避免重启瞬间一起开口） */
  function oppOf(chatKey) {
    let o = opp.get(chatKey)
    if (!o) {
      const gap = opportunityGapMs(chatKey)
      const wait = Number.isFinite(gap) ? gap * (0.4 + Math.random() * 0.6) : Infinity
      o = { dueAt: Number.isFinite(wait) ? nowMs() + wait : Infinity, windowUntil: 0, fired: 0, missed: 0 }
      opp.set(chatKey, o)
    }
    return o
  }

  /** 从宿主事件/环算兴趣分（给自检与日志看；也供外部插件调用） */
  function interestFor(ev = {}) {
    const key = String(ev.chatKey ?? '')
    const st = key ? state.get(key) : { lastSendAt: 0 }
    const now = nowMs()
    const list = (rings.get(key) || []).filter((m) => now - m.ts < 5 * 60000)
    const recentOut = (outbound.get(key) || []).filter((t) => now - t < 5 * 60000)
    const total = list.length + recentOut.length
    const features = {
      mentionBot: !!ev.mentionedSelf,
      atOther: /@\d{4,}/.test(String(ev.text ?? '')),
      hasQuestion: /[?？]/.test(String(ev.text ?? '')),
      placeholderOnly: /^\s*\[(表情包|图片|语音|文件|卡片)/.test(String(ev.text ?? '')),
      selfRatio: total > 0 ? recentOut.length / total : 0,
      recentCount: list.length,
      secondsSinceBot: (now - Number(st.lastSendAt || 0)) / 1000,
      pendingCount: isBusy(key) ? 1 : 0,
    }
    return { ...scoreFeatures(features, cfg.reply.weights), features }
  }

  /** 到点后进入"窗口"；窗口过期 = 这次机会作废（宁可少说，不硬凑） */
  function ensureWindow(chatKey, now) {
    const o = oppOf(chatKey)
    if (now < o.dueAt) return null
    if (!o.windowUntil) o.windowUntil = now + Math.max(60000, rnum(chatKey, 'topicWindowMs', 600000))
    if (now > o.windowUntil) {
      o.windowUntil = 0
      o.dueAt = now + opportunityGapMs(chatKey)
      o.missed += 1
      log.info(`[主动接话] ${chatKey} 本次没有合适时机，放弃（下次约 ${Math.round(opportunityGapMs(chatKey) / 60000)} 分钟后）`)
      return null
    }
    return o
  }

  /** 真正起一轮主动接话：先记账（防止模型/失败反复触发），再交给内核起回合 */
  function fire(chatKey, gid, reason, score, extra = null) {
    const o = oppOf(chatKey)
    const now = nowMs()
    o.windowUntil = 0
    o.dueAt = now + opportunityGapMs(chatKey)
    o.fired += 1
    fired.push({ at: now, chatKey, gid, reason, score: Number(score) || 0, sent: false })
    while (fired.length > 30) fired.shift()
    const why = reason === 'silence' ? '冷场找话'
      : reason === 'private-silence' ? '私聊想起他'
      : reason === 'continuation' ? '续聊' : '话题合适'
    log.info(`[主动接话] ${chatKey} 起念（${why}，兴趣分 ${(Number(score) * 100).toFixed(0)}%）`)
    if (typeof onProactiveTurn !== 'function') return
    Promise.resolve()
      .then(() => onProactiveTurn({ chatKey, groupId: gid, reason, score, ...(extra || {}) }))
      .catch((e) => log.error(`[主动接话] 起回合失败 ${chatKey}: ${e.stack || e.message}`))
  }

  /** 归一化一句话用于比对：去空白/全角空格/常见标点尾巴。 */
  function normRepeat(t) {
    return String(t || '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[。！？!?…~〜]+$/g, '')
      .toLowerCase()
  }

  /**
   * 复读机：最近窗口里有多少条消息跟这句一模一样（含刚进来的这条）。
   * 命中且不在冷却里 → 调 onRepeat 让内核原样发出去，返回 true（这轮不再走模型）。
   */
  function tryRepeat(chatKey, gid, text, now) {
    if (!rbool(chatKey, 'repeatEnabled', true)) return false
    const want = normRepeat(text)
    if (want.length < 4) return false                    // 太短不玩（「？」「好」）
    if (/^\[(表情|图片|视频|语音|文件)/.test(String(text || ''))) return false

    const windowMs = Math.max(30000, rnum(chatKey, 'repeatWindowMin', 3) * 60000)
    const list = (rings.get(chatKey) || []).filter((m) => now - m.ts < windowMs)
    // 当前这条已经在 rings 里了（noteInbound 先于 consider），所以直接数
    const same = list.filter((m) => !m.placeholderOnly && !m.short && normRepeat(m.text) === want)
    const count = same.length
    const need = Math.max(2, rnum(chatKey, 'repeatMin', 3))
    if (count < need) return false

    const cdMs = Math.max(60000, rnum(chatKey, 'repeatCooldownMin', 10) * 60000)
    const last = Number(lastRepeat.get(chatKey) || 0)
    if (now - last < cdMs) return false
    if (typeof onRepeat !== 'function') return false

    lastRepeat.set(chatKey, now)
    fired.push({ at: now, chatKey, gid, reason: 'repeat', score: 1, sent: true })
    while (fired.length > 30) fired.shift()
    const o = oppOf(chatKey)
    o.dueAt = now + opportunityGapMs()
    log.info(`[复读机] ${chatKey} 连着 ${count} 人刷同一句 → 跟着复读`)
    Promise.resolve()
      .then(() => onRepeat({ chatKey, groupId: gid, text: String(text || '').trim(), count }))
      .catch((e) => log.error(`[复读机] 失败 ${chatKey}: ${e.message}`))
    return true
  }

  /**
   * 一条**没唤醒机器人**的群消息进来后：看看要不要把它捡成"接话时机"。
   * 内核在管线跑完后调（有 wake 的消息不进来，避免被叫时同时主动插话）。
   */
  function consider(ev) {
    if (!cfg.reply.enabled) return
    if (!ev?.isGroup) return
    const key = String(ev.chatKey ?? '')
    if (!key) return
    const gid = String(ev.groupId ?? key.replace(/^group:/, ''))
    if (!allowedGroups().has(gid)) return
    // 这个群单独关掉了主动接话（群对话框里的「主动接话：关」）
    if (layered(key, 'enabled') === false) return
    // 按群覆盖 hourlyMax=0 也等于关
    if (rnum(key, 'hourlyMax', 0) <= 0) return

    // ── ⓪ 复读机：群里连着几个人刷同一句话 → 跟着刷一句一模一样的（不走模型，省 token）──
    //    放在「机会间隔/窗口」之前：复读不参与主动接话的 8 分钟节奏
    const repeatNow = Number(ev?.time) > 0 ? Number(ev.time) : nowMs()
    if (tryRepeat(key, gid, String(ev.text || '').trim(), repeatNow)) return

    if (isBusy(key)) return // 这个群正在被叫的一轮里，不抢
    const now = nowMs()
    const o = ensureWindow(key, now)
    if (!o) return
    const text = String(ev.text || '').trim()

    // 窗口里至少得有几条消息才按"话题"挑时机：单条孤零零的消息不接（冷场路径另算）
    const recent = (rings.get(key) || []).filter((m) => now - m.ts < Math.max(60000, rnum(key, 'topicWindowMs', 600000) / 2))
    if (recent.length < Math.max(1, rnum(key, 'topicMinMsgs', 3))) return
    const last = recent[recent.length - 1]
    // 纯表情/图/太短的：不按话题接（分值也会很低，这里先挡一道省计算）
    if (!text || last?.placeholderOnly || last?.short) return
    const { score, logit } = interestFor(ev)
    const threshold = thresholdForSensitivity(rnum(key, 'sensitivity', 0.45))
    log.debug(`[主动接话] ${key} 兴趣分 ${(score * 100).toFixed(0)}% / 门槛 ${(threshold * 100).toFixed(0)}%（logit ${logit.toFixed(2)}）`)
    if (score >= threshold) fire(key, gid, 'topic', score)
  }

  /** 冷场找话是否开启（关 = 只由入站消息驱动「话题合适时接话」，不再定时找话）。 */
  const silenceOn = () => cfg.reply.silenceEnabled !== false

  // ── 连续对话（摘自上游戏 2026-10-27）──────────────────────────────
  // 只做一件事：真人叫过她、她也回过话之后，隔一会儿把**这期间的新消息**塞回模型再判一次
  // "要不要补一句"。判据不另起一套：续聊分 = sigmoid(主动接话那 9 个权重算出的 logit + bonus)。
  // 防"自己转"：只由真人唤醒登记；合成轮（proactive/continuation/welcome）不登记；
  //            一次链路默认只检查 1 次；且必须有人类新消息（requireNewMessage）。
  const cont = new Map()      // chatKey → { gid, armedAt, lastReplyAt, dueAt, chain, lastFireAt }
  const contFires = new Map() // chatKey → [ts…]（每群每小时续聊次数）

  /** 该群生效的续聊参数（支持按群覆盖：continuationEnabled / continuationDelayMs / continuationBonus） */
  function cnum(chatKey, field, dflt) {
    const v = layered(chatKey, field)
    return num(v, dflt)
  }
  function continuationOnFor(chatKey) {
    const v = layered(chatKey, 'continuationEnabled')
    if (v === undefined) return cfg.reply.continuation.enabled === true
    return v !== false
  }

  /** 它上次回复之后，群里又有几条人类消息 */
  function humanMsgsSince(chatKey, since) {
    return (rings.get(chatKey) || []).filter((m) => m.ts > Number(since || 0))
  }

  /** 真人唤醒时登记一条"续聊链"（同一群再来一次就重置，不叠加） */
  function noteWake(ev) {
    const key = String(ev?.chatKey ?? '')
    if (!key || !ev?.isGroup) return
    if (!cfg.reply.enabled) return
    const gid = String(ev.groupId ?? key.replace(/^group:/, ''))
    if (!allowedGroups().has(gid)) return
    if (!continuationOnFor(key)) return
    const kind = String(ev?.wake?.kind ?? '')
    if (!['at', 'quote', 'keyword', 'followup'].includes(kind)) return
    cont.set(key, { gid, armedAt: nowMs(), lastReplyAt: 0, dueAt: 0, chain: 0, lastFireAt: 0 })
  }

  /** 已经计入「无人应答」的主动轮（按 turnCtx 对象认轮，拆条不会重复计）。 */
  const countedProactiveTurns = new WeakSet()

  /** 它真的发出了一条回复 → 从这一刻开始计时（主动/续聊/欢迎轮不参与） */
  function noteReplySent(chatKey, turnCtx) {
    const key = String(chatKey ?? '')
    const kindOf = String(turnCtx?.wakeKind ?? '')
    // 主动接话（冷场找话）说出了口 → 记一次"自说自话"。接着看有没有人接：
    // 没人接之前 tickSilence 会把要求静默时间翻倍，**避免在死群里每 10 分钟自言自语一次**。
    // （用它自己的消息当"群里有动静"是错的 —— 那正是自激循环的成因。）
    if (kindOf === 'proactive') {
      const st = state.get(key)
      // ⚠️ 这里必须"每轮只算一次"：出站是**按条**回调的，拆条一轮发 2~3 条会调 2~3 次，
      //    照条计数会让她一轮就攒满"三次没人接"→ 立刻闭嘴，退避过激。
      //    turnCtx 是每轮一个对象 → 用 WeakSet 认"这一轮已经算过"；拿不到对象时用 60 秒窗口兜底。
      const ctx = turnCtx && typeof turnCtx === 'object' ? turnCtx : null
      const counted = ctx ? countedProactiveTurns.has(ctx) : (nowMs() - Number(st.lastProactiveAt || 0) < 60000)
      if (ctx && !counted) countedProactiveTurns.add(ctx)
      if (!counted) st.proactiveUnanswered = Math.min(9, Number(st.proactiveUnanswered || 0) + 1)
      st.lastProactiveAt = nowMs()          // 锚点总是更新成"她最后一条说出去的时间"
    }
    const c = cont.get(key)
    if (!c) return
    if (['proactive', 'continuation', 'welcome'].includes(kindOf)) return
    c.lastReplyAt = nowMs()
    if (c.chain < num(cfg.reply.continuation.maxPerChain, 1)) {
      c.dueAt = c.lastReplyAt + cnum(key, 'continuationDelayMs', num(cfg.reply.continuation.delayMs, 120000))
    }
  }

  /** 该群是否有待执行的续聊（主动接话两条路径要避让，别同一时刻说两句） */
  function contPending(chatKey) {
    const c = cont.get(String(chatKey))
    return Boolean(c && c.dueAt > 0)
  }

  /** 到点检查：有人类新消息 + 续聊分够 → 起一轮；否则记日志、链结束 */
  function tickContinuation(now) {
    const cf = cfg.reply.continuation
    for (const [key, c] of [...cont]) {
      if (!continuationOnFor(key)) { cont.delete(key); continue }
      if (now - c.armedAt > 10 * 60000) { cont.delete(key); continue } // 链活太久（唤醒 10 分钟后语境已变）
      if (!c.dueAt || now < c.dueAt) continue
      if (!allowedGroups().has(String(c.gid)) || isBusy(key)) continue
      if (c.chain >= num(cf.maxPerChain, 1)) { cont.delete(key); continue }
      const fires = (contFires.get(key) || []).filter((t) => now - t < HOUR)
      contFires.set(key, fires)
      if (fires.length >= cnum(key, 'continuationHourlyMax', num(cf.hourlyMax, 5))) { cont.delete(key); continue }
      if (now - c.lastFireAt < num(cf.minGapMs, 300000)) continue
      const humans = humanMsgsSince(key, c.lastReplyAt)
      if (cf.requireNewMessage && humans.length === 0) {
        log.info(`[连续对话] ${key} 没人接话 → 不检查（链结束）`)
        cont.delete(key)
        continue
      }
      const last = humans[humans.length - 1]
      if (!last || last.placeholderOnly || last.short) {
        log.info(`[连续对话] ${key} 最后一条是媒体/太短 → 跳过`)
        cont.delete(key)
        continue
      }
      // 复用主动接话的权重：结构不变的 logit + 情境加分
      const { logit } = interestFor({ chatKey: key, isGroup: true, groupId: c.gid, text: last.text, mentionedSelf: last.mentionBot })
      const bonus = cnum(key, 'continuationBonus', num(cf.bonus, 1.5))
      const p = 1 / (1 + Math.exp(-(logit + bonus)))
      const threshold = thresholdForSensitivity(cnum(key, 'sensitivity', cfg.reply.sensitivity))
      if (p < threshold) {
        log.info(`[连续对话] ${key} 续聊分 ${(p * 100).toFixed(0)}% < 门槛 ${(threshold * 100).toFixed(0)}% → 跳过`)
        cont.delete(key)
        continue
      }
      c.chain += 1
      c.lastFireAt = now
      fires.push(now)
      const quoteTo = cf.quoteLastHuman ? (last.id ?? null) : null
      log.info(`[连续对话] ${key} 起念（续聊分 ${(p * 100).toFixed(0)}%，新消息 ${humans.length} 条，第 ${c.chain}/${num(cf.maxPerChain, 1)} 次${quoteTo ? '，引用 ' + quoteTo : ''}）`)
      if (typeof onProactiveTurn === 'function') {
        Promise.resolve()
          .then(() => onProactiveTurn({ chatKey: key, groupId: c.gid, reason: 'continuation', score: p, humanMsgs: humans.length, quoteTo }))
          .catch((e) => log.error(`[连续对话] 起回合失败 ${key}: ${e.stack || e.message}`))
      }
      if (c.chain >= num(cf.maxPerChain, 1)) cont.delete(key)
      else c.dueAt = now + cnum(key, 'continuationDelayMs', num(cf.delayMs, 120000))
    }
  }
  const silenceOnFor = (chatKey) => rbool(chatKey, 'silenceEnabled', true)

  /** 冷场：到点了、群又安静够久 → 直接起一轮"找话"（不等消息） */
  /**
   * ── 她的作息（随机游走，不是固定钟点套抖动）──────────────────────────
   * 真人不是"每天在 01:30 上下抖一抖"，而是**从前一天接着走**：
   *   · 今天熬夜到 4 点 → 明天自然更晚（甚至白天才睡）；今天早睡 → 明天也可能早点睡。
   *   · 偶尔**通宵**（像人一不小心过上美国人作息），那天整夜不睡。
   *   · 睡眠**时长**也有浮动，但幅度不大（正常人 6~9 小时），不会睡 3 小时也不会睡 14 小时。
   * 状态按天算一次、落到 state 文件里；同一天内绝不重抽（否则她会在睡/醒之间横跳）。
   */
  function hhmm(v, dflt) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim())
    if (!m) return dflt
    const h = Number(m[1]); const mi = Number(m[2])
    if (!(h >= 0 && h <= 24 && mi >= 0 && mi <= 59)) return dflt
    return (h % 24) * 60 + mi
  }
  /** 确定性 0..1 伪随机（同一 key 恒定） */
  function rand01(key) {
    let h = 2166136261
    const str = String(key)
    for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
    return (h >>> 0) / 4294967295
  }
  /** 按 key 抽样：正态（Box-Muller），σ = 1 */
  function gauss(key) {
    const u1 = Math.max(1e-9, rand01(`${key}|a`))
    const u2 = rand01(`${key}|b`)
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
  const dayKeyOf = (now) => {
    const d = new Date(now)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const RHYTHM_FILE = 'pacing-rhythm.json'

  function rhythmFilePath() {
    const dir = String(stateDir || '').trim()
    return dir ? `${dir}/${RHYTHM_FILE}` : ''
  }
  function loadRhythm() {
    const f = rhythmFilePath()
    if (!f) return null
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
  }
  function saveRhythm(rec) {
    const f = rhythmFilePath()
    if (!f) return
    try {
      fs.mkdirSync(String(stateDir), { recursive: true })
      const tmp = `${f}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 1))
      fs.renameSync(tmp, f)
    } catch (e) { log.warn(`[作息] 保存失败（不影响运行）: ${e.message}`) }
  }

  /**
   * 算出某一天她的作息：{ day, bedtime, sleepMin, wakeMin, allNighter }。
   * 从上一天的记录接着走（随机游走）；没有记录就从基线开始。
   */
  function rhythmForDay(now = nowMs()) {
    const q = cfg.reply.quiet || {}
    const enabled = q.enabled !== false
    const dayKey = dayKeyOf(now)
    const cached = loadRhythm()
    if (cached && cached.day === dayKey && Number.isFinite(cached.bedtime)) {
      const bedtime = ((Number(cached.bedtime) % 1440) + 1440) % 1440
      const sleepMin = Math.max(60, Number(cached.sleepMin) || 450)
      return { enabled, day: dayKey, bedtime, sleepMin,
        wakeMin: (bedtime + sleepMin) % 1440, allNighter: Boolean(cached.allNighter) }
    }

    // 基线（人设可能偏夜猫子：默认 02:30 睡、睡 7.5 小时；面板可调）
    const baseBedtime = hhmm(q.baseBedtime, 150)
    const baseSleep = Math.round(num(q.baseSleepHours, 7.5) * 60)
    const drift = Math.max(1, num(q.driftMin, 75))
    const durJitter = Math.max(1, num(q.durationJitterMin, 35))
    const minSleep = Math.round(Math.max(3, num(q.minSleepHours, 5.5)) * 60)
    const maxSleep = Math.round(Math.max(num(q.minSleepHours, 5.5), num(q.maxSleepHours, 9.5)) * 60)
    const earliest = hhmm(q.earliestBedtime, 1380)   // 23:00
    const latest = hhmm(q.latestBedtime, 420)        // 07:00
    const allNighterPct = Math.max(0, Math.min(30, num(q.allNighterPct, 4)))
    const dow = new Date(now).getDay()
    const weekend = dow === 0 || dow === 6
    const weekendExtra = weekend ? num(q.weekendExtraMin, 45) : 0

    // 前一天的落点：优先用记录里"昨天/最近的"，否则用基线
    const prevDay = cached && cached.day !== dayKey ? cached : null
    const prevBedtime = prevDay && Number.isFinite(prevDay.bedtime) ? Number(prevDay.bedtime) : baseBedtime
    const prevSleep = prevDay && Number.isFinite(prevDay.sleepMin) ? Number(prevDay.sleepMin) : baseSleep

    // ① 睡点随机游走：**接着昨天走**（这是主人要的"针对前一天"），但带**回拉力** ——
    //    真人熬几天会被上班/上学拉回来，不会一路漂到天亮或漂到 23:00。
    const revertPct = Math.max(0, Math.min(90, num(q.revertPct, 30))) / 100
    const pull = (prevBedtime - baseBedtime) * revertPct
    // 首日（还没有昨天的记录）只走半步，别一上来就偏 3 小时
    const stepScale = prevDay ? 1 : 0.4
    let bedtime = Math.round(prevBedtime - pull + gauss(`${dayKey}|bed`) * drift * stepScale + weekendExtra)
    // 昨天通宵了 → 今天大概率"补觉式早睡"（往前拉 2~4 小时）
    if (prevDay?.allNighter) bedtime -= 120 + Math.round(rand01(`${dayKey}|crash`) * 120)
    // 夹在"最早/最晚"之间（最晚 07:00 = 天亮了才睡）
    const win = (latest - earliest + 1440) % 1440
    bedtime = (earliest + ((bedtime - earliest + 1440) % win + win) % win) % 1440

    // ② 睡眠时长：接着昨天走，但**强回拉**到基线（正常人的睡眠时长不会一天一个新常态），
    //    抖动小（σ≈35 分钟），夹在 [5.5h, 9.5h]。
    const durPull = (prevSleep - baseSleep) * Math.max(revertPct, 0.5)
    let sleepMin = Math.round(prevSleep - durPull + gauss(`${dayKey}|dur`) * durJitter)
    sleepMin = Math.max(minSleep, Math.min(maxSleep, sleepMin))

    // ③ 通宵：小概率整夜不睡（那天没有睡眠窗口）
    const allNighter = rand01(`${dayKey}|night`) < allNighterPct / 100

    const rec = { day: dayKey, bedtime, sleepMin, allNighter, at: Date.now() }
    saveRhythm(rec)
    return { enabled, day: dayKey, bedtime, sleepMin,
      wakeMin: (bedtime + sleepMin) % 1440, allNighter }
  }

  /** 兼容旧字段：window = { startMin, endMin } */
  function quietWindowFor(now = nowMs()) {
    const r = rhythmForDay(now)
    const dow = new Date(now).getDay()
    return { startMin: r.bedtime, endMin: r.wakeMin, enabled: r.enabled,
      weekend: dow === 0 || dow === 6, allNighter: r.allNighter, sleepMin: r.sleepMin }
  }

  // ── 兴趣画像（她自己决定喜欢什么话题、什么人）────────────────────────
  const INTERESTS_FILE = 'pacing-interests.json'
  function interestsPath() {
    const dir = String(stateDir || '').trim()
    return dir ? `${dir}/${INTERESTS_FILE}` : ''
  }
  function loadInterests() {
    const f = interestsPath()
    if (!f) return { topics: [], people: [] }
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'))
      return {
        topics: Array.isArray(d.topics) ? d.topics : [],
        people: Array.isArray(d.people) ? d.people : [],
      }
    } catch { return { topics: [], people: [] } }
  }
  function saveInterests(doc) {
    const f = interestsPath()
    if (!f) return
    try {
      fs.mkdirSync(String(stateDir), { recursive: true })
      const tmp = `${f}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 1))
      fs.renameSync(tmp, f)
    } catch (e) { log.warn(`[兴趣] 保存失败（不影响运行）: ${e.message}`) }
  }
  const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)))
  /**
   * 记一条兴趣/好感（她自己调工具写的，也可以内核代写）。
   * delta 可正可负：遇到喜欢的话题 +10，聊腻了 -5。
   */
  function noteInterest({ kind = 'topic', name = '', qq = '', delta = 10, why = '' } = {}) {
    const doc = loadInterests()
    const now = nowMs()
    const d = Math.max(-50, Math.min(50, Number(delta) || 10))
    if (kind === 'person') {
      const key = String(qq || name || '').trim()
      if (!/^\d{4,12}$/.test(key) && !name) return { ok: false, error: '记人要说 QQ 号或名字' }
      let p = doc.people.find((x) => String(x.qq || '') === key || (name && x.name === name))
      if (!p) { p = { qq: /^\d{4,12}$/.test(key) ? key : '', name: String(name || key), affinity: 50, why: '', at: now } ; doc.people.push(p) }
      p.affinity = clamp100((Number(p.affinity) || 50) + d)
      if (name) p.name = String(name)
      if (why) p.why = String(why).slice(0, 120)
      p.at = now
      saveInterests(doc)
      return { ok: true, kind: 'person', name: p.name, affinity: p.affinity }
    }
    const t = String(name || '').trim()
    if (!t) return { ok: false, error: '记话题要说个名字' }
    let it = doc.topics.find((x) => x.name === t)
    if (!it) { it = { name: t, score: 50, why: '', at: now }; doc.topics.push(it) }
    it.score = clamp100((Number(it.score) || 50) + d)
    if (why) it.why = String(why).slice(0, 120)
    it.at = now
    saveInterests(doc)
    return { ok: true, kind: 'topic', name: it.name, score: it.score }
  }
  /** 给模型/控制台看的兴趣摘要（按时效简单衰减，越久没碰越淡） */
  function interestsView() {
    const doc = loadInterests()
    const now = nowMs()
    const decay = (v, at) => {
      const days = Math.max(0, (now - (Number(at) || now)) / 86400000)
      return clamp100(Number(v) - days * 2)      // 每天淡 2 分，不主动碰就慢慢忘
    }
    return {
      topics: doc.topics.map((t) => ({ name: t.name, score: decay(t.score, t.at), why: t.why || '', at: t.at }))
        .sort((a, b) => b.score - a.score).slice(0, 12),
      people: doc.people.map((p) => ({ qq: p.qq, name: p.name, affinity: decay(p.affinity, p.at), why: p.why || '', at: p.at }))
        .sort((a, b) => b.affinity - a.affinity).slice(0, 12),
    }
  }

  // ── 夜醒（她自己在半夜醒来）──────────────────────────────────────────
  /** 今天这一夜她是不是已经醒过一次（避免一晚反复醒） */
  function nightWakeRecord() {
    const r = loadRhythm()
    return r && r.nightWokeDay ? r.nightWokeDay : ''
  }
  function markNightWoke(day, awakeUntil) {
    const r = loadRhythm() || {}
    saveRhythm({ ...r, nightWokeDay: day, awakeUntil })
  }
  /** 现在是否因为"半夜醒了"而清醒着 */
  function awakeBecauseNightWake(now = nowMs()) {
    const r = loadRhythm()
    const until = Number(r?.awakeUntil || 0)
    return until > now ? until : 0
  }

  /** 睡着时"有人叫她"的消息先攒着（chatKey → { evs, run }），醒来一起补。 */
  const sleepQueue = new Map()
  const SLEEP_Q_MAX = 50              // 单个会话最多攒多少条（防爆）
  const SLEEP_Q_TTL_MS = 12 * 3600000 // 超过 12 小时的旧消息直接丢（醒来说明睡太久了）

  /** 是不是"睡着且不打算理人"（wakeOnCall 关掉时，睡觉只影响主动找话，被叫照旧回） */
  function sleepingNow(now = nowMs()) {
    if (awakeBecauseNightWake(now)) return false   // 半夜醒了这一小段她是清醒的
    if (cfg.reply.quiet?.wakeOnCall === false) return false
    return inQuietHours(now)
  }
  /** 离睡点还有多少分钟（不在临界范围内返回 null） */
  function minutesToBedtime(now = nowMs()) {
    const q = cfg.reply.quiet || {}
    const grace = Math.max(0, num(q.bedtimeGraceMin, 30))
    if (!grace) return null
    const r = rhythmForDay(now)
    if (!r.enabled || r.allNighter) return null
    const cur = new Date(now).getHours() * 60 + new Date(now).getMinutes()
    const diff = (r.bedtime - cur + 1440) % 1440
    if (diff === 0 || diff > grace) return null    // 已到点或还早
    return diff
  }
  /** 把睡着期间攒的消息取出来（每个会话一批） */
  function drainSleepQueue(now = nowMs()) {
    const out = []
    for (const [key, rec] of [...sleepQueue.entries()]) {
      sleepQueue.delete(key)
      const fresh = (rec.evs || []).filter((e) => now - (Number(e.time) || now) < SLEEP_Q_TTL_MS)
      if (fresh.length) out.push({ key, evs: fresh, run: rec.run })
    }
    return out
  }

  /** 当前是否在睡觉（通宵那天永远不算睡） */
  function inQuietHours(now = nowMs()) {
    const r = rhythmForDay(now)
    if (!r.enabled || r.allNighter) return false
    const cur = new Date(now).getHours() * 60 + new Date(now).getMinutes()
    const start = r.bedtime
    const end = r.wakeMin
    if (start === end) return false
    return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end)
  }

  /** 允许主动私聊的 QQ（只认 4–12 位数字） */
  function allowedPrivateIds() {
    const raw = cfg.reply.privateAllow
    const list = Array.isArray(raw) ? raw : []
    const out = new Set()
    for (const v of list) {
      const q = String(v || '').trim()
      if (/^\d{4,12}$/.test(q)) out.add(q)
    }
    return out
  }
  function privateColdMs() {
    return Math.max(600000, num(cfg.reply.privateColdHours, 6) * 3600000)
  }
  /**
   * 某个人今天的"想他门槛"：基线 ± 抖动。
   * 按「当天 + 这个人」确定性抖动 —— 同一天里反复 tick 不会来回跳，
   * 但不同天、不同人门槛都不一样（像真人"今天忽然想起他"没有固定时刻）。
   */
  function privateColdMsFor(qq, now = nowMs()) {
    const base = privateColdMs()
    const jitter = Math.max(0, num(cfg.reply.privateColdJitterMin, 0)) * 60000
    if (!jitter) return base
    const d = new Date(now)
    const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    const off = (rand01(`${dayKey}|${qq}|privatecold`) * 2 - 1) * jitter   // -jitter..+jitter
    return Math.max(600000, base + off)
  }

  /**
   * 私聊主动：安静够久 → 想起这个人，主动发一条。
   * 纪律与群里一致：睡觉不发、忙线不发、四次方退避；额外要求"有过对话"（从没聊过的人不打扰）。
   */
  function tickPrivate(now) {
    const allow = allowedPrivateIds()
    if (!allow.size) return
    if (!cfg.reply.enabled || num(cfg.reply.hourlyMax, 0) <= 0 || typeof onProactiveTurn !== 'function') return
    if (sleepingNow(now)) return                       // 她睡着：不主动私聊（醒来也不补发，跟群里一样）
    for (const qq of allow) {
      const key = `private:${qq}`
      if (isBusy(key) || contPending(key)) continue
      const st = state.get(key)
      const lastIn = Number(st.lastInboundAt || 0)
      if (!lastIn) continue                            // 从没聊过 → 不打扰
      const cold = privateColdMsFor(qq, now)
      if (now - lastIn < cold) continue                // 还没安静够久（带当天抖动）
      const unanswered = Math.min(3, Number(st.proactiveUnanswered || 0))
      if (unanswered >= 3) continue                    // 连着几次没回音 → 先别打扰人家
      if (unanswered > 0) {
        const sinceSelf = now - Number(st.lastProactiveAt || 0)
        if (sinceSelf < cold * Math.pow(2, unanswered)) continue
      }
      // 私聊不需要群聊那套"抢话时机窗口"（群里可能正有人说话，私聊没人在说话）：
      // 只要过了"最短间隔"就可以想起他。
      const gap = opportunityGapMs(key)
      if (now - Number(st.lastProactiveAt || 0) < gap && Number(st.lastProactiveAt || 0) > 0) continue
      fire(key, null, 'private-silence', 1)
    }
  }

  function tickSilence(now) {
    if (!cfg.reply.enabled || num(cfg.reply.hourlyMax, 0) <= 0 || !onProactiveTurn) return
    // 她的免打扰时段：**只拦"冷场找话"**。
    // 群里正有人聊（topic 路径）照旧能接 —— 这就是"熬夜"（有人陪就熬）；没人说话就安静去睡。
    // 正常回话（有人叫她）完全不受影响。
    if (inQuietHours(now)) return
    for (const gid of allowedGroups()) {
      const key = `group:${gid}`
      if (layered(key, 'enabled') === false) continue
      if (!silenceOnFor(key)) continue
      if (rnum(key, 'hourlyMax', 0) <= 0) continue
      const st = state.get(key)
      const silence = now - Number(st.lastInboundAt || 0)
      // 她自己上一条主动接话之后没人接 → 不当作"群里安静"，而是当作"我该闭嘴等一等"。
      // 退避：1 次无人应答 ×2，2 次 ×4，3 次及以上 ×8（封顶），有人说话就清零。
      const unanswered = Math.min(3, Number(st.proactiveUnanswered || 0))
      if (unanswered >= 3) continue                    // 连续三次没人接：真的先别说了，等有人开口
      const cold = rnum(key, 'coldSilenceMs', 300000)
      if (silence < cold) continue
      // ⚠️ 退避必须锚在「她自己上次主动说话的时刻」，不能锚在「最后一条人类消息」上：
      //    后者只会越走越远，乘几倍都永远满足 —— 那等于没退避（第一版就错在这）。
      if (unanswered > 0) {
        const sinceSelf = now - Number(st.lastProactiveAt || 0)
        if (sinceSelf < cold * Math.pow(2, unanswered)) continue
      }
      if (isBusy(key) || contPending(key)) continue // 有续聊待执行时先让路
      const o = ensureWindow(key, now)
      if (!o) continue
      o.windowUntil = now // 立即用掉窗口，避免下个 tick 重复
      fire(key, gid, 'silence', 1)
    }
  }

  /** 定时器入口：冷场找话（可选）+ 连续对话（可选） */
  /**
   * 自主起念：她自己"突然想聊点什么 / 想找谁说话"。
   * 与调度器驱动的冷场/话题接话不同 —— 这次是**她的兴趣**在驱动：
   *   · 清醒时：按她的兴趣画像挑"最想聊的话题"或"最想找的人"，到点就起念（她也可以什么都不说）；
   *   · 睡着时：每晚小概率半夜醒来一段时间，醒来期间照常能主动/能回话。
   */
  function tickDesire(now) {
    const d = cfg.reply.desire || {}
    if (d.enabled === false || typeof onProactiveTurn !== 'function') return
    const rhythm = rhythmForDay(now)
    const dayKey = dayKeyOf(now)

    // ── 夜醒：每晚最多一次，醒来一小段（像人半夜睡不着刷手机）────────────
    if (inQuietHours(now) && !awakeBecauseNightWake(now) && nightWakeRecord() !== dayKey) {
      const pct = Math.max(0, Math.min(100, num(d.nightWakePct, 12)))
      if (pct > 0 && rand01(`${dayKey}|nightwake`) * 100 < pct) {
        const a = Math.max(5, num(d.awakeMinMin, 20))
        const b = Math.max(a, num(d.awakeMaxMin, 60))
        const minutes = Math.round(a + rand01(`${dayKey}|nightwake-len`) * (b - a))
        const until = now + minutes * 60000
        markNightWoke(dayKey, until)
        log.info(`[自主] 半夜醒了（${Math.round(minutes)} 分钟后再睡）：${chatKeyForDesire() || '?'}`)
        // 醒了通常会想说点什么（也可以不发）
        fireDesire(now, { nightWake: true })
      }
      return
    }
    if (sleepingNow(now)) return          // 睡着（且没夜醒）→ 不会有念头

    // ── 清醒时的自主起念：按间隔 + 每小时上限 ────────────────────────
    const st = state.get('__desire__')
    const gap = Math.max(60000, num(d.minGapMin, 150) * 60000)
    if (now - Number(st.lastDesireAt || 0) < gap) return
    // 做梦心情沉的那天，主动找话少一次（最低 1），次日 dayKey 变了自动失效
    const penalty = moodPenalty.day === dayKey ? moodPenalty.penalty : 0
    const hourCap = Math.max(penalty ? 1 : 0, num(d.hourlyMax, 1) - penalty)
    const firedHour = (Number(st.desireFiredHour) === Math.floor(now / 3600000)) ? Number(st.desireCount || 0) : 0
    if (firedHour >= hourCap) return
    // 概率触发：不是每次 tick 都冒念头（每分钟一次太频繁）
    const chance = 0.06
    if (rand01(`${Math.floor(now / 60000)}|desire`) > chance) return
    fireDesire(now, {})
  }

  /** 挑"此刻最想说话的地方"：兴趣最高的人 or 话题所在的群 */
  function chatKeyForDesire() {
    const view = interestsView()
    const priv = allowedPrivateIds()
    const best = view.people.find((p) => priv.has(String(p.qq)))
    return best ? `private:${best.qq}` : null
  }
  function fireDesire(now, { nightWake = false } = {}) {
    const d = cfg.reply.desire || {}
    const view = interestsView()
    const priv = allowedPrivateIds()
    const groups = allowedGroups()
    // 候选：① 兴趣里的人（且在私聊名单）② 兴趣话题对应的群（挑最近有人在聊的）
    const person = view.people.find((p) => priv.has(String(p.qq)))
    const topic = view.topics[0]
    const group = [...groups].find((g) => !isBusy(`group:${g}`)) || null
    let target = null
    if (person && (!group || rand01(`${now}|pick`) < 0.5)) target = { key: `private:${person.qq}`, gid: null }
    else if (group) target = { key: `group:${group}`, gid: group }
    if (!target) return null
    if (isBusy(target.key)) return null
    const score = Math.min(1, ((topic?.score ?? person?.affinity ?? 50) / 100))
    fire(target.key, target.gid, nightWake ? 'night-wake' : 'desire', score, {
      nightWake,
      topic: topic ? { name: topic.name, why: topic.why } : null,
      person: person ? { qq: person.qq, name: person.name, why: person.why } : null,
    })
    const st = state.get('__desire__')
    st.lastDesireAt = now
    const hour = Math.floor(now / 3600000)
    st.desireFiredHour = hour
    st.desireCount = (Number(st.desireFiredHour) === hour ? Number(st.desireCount || 0) : 0) + 1
    return target.key
  }

  function tick() {
    const now = nowMs()
    // 睡醒了 → 把睡着期间攒的消息按会话补回（每个会话一轮，她在里面逐条回）
    if (sleepQueue.size && !sleepingNow(now)) {
      for (const batch of drainSleepQueue(now)) {
        try {
          const base = batch.evs[batch.evs.length - 1]
          const lines = batch.evs.map((e) => {
            const nm = String(e.sender?.card || e.sender?.name || e.sender?.qq || '?')
            const qq = String(e.sender?.qq || '')
            const t = new Date(Number(e.time) || now)
            const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
            return `- ${hm} ${nm}${qq ? `(QQ:${qq})` : ''}：${String(e.text || '[非文字]').slice(0, 200)}`
          })
          base.hint = [
            ...(base.hint || []),
            `[你刚睡醒] 你睡着的时候有人找过你，共 ${batch.evs.length} 条：\n${lines.join('\n')}`
              + '\n现在可以一条条回他们（像刚看到手机一样，可以自然说一句刚醒）；别装作当时就看见了。',
          ]
          log.info(`[睡觉] ${batch.key} 醒了 → 补回 ${batch.evs.length} 条`)
          Promise.resolve(batch.run(base)).catch((e) => log.error(`[睡觉] 补回失败 ${batch.key}: ${e.message}`))
        } catch (e) { log.warn(`[睡觉] 补回异常: ${e.message}`) }
      }
    }
    if (silenceOn()) tickSilence(now)
    tickPrivate(now)
    tickDesire(now)
    tickContinuation(now)
  }

  /**
   * 装好回调并按需启动调度：**主动接话默认关**（`enabled:false`）时只记回调、不装定时器，
   * 免得"关着却每 30s 空跑一次"。配置热改成开启后 apply() 会重新 start。
   */
  function start(opts = {}) {
    if (typeof opts.onProactiveTurn === 'function') onProactiveTurn = opts.onProactiveTurn
    if (typeof opts.onRepeat === 'function') onRepeat = opts.onRepeat
    if (typeof opts.isBusy === 'function') isBusy = opts.isBusy
    if (timer) clearInterval(timer)
    timer = null
    if (!proactiveEnabled()) return null
    // 冷场找话与连续对话都关掉时不需要定时器：接话机会只由入站消息触发（topic 路径）
    if (!silenceOn() && cfg.reply.continuation.enabled !== true) return null
    timer = setInterval(() => {
      try { tick() } catch (e) { log.error(`[主动接话] tick 异常: ${e.message}`) }
    }, 30000)
    timer.unref?.()
    return timer
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    // 卸载时直接丢弃待合批的消息，不要还 flush 出去（上游 10-29 审计修复之一）
    for (const slot of pending.values()) if (slot.timer) clearTimeout(slot.timer)
    pending.clear()
    cont.clear()
    contFires.clear()
  }

  // ── 静默合批（与旧版同一套语义，别动） ──────────────────────
  /**
   * 把一轮"已唤醒"的提交推迟 windowMs，窗口内的后续唤醒消息并进来。
   * @param {object} ev 已唤醒事件（ev.wake 有值）
   * @param {(ev:object)=>Promise} run 真正执行的入口
   */
  function submit(ev, run) {
    const c = cfg.merge
    // 主动接话轮与入群欢迎轮都是"系统自己发起的轮"，不和群友消息合批（会被延迟/串进普通对话）
    const selfInitiated = ev.wake?.kind === 'proactive' || ev.wake?.kind === 'welcome'

    // ── 睡觉：有人叫她也不回，攒着醒了一块回（像真人睡着不看手机）──────────
    // 主动/欢迎轮她本来就不会在睡觉时发起（tickSilence 已挡），这里只管"被叫"。
    if (ev.wake && !selfInitiated && sleepingNow()) {
      const key = String(ev.chatKey)
      const rec = sleepQueue.get(key) || { evs: [], run }
      rec.evs.push(ev)
      rec.run = run
      if (rec.evs.length > SLEEP_Q_MAX) rec.evs.splice(0, rec.evs.length - SLEEP_Q_MAX)
      sleepQueue.set(key, rec)
      log.info(`[睡觉] ${key} 睡着中，第 ${rec.evs.length} 条先攒着（醒了再回）`)
      return undefined
    }
    // ── 睡前临界点：还能回，但要带困意 ──────────────────────────────
    if (ev.wake && !selfInitiated) {
      const left = minutesToBedtime()
      if (left != null) {
        ev.hint = ev.hint || []
        ev.hint.push(`[你快要睡了：还有约 ${left} 分钟。这条回得短一点，可以自然带一句困了/要睡了；别开新话题、别答应长聊]`)
      }
    }

    if (!c.enabled || selfInitiated) return run(ev)
    const key = String(ev.chatKey)
    const isPrivate = !ev.isGroup
    const ring = inbound.get(key) || []
    const prev = ring.length >= 2 ? ring[ring.length - 2] : 0
    const now = Number(ev.time) > 0 ? Number(ev.time) : nowMs()
    const gap = prev > 0 ? now - prev : 0
    // ⚠️ 私聊**不用**"慢聊直答"：他隔半小时发第一句，后面往往立刻连着补几句，
    //    如果第一句就抢答，剩下的全被拆成第二轮 —— 这就是"看起来没合批"的真正原因。
    //    私聊一律走 debounce 窗口；群里保留"冷场快答"（群里抢答太快反而像刷屏）。
    if (!isPrivate && gap > num(c.skipIfSlowMs, 30000)) return run(ev)

    let slot = pending.get(key)
    // **只有群聊**才"又来一个人叫 → 上一轮发车、这条另开新轮"（各回各的）。
    // 私聊是**同一个人**连发，应该合批：窗口内每条都并进同一轮、并刷新等待（debounce），
    // 否则他打三行字，她会回三次（像抢话）。
    if (slot && ev.wake && ev.isGroup) {
      log.info(`[合批] ${key} 又来一条唤醒 → 先把上一轮发车，本条另开新槽`)
      flush(key)
      slot = null
    }
    if (!slot) slot = { evs: [], firstAt: nowMs(), timer: null, run }
    slot.evs.push(ev)
    slot.run = run
    if (slot.timer) clearTimeout(slot.timer)
    const baseWait = isPrivate
      ? Math.max(500, num(c.privateWindowMs, 3000))       // 私聊：独立窗口（默认 3 秒，跟手又能合住连发）
      : (gap > 0 && gap <= num(c.activeGapMs, 15000) ? num(c.windowActiveMs, 4000) : num(c.windowMs, 800))
    const waited = nowMs() - slot.firstAt
    const wait = Math.max(0, Math.min(baseWait, num(c.maxWaitMs, 6000) - waited))
    slot.timer = setTimeout(() => flush(key), wait)
    slot.timer.unref?.()
    pending.set(key, slot)
    return undefined
  }

  /** 把缓冲里的一批并成一条事件，交给最近一次提交的 run */
  function flush(key) {
    const slot = pending.get(key)
    if (!slot) return
    pending.delete(key)
    if (slot.timer) clearTimeout(slot.timer)
    const evs = slot.evs
    const last = evs[evs.length - 1]
    if (!last) return
    if (evs.length > 1) {
      const isGroupChat = evs.some((e) => e.isGroup)
      const whoOf = (e) => {
        const nm = e.sender?.card || e.sender?.name || ''
        const qq = String(e.sender?.qq || '')
        if (!isGroupChat && qq) return `${nm || '对方'}(QQ:${qq})`
        return nm || qq || '?'
      }
      const head = evs.slice(0, -1)
        .map((e) => `[${whoOf(e)}]: ${e.text || ''}`)
        .join('\n')
      last.text = `${head}\n${last.text || ''}`.trim()
      const hints = []
      for (const e of evs) for (const h of (e.hint || [])) if (!hints.includes(h)) hints.push(h)
      last.hint = hints
      const parts = evs.flatMap((e) => (Array.isArray(e.imageParts) ? e.imageParts : []))
      const paths = evs.flatMap((e) => (Array.isArray(e.imagePaths) ? e.imagePaths : []))
      if (parts.length) last.imageParts = parts
      if (paths.length) last.imagePaths = [...new Set(paths)]
      // 图片归属：模型拿到的图是一整批，得告诉它"哪几张是谁发的"，否则它会把别人的图当成他的
      const imgOwner = []
      let idx = 0
      for (const e of evs) {
        const n = (Array.isArray(e.imageParts) ? e.imageParts.length : 0)
        if (!n) continue
        const nm = String(e.sender?.card || e.sender?.name || e.sender?.qq || '?')
        const qq = String(e.sender?.qq || '')
        imgOwner.push(`第 ${idx + 1}~${idx + n} 张来自 ${nm}${qq ? `(QQ:${qq})` : ''}`)
        idx += n
      }
      if (imgOwner.length) {
        last.hint = [...(last.hint || []), `[合批图片归属] ${imgOwner.join('；')}（按图片顺序）`]
      }
      const quoted = evs.map((e) => e._scratch?.quoteText).find(Boolean)
      if (quoted && !last._scratch?.quoteText) last._scratch.quoteText = quoted
      last._scratch.mergedCount = evs.length
      log.info(`[合批] ${key} ${evs.length} 条 → 1 轮（等 ${nowMs() - slot.firstAt}ms）`)
    }
    Promise.resolve(slot.run(last)).catch((e) => log.error(`[合批] 执行失败 ${key}: ${e.stack || e.message}`))
  }

  // ── 配置 / 状态 ─────────────────────────────────────────────
  function apply(pacingCfg) {
    cfg = normalize(pacingCfg)
    // 群集合变了：清掉不再允许的群的调度状态（防止旧群继续按旧间隔起念）
    const allow = allowedGroups()
    for (const key of [...opp.keys()]) {
      if (!allow.has(key.replace(/^group:/, ''))) opp.delete(key)
    }
    for (const key of [...rings.keys()]) {
      if (!allow.has(key.replace(/^group:/, ''))) rings.delete(key)
    }
    // 开关热更新：开了就装调度，关了就连定时器一起停（不空跑）
    if (proactiveEnabled() && !timer && onProactiveTurn) start()
    else if (!proactiveEnabled() && timer) { clearInterval(timer); timer = null }
    const r = cfg.reply
    // 同一份配置只打一行（启动时 apply + 控制台热改可能重复触发）
    const stamp = JSON.stringify([r, cfg.merge])
    if (stamp === lastLogged) return cfg
    lastLogged = stamp
    try {
      log.info(`节奏：主动接话=${r.enabled && r.hourlyMax > 0 ? '开' : '关'}`
        + `（每小时≤${r.hourlyMax}次，间隔≥${Math.round(opportunityGapMs() / 60000)}分钟，`
        + (silenceOn() ? `冷场≥${Math.round(num(r.coldSilenceMs, 300000) / 60000)}分钟` : '只在群里有新消息时接')
        + (() => {
          const w = quietWindowFor()
          if (!w.enabled) return '，免打扰=关'
          const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
          return `，她的作息=${fmt(w.startMin)}~${fmt(w.endMin)}${w.weekend ? '(周末)' : ''}${inQuietHours() ? '（现在睡着）' : ''}`
        })()
        + `，敏感度${Math.round(clamp01(r.sensitivity) * 100)}%，群${Object.keys(r.groups).join('/') || '（无）'}）`
        + ` 合批=${cfg.merge.enabled ? '开' : '关'}(${num(cfg.merge.windowMs, 800)}/${num(cfg.merge.windowActiveMs, 4000)}ms 冷清/在聊)`)
    } catch { /* 日志失败不影响配置生效 */ }
    return cfg
  }

  /** 主动接话总开关（控制台/内核用；关掉 = 连"要不要插一句"的念头都不起） */
  function proactiveEnabled() {
    return cfg.reply.enabled !== false && num(cfg.reply.hourlyMax, 0) > 0
  }

  /** 允许主动接话的群号列表（给内核开机播种"最后一条消息时间"用） */
  function allowedGroupIds() {
    return [...allowedGroups()]
  }

  /** 控制台状态：本小时用了几次 / 最近几次的去向（"已接 / 没发"） */
  function stats() {
    const now = nowMs()
    const hourAgo = now - HOUR
    const groups = [...allowedGroups()].map((gid) => {
      const key = `group:${gid}`
      const list = fired.filter((e) => e.chatKey === key && e.at > hourAgo)
      const last = [...fired].reverse().find((e) => e.chatKey === key)
      const o = opp.get(key)
      return {
        groupId: gid,
        used: list.length,
        max: Math.max(0, num(cfg.reply.hourlyMax, 0)),
        lastAt: last ? last.at : null,
        lastSent: last ? !!last.sent : null,
        lastReason: last ? last.reason : null,
        lastScore: last ? last.score : null,
        nextAt: o && Number.isFinite(o.dueAt) ? o.dueAt : null,
      }
    })
    return {
      ok: true,
      privateAllow: [...allowedPrivateIds()],
      privateColdHours: num(cfg.reply.privateColdHours, 6),
      quiet: (() => {
        const w = quietWindowFor()
        const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
        return { enabled: w.enabled, start: fmt(w.startMin), end: fmt(w.endMin), weekend: w.weekend, inQuiet: inQuietHours() }
      })(),
      enabled: proactiveEnabled(),
      hourlyMax: Math.max(0, num(cfg.reply.hourlyMax, 0)),
      minGapMs: opportunityGapMs(),
      sensitivity: clamp01(cfg.reply.sensitivity),
      threshold: thresholdForSensitivity(cfg.reply.sensitivity),
      continuation: {
        enabled: cfg.reply.continuation.enabled === true,
        pending: [...cont.keys()].length,
        firedThisHour: [...contFires.values()].reduce((n, list) => n + list.filter((t) => now - t < HOUR).length, 0),
      },
      groups,
      recent: fired.slice(-8).reverse().map((e) => ({
        at: e.at, groupId: e.gid, reason: e.reason, sent: !!e.sent, score: e.score,
      })),
    }
  }

  return {
    apply, start, stop,
    noteInbound, noteOutbound,
    noteWake, noteReplySent,          // 连续对话的两个钩子（内核在唤醒/出站时调）
    markProactiveSent: markSent,
    /** 做梦带来的心情残留（梦境插件调用）：只降"主动找话"的每小时上限，次日自动失效 */
    setMood({ day = '', penalty = 0 } = {}) {
      moodPenalty = { day: String(day || ''), penalty: Math.max(0, Math.min(3, Math.round(Number(penalty) || 0))) }
    },
    moodNow() {
      return { ...moodPenalty }
    },
    // 免打扰（她自己的作息）：给测试与控制台用
    inQuietHours,
    quietWindowFor,
    // 兴趣画像（她自己决定喜欢什么 / 想找谁）
    noteInterest,
    interestsView,
    awakeBecauseNightWake,
    submit, flush,
    consider,
    interestFor,
    proactiveEnabled, allowedGroupIds, allowedPrivateIds, stats,
    nextOpportunityAt: (chatKey) => {
      const o = opp.get(String(chatKey))
      return o && Number.isFinite(o.dueAt) ? o.dueAt : null
    },
    tickNow: tick,
    get config() { return cfg },
  }
}
