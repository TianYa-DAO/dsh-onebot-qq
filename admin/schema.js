/**
 * admin/schema.js — 控制面的**描述表**（核心开关 + 各子插件 configSchema 汇总）。
 *
 * 设计（沿用现网 admin-api 最值钱的那部分：描述表驱动）：
 *   · 加一个核心开关 = 下面 CORE_CONTROLS 加一行；
 *   · 加一个子插件开关 = 只改插件自己的 configSchema —— 这里、控制台 UI 都不用动；
 *   · 控制台只能改**白名单里的键**：`readValue/writeValue` 按 key 找到注册项，找不到就抛错。
 *
 * 控制台页面归属规则（2026-10-20 起）：
 *   · 目标：**一个子插件 = 一个页面**（生图凭据也归 imagegen，虽然仍存 `credentials.gptImage.*`）；
 *   · `OTHER_GROUPS`：权限/门禁/文件/发图/头像 五组统一并到「其他」页（低频配置集中放）；
 *   · `PERSONA_GROUPS`：跟随「人设」显示在「总览」页的分组（当前为空：句池/唤醒 已各自成页）。
 *
 * 键与配置路径的映射（v2 配置结构见 kernel/config-store.js）：
 *   · 核心项：`key` 就是 raw 配置里的点路径（`pacing.reply.hourlyMax`、`napcat.wsUrl`…）；
 *   · 子插件项：`key = <pluginId>.<field>`，落到 `raw.pluginConfig[<pluginId>][<field>]`。
 *
 * 单位口径（**两套，别混**）：
 *   · 核心项：raw 存“底层单位”（毫秒 / 0~1 分数），面板显示“人话单位”（分钟 / 秒 / %）；
 *     `scale` = 面板值 × scale = 存储值，换算只在 readValue/writeValue 的边界做一次。
 *   · 子插件项：raw 里**本来就存面板单位**（秒 / % —— 各插件 configSchema 的 default 就是面板值），
 *     所以这里**不做 scale 换算**；`scale` 只是“× scale = 插件内部基准单位”的说明字段，前端不读。
 *
 * 秘密字段（napcat token）读出来给占位符，写回占位符 = 不改。
 */

/** 秘密值的占位符：读 schema 时回显它而不是真值；把它原样写回来 = 不修改。 */
export const SECRET_MASK = '••••••••'

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** 点路径读取（`a.b.c` 或数组）。 */
export function getPath(obj, dotted) {
  const parts = Array.isArray(dotted) ? dotted : String(dotted).split('.')
  return parts.reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

/** 点路径写入（中间层不存在就建对象）。 */
export function setPath(obj, dotted, value) {
  const parts = Array.isArray(dotted) ? dotted.slice() : String(dotted).split('.')
  const last = parts.pop()
  const target = parts.reduce((o, k) => (o[k] == null ? (o[k] = {}) : o[k]), obj)
  target[last] = value
  return obj
}

/** 数字保留 3 位小数（面板值显示用；避免 0.1*3 这类浮点尾巴）。 */
const round3 = (n) => Math.round(n * 1000) / 1000
const round6 = (n) => Math.round(n * 1e6) / 1e6

/**
 * 子插件里**由内核权威配置接管**的字段：不在控制台聚合里渲染（插件字段保留作 fallback）。
 * 拆条 / 表情概率的权威存储是顶层 `pacing.reply.style`（内核 reload 时同步进插件 cfg），
 * 两边都给控件会互相覆盖，所以子插件侧只保留配置、不暴露控件。
 */
const HIDDEN_PLUGIN_FIELDS = {
  'persona-voice': new Set(['splitReplyEnabled', 'splitReplyProbability', 'splitReplyMinLen', 'splitReplyDelayMs']),
  stickers: new Set(['offerPercent']),
}

// ============================================================
// 注册表 ①：核心开关（映射 raw 配置顶层键）
// ============================================================

/**
 * @typedef {object} ControlDef
 * @property {string} key       面板/白名单键 = raw 配置点路径
 * @property {string} group     控制台页签（首次出现顺序 = 标签页顺序）
 * @property {'bool'|'int'|'float'|'str'|'text'|'enum'|'group'|'info'} type
 * @property {string} label
 * @property {string} [unit]    面板单位（分钟/秒/%/字/毫秒/次）
 * @property {number} [scale]   面板值 × scale = 存储值（只在读写边界换算）
 * @property {number} [min]     面板值下限
 * @property {number} [max]     面板值上限
 * @property {number} [step]
 * @property {Array|object[]} [options]
 * @property {string} [hint]
 * @property {unknown} [default] 配置缺键时的默认值（存储单位）
 * @property {boolean} [secret] 秘密字段：面板只回显占位符
 * @property {string} [text]  `type:'info'` 的说明正文（原样给前端，不参与读写）
 * @property {string[]} [suggestions] str 控件的输入建议（前端渲染成 datalist）
 */
export const CORE_CONTROLS = [
  // ── 群聊页顶部：主人 QQ（全局唯一身份）──────────────────────
  {
    key: 'adminQq', group: '群聊', type: 'int', label: '主人 QQ',
    min: 1, max: 99999999999, step: 1, default: 0,
    hint: '必填：只有这个 QQ 的私聊豁免出口脱敏，群里的“主人指令”也按它判。改完热生效（下一条消息起）。',
  },

  // ── NapCat 连接（OneBot v11）────────────────────────────────
  {
    key: 'info.napcat', group: 'NapCat 连接', type: 'info',
    text: '分三步接上 NapCat（OneBot v11）：\n'
      + '① 先在本机装好并启动 NapCat（QQ 登录保持在线）；\n'
      + '② 在 NapCat 的配置里打开「WebSocket 服务端」（默认 ws://127.0.0.1:3001）和「HTTP 服务端」（默认 http://127.0.0.1:3000），有 token 就一并填到下面；\n'
      + '③ 填好地址/token 后先让输入框失焦（离开输入框就会保存），再点「运维」页的「🔌 测试 NapCat 连接」：出现 ✅ 就说明通了（测的是已保存的配置）。\n'
      + '⚠️ 两个地址都在同一台机器时用 127.0.0.1 即可；跨机器要把 127.0.0.1 换成 NapCat 那台机器的 IP，并确认防火墙放行端口。',
  },
  {
    key: 'napcat.wsUrl', group: 'NapCat 连接', type: 'str', label: 'OneBot v11 正向 WS 地址',
    default: 'ws://127.0.0.1:3001',
    hint: 'NapCat 的 WebSocket 服务地址（入站消息从这里来）。改了会重新连接。',
  },
  {
    key: 'napcat.wsToken', group: 'NapCat 连接', type: 'str', label: 'WS Token', secret: true, default: '',
    hint: '可留空。填了就是 OneBot 的 access_token（走 Authorization: Bearer）。',
  },
  {
    key: 'napcat.httpUrl', group: 'NapCat 连接', type: 'str', label: 'OneBot HTTP API 地址',
    default: 'http://127.0.0.1:3000',
    hint: '发消息 / 查群列表 / 取头像走这个 HTTP API。',
  },
  {
    key: 'napcat.httpToken', group: 'NapCat 连接', type: 'str', label: 'HTTP Token', secret: true, default: '',
    hint: '可留空；与 NapCat 的 HTTP token 一致。',
  },

  // ── 出站（回复长度 / 长文卡片 / 引用）───────────────────────
  {
    key: 'outbound.replyMaxLength', group: '消息设置', type: 'int', label: '单条字数上限',
    min: 100, max: 100000, step: 100, default: 3000,
    hint: '网关硬上限：超过直接报错，让模型精简重发；兜底路径会在换行处切段逐条发。',
  },
  {
    key: 'outbound.longForwardThreshold', group: '消息设置', type: 'int', label: '长文卡片阈值', unit: '字',
    min: 0, max: 100000, step: 100, default: 400,
    hint: '正文超过这个字数就打成一张合并转发卡片（不刷屏）；0 = 用单条字数上限（等于关掉卡片）。',
  },
  {
    key: 'outbound.longForwardChunkSize', group: '消息设置', type: 'int', label: '长文卡片分片大小', unit: '字',
    min: 100, max: 5000, step: 100, default: 800,
    hint: '合并转发卡片里每个节点最多这么多字。',
  },
  {
    key: 'outbound.quoteAfterMsgs', group: '消息设置', type: 'int', label: '引用门槛（唤醒后插了几条才挂引用）',
    min: 0, max: 50, step: 1, default: 3,
    hint: '本群在“唤醒那条”之后又插了 N 条才允许挂引用；0 = 一律不自动挂。',
  },
  {
    key: 'outbound.groupContextCount', group: '群聊', type: 'int', label: '群聊上文条数',
    min: 0, max: 50, step: 1, default: 10,
    hint: '每轮带最近 N 条群消息给模型（旧→新、30 分钟内、排除当前条），让它接得上话。调大 = 更懂上下文但每轮更贵；自发接话轮也会带。',
  },
  {
    key: 'outbound.groupContextImages', group: '群聊', type: 'int', label: '上文图片张数上限',
    min: 0, max: 30, step: 1, default: 12,
    hint: '上文里出现的图（含表情包）也送进模型（否则它只看到「[图片]」「[表情]」）。这里是安全阀：上限内有多少带多少，超出只留最新的。'
      + '表情包不计入（已转成 [表情:名]）。0 = 一律不带图。每张约 1k token，调大明显更贵。',
  },
  {
    key: 'outbound.groupContextStickers', group: '群聊', type: 'bool', label: '上文表情包也当图带上', default: true,
    hint: '开：群里发的表情包会**作为图片**送进模型（她才能读到表情本身，而不是只看到「[表情]」）。'
      + '关：只带照片/截图这类真图。表情包比真图多，额度里真图优先、表情补位。',
  },
  {
    key: 'outbound.groupContextImageMaxAgeMin', group: '群聊', type: 'int', label: '上文图片只带多久内的',
    min: 1, max: 120, step: 1, default: 30, unit: '分钟',
    hint: '太老的图和人眼对不上（话题早换了）。默认 30 分钟，与「群聊上文条数」的 30 分钟窗口一致。',
  },
  {
    key: 'outbound.imagePartsMax', group: '群聊', type: 'int', label: '单轮总图上限',
    min: 1, max: 30, step: 1, default: 12,
    hint: '当前消息的图 + 上文图合计最多送几张，超出丢弃最旧的。防止极端情况（10 条上下文每条 9 张图）把请求撑爆。',
  },

  // ── 静默合批（连发的几条并成一轮）──────────────────────────
  {
    key: 'outbound.maxPerWindow', group: '消息设置', type: 'int', label: '5 分钟内最多发几条（兜底保险丝）',
    min: 3, max: 50, step: 1, default: 15,
    hint: '同一个会话 5 分钟内最多发这么多条，超过就拦。**0 = 不限**（默认关闭）。'
      + '正常连聊也很少超过 15 条/5 分钟；如果嫌紧就调大。',
  },
  {
    key: 'outbound.maxMessagesPerTurn', group: '消息设置', type: 'int', label: '一轮最多发几条（保险丝）',
    min: 1, max: 20, step: 1, default: 6,
    hint: '同一轮回复最多发这么多条消息，超了就地拦住。**0 = 不限**（默认关闭）。'
      + '主要防"上下文压缩发生在轮中途 → 模型忘了自己刚回过 → 重复刷屏"这种失控（线上出过一次，连发十几分钟）。',
  },
  {
    key: 'pacing.merge.enabled', group: '消息设置', type: 'bool', label: '静默合批（连发的几条并成一轮）', default: true,
    hint: '同一群里几百毫秒内连着叫它的几条消息并成一轮 —— 省钱、也更像“等别人说完再开口”。',
  },
  {
    key: 'pacing.merge.windowMs', group: '消息设置', type: 'int', label: '合批等待（冷清时）', unit: '毫秒',
    min: 0, max: 10000, step: 100, default: 2000,
    hint: '上一条离得比较久（不是连发）时，单条只等这么久就发车。',
  },
  {
    key: 'pacing.merge.windowActiveMs', group: '消息设置', type: 'int', label: '合批等待（对话进行中）', unit: '毫秒',
    min: 0, max: 10000, step: 100, default: 4000,
    hint: '上一条消息来得近（正在聊）时多等一会儿，把 3~5 秒内的几条收成一轮再答。',
  },
  {
    key: 'pacing.merge.activeGapMs', group: '消息设置', type: 'int', label: '对话判定（距上一条多久算在聊）', unit: '毫秒',
    min: 1000, max: 120000, step: 500, default: 15000,
    hint: '上一条离这条 ≤ 本值 → 用「对话进行中」的等待窗口；否则用「冷清时」。',
  },
  {
    key: 'pacing.merge.privateWindowMs', group: '消息设置', type: 'int', label: '私聊合批等待', unit: '毫秒',
    min: 500, max: 15000, step: 500, default: 3000,
    hint: '私聊专用：他连发几句时，安静这么久才一次性回复（每条新消息会刷新计时）。'
      + '比群里短更跟手；调大更像是"等他写完"，调小回得更快但可能把连发拆成两轮。',
  },
  {
    key: 'pacing.merge.maxWaitMs', group: '消息设置', type: 'int', label: '合批最长等待', unit: '毫秒',
    min: 0, max: 15000, step: 100, default: 6000,
    hint: '刷屏时窗口会被不断重置，这是硬上限，到点必须发车。',
  },
  {
    key: 'pacing.merge.skipIfSlowMs', group: '消息设置', type: 'int', label: '慢群不等阈值', unit: '毫秒',
    min: 0, max: 600000, step: 1000, default: 30000,
    hint: '距上一条群消息超过这个间隔 = 不是连发，直接回答、不进合批。',
  },

  // ── 主动接话：没人叫也偶尔接一句（高级项默认折叠）─────────────
  // 频率口径只有一种：实际间隔 = max(最小间隔, 60 分钟 ÷ 每小时次数)。
  {
    key: 'pacing.reply.enabled', group: '主动接话', type: 'bool', label: '允许主动接话（没人叫也偶尔接一句）', default: false,
    hint: '关掉后只在被叫时回话。开 = 到点看群里聊得怎么样，合适就接一句；每个群还要在「群聊」页勾「允许主动接话」，两处都开才生效。',
  },
  {
    key: 'pacing.reply.hourlyMax', group: '主动接话', type: 'int', label: '每小时最多主动接话', unit: '次',
    min: 0, max: 10, step: 1, default: 6,
    hint: '硬上限（不是每条消息的概率）。调大后两次间隔会自动按 60÷次数 收紧；0 = 关。',
  },
  {
    key: 'pacing.reply.minGapMs', group: '主动接话', type: 'int', label: '两次机会至少间隔', unit: '分钟',
    scale: 60000, min: 1, max: 120, step: 1, default: 480000,
    hint: '两次“可以考虑开口”之间至少隔这么久；实际间隔 = max(本值, 60÷每小时次数)。',
  },
  {
    key: 'pacing.reply.silenceEnabled', group: '主动接话', type: 'bool', label: '群冷场时也主动找话', default: true,
    hint: '开 = 群里长时间没人说话也会主动起个话头（按「安静多久算冷场」判定）；'
      + '关 = 不再定时找话，只有群里出现新消息、且语境合适时才可能接一句。',
  },
  {
    key: 'pacing.reply.coldSilenceMs', group: '主动接话', type: 'int', label: '群里安静多久算冷场', unit: '分钟',
    scale: 60000, min: 1, max: 120, step: 1, default: 180000,
    hint: '群里没人说话超过这么久、又到了机会点 → 可能主动起个话头。',
  },
  {
    key: 'pacing.reply.privateAllow', group: '主动接话', type: 'group', label: '允许她主动私聊的 QQ',
    hint: '填 QQ 号，多个用逗号分隔。她会在这人**安静够久**之后主动发一条（不是定时打卡）。'
      + '留空 = 不主动私聊任何人。只有"聊过的人"才会被想起，从没聊过的不打扰。',
  },
  {
    key: 'pacing.reply.privateColdHours', group: '主动接话', type: 'int', label: '私聊安静多久才想起他', unit: '小时',
    min: 1, max: 72, step: 1, default: 6,
    hint: '比群里克制：默认 6 小时没说话才主动开口。没回音会指数退避（×2/×4/×8），三次没人理就先不打扰。',
  },
  {
    key: 'pacing.reply.privateColdJitterMin', group: '主动接话', type: 'int', label: '私聊门槛的随机抖动', unit: '分钟',
    min: 0, max: 180, step: 5, default: 30,
    hint: '把「私聊安静多久才想起他」上下浮动这么多（按人、按天不同）。'
      + '默认 ±30 分钟：有时 5 个半小时就想起来，有时 6 个半小时。0 = 固定门槛不抖。',
  },
  {
    key: 'pacing.reply.desire.enabled', group: '自主起念', type: 'bool', label: '她可以自己想聊就聊', default: true,
    hint: '开：没人叫也会偶尔"突然想说话"（按她自己记的兴趣挑话题/找人）。'
      + '这是**她自己**的念头 —— 她会用 interest_note 工具记下喜欢的话题和人。',
  },
  {
    key: 'pacing.reply.desire.minGapMin', group: '自主起念', type: 'int', label: '两次自主起念至少间隔', unit: '分钟',
    min: 30, max: 720, step: 10, default: 150,
    hint: '别让她一直自己找话说。默认两个半小时。',
  },
  {
    key: 'pacing.reply.desire.hourlyMax', group: '自主起念', type: 'int', label: '每小时最多自主起念', unit: '次',
    min: 0, max: 6, step: 1, default: 1,
    hint: '每小时最多几次。0 = 完全禁止自主起念（退化成只按冷场/话题调度）。',
  },
  {
    key: 'pacing.reply.desire.nightWakePct', group: '自主起念', type: 'int', label: '半夜醒来的概率', unit: '%',
    min: 0, max: 100, step: 1, default: 12,
    hint: '她睡着时，每晚有多大概率**自己醒来**一会儿（像人半夜睡不着刷手机）。'
      + '醒来这段时间她是清醒的：能主动说话、也能回话；过一会儿再睡。0 = 从不夜醒。',
  },
  {
    key: 'pacing.reply.desire.awakeMinMin', group: '自主起念', type: 'int', label: '夜醒至少清醒', unit: '分钟',
    min: 5, max: 180, step: 5, default: 20,
    hint: '半夜醒来至少清醒这么久（这段时间消息她会回）。',
  },
  {
    key: 'pacing.reply.desire.awakeMaxMin', group: '自主起念', type: 'int', label: '夜醒最多清醒', unit: '分钟',
    min: 10, max: 300, step: 10, default: 60,
    hint: '最多清醒这么久，然后回去睡。',
  },
  {
    key: 'pacing.reply.quiet.enabled', group: '主动接话', type: 'bool', label: '夜里她也要睡（免打扰）', default: true,
    hint: '开：她的「睡觉时间」里不再主动找话；群里正有人聊时照旧能接（熬夜）。'
      + '注意：睡觉时有人叫她，她会**先不回**、醒了再逐条回（见「叫她也不回」）。',
  },
  {
    key: 'pacing.reply.quiet.wakeOnCall', group: '主动接话', type: 'bool', label: '睡觉时有人叫她也不回（醒了再补）',
    default: true,
    hint: '开：睡着时被叫醒的消息先攒着，等她"醒"了再逐条回（像真人睡着不看手机）。'
      + '关：任何时间被叫都立刻回（免打扰只管"主动找话"）。',
  },
  {
    key: 'pacing.reply.quiet.baseBedtime', group: '主动接话', type: 'str', label: '她平时的睡点', default: '02:30',
    hint: '基线睡点（本地时间 HH:MM）。实际睡点是**从前一天接着走**的随机游走，不是每天在这个点上下抖。',
  },
  {
    key: 'pacing.reply.quiet.baseSleepHours', group: '主动接话', type: 'float', label: '她平时睡多久', unit: '小时',
    min: 3, max: 12, step: 0.5, default: 7.5,
    hint: '基线睡眠时长；实际每天有浮动（见「时长浮动」），并会被回拉到这个值附近。',
  },
  {
    key: 'pacing.reply.quiet.driftMin', group: '主动接话', type: 'int', label: '作息游走幅度', unit: '分钟',
    min: 10, max: 240, step: 10, default: 75,
    hint: '每天睡点在"昨天"基础上随机走多少（正态）。越大越容易连续熬夜/连续早睡。',
  },
  {
    key: 'pacing.reply.quiet.revertPct', group: '主动接话', type: 'int', label: '作息的回拉力', unit: '%',
    min: 0, max: 90, step: 5, default: 30,
    hint: '每天往基线睡点拉回多少（像真人被上班/上学拉回来）。0 = 纯随机游走（可能一路漂到天亮）。',
  },
  {
    key: 'pacing.reply.quiet.durationJitterMin', group: '主动接话', type: 'int', label: '睡眠时长浮动', unit: '分钟',
    min: 5, max: 120, step: 5, default: 35,
    hint: '每天睡眠时长在基线附近的抖动幅度（正态）。正常人幅度不大，建议 20~45。',
  },
  {
    key: 'pacing.reply.quiet.minSleepHours', group: '主动接话', type: 'float', label: '最短睡多久', unit: '小时',
    min: 2, max: 8, step: 0.5, default: 5.5,
    hint: '再累也不会少于这么久（下限，防止窗口太窄）。',
  },
  {
    key: 'pacing.reply.quiet.maxSleepHours', group: '主动接话', type: 'float', label: '最长睡多久', unit: '小时',
    min: 5, max: 16, step: 0.5, default: 9.5,
    hint: '再困也不会超过这么久（上限）。',
  },
  {
    key: 'pacing.reply.quiet.allNighterPct', group: '主动接话', type: 'int', label: '通宵概率', unit: '%',
    min: 0, max: 30, step: 1, default: 4,
    hint: '每天有多大概率整夜不睡（像人一不小心过上美国人作息）；通宵那天没有免打扰窗口，第二天会"补觉式早睡"。',
  },
  {
    key: 'pacing.reply.quiet.bedtimeGraceMin', group: '主动接话', type: 'int', label: '睡前临界点', unit: '分钟',
    min: 0, max: 120, step: 5, default: 30,
    hint: '睡点前这段时间她还醒着：被叫会回，但会带困意/说要睡了这种正常反应。0 = 不设临界点。',
  },
  {
    key: 'pacing.reply.continuation.enabled', group: '连续对话', type: 'bool',
    label: '回完话隔一会儿再补一句', default: false,
    hint: '开：别人叫过她、她也回过话之后，等一会儿把这段时间的新消息再判一次——想补一句就补，不想就不发。'
      + '比「主动接话」更自然（像是话说到一半想起来）。默认关。',
  },
  {
    key: 'pacing.reply.continuation.delayMs', group: '连续对话', type: 'int',
    label: '回完话等多久再检查', unit: '秒', scale: 1000, min: 10, max: 1800, step: 10,
    default: 120000,   // 存的是毫秒（面板值 = 存储 / scale），别写成 120
    hint: '默认 120 秒。太短像是在抢话，太长话题已经过去了。',
  },
  {
    key: 'pacing.reply.continuation.bonus', group: '连续对话', type: 'float',
    label: '续聊倾向', unit: '', scale: 1, min: 0, max: 5, step: 0.1, default: 1.5,
    hint: '直接加到「要不要接」的分数上：越大越爱补一句；1.5 表示比普通主动接话更倾向于说。',
  },
  {
    key: 'pacing.reply.continuation.quoteLastHuman', group: '连续对话', type: 'bool',
    label: '补的话引用最后一条消息', default: false,
    hint: '开：续聊时挂一个引用，看起来像在接那个人的话；关（默认）：不引用，更像随口插一句。',
  },
  {
    key: 'pacing.reply.repeatEnabled', group: '主动接话', type: 'bool', label: '复读机（跟着刷屏）',
    default: true,
    hint: '开：群里连着几个人刷同一句话时，它跟着刷一句一模一样的（不走模型，几乎不花 token）。',
  },
  {
    key: 'pacing.reply.repeatMin', group: '主动接话', type: 'int', label: '几个人刷同一句才复读', unit: '人',
    min: 2, max: 10, step: 1, default: 3,
    hint: '数的是窗口内「同一句话」的条数（含刚进来的那条）。',
  },
  {
    key: 'pacing.reply.repeatWindowMin', group: '主动接话', type: 'int', label: '复读判定窗口', unit: '分钟',
    min: 1, max: 30, step: 1, default: 3,
    hint: '这些重复要发生在多少分钟内，太久了不算。',
  },
  {
    key: 'pacing.reply.repeatCooldownMin', group: '主动接话', type: 'int', label: '同群复读冷却', unit: '分钟',
    min: 1, max: 180, step: 1, default: 10,
    hint: '同一个群两次复读至少隔这么久，防它一直跟着刷。',
  },
  {
    key: 'pacing.reply.sensitivity', group: '主动接话', type: 'int', label: '语境敏感度（越高越挑时机）', unit: '%',
    scale: 0.01, min: 0, max: 100, step: 5, default: 0.45,
    hint: '先给群消息按语境打分（问句、正在热聊、它很久没说话…分高；@别人、纯表情分低），分够高才接。',
  },
  {
    key: 'pacing.reply.maxChars', group: '主动接话', type: 'int', label: '主动接话最多多少字', unit: '字',
    min: 20, max: 500, step: 10, default: 140,
    hint: '提示里要求它主动接话别太长；超了照发但会记日志。',
  },
  {
    key: 'pacing.reply.timeProfiles', group: '主动接话', type: 'json', label: '按时间段覆盖参数（JSON）',
    default: [],
    hint: '形如 [{"from":"09:00","to":"18:00","hourlyMax":1,"sensitivity":0.85},'
      + '{"from":"22:00","to":"02:00","hourlyMax":10,"sensitivity":0.3}]。跨零点用 from>22:00 to<02:00 写法。'
      + '可覆盖 hourlyMax/minGapMs/topicWindowMs/topicMinMsgs/sensitivity/coldSilenceMs/silenceEnabled/'
      + 'repeatEnabled/repeatMin/repeatWindowMin/repeatCooldownMin/maxChars。'
      + '优先级：群覆盖 > 时间段 > 全局。⚠️ 用面板「群体节奏」页改更直观。',
  },
  {
    key: 'pacing.reply.groupOverrides', group: '主动接话', type: 'json', label: '按群覆盖参数（JSON）',
    default: {},
    hint: '形如 {"1049951647":{"hourlyMax":2,"sensitivity":0.8,"repeatEnabled":false}}。'
      + '可覆盖：enabled/hourlyMax/minGapMs/topicWindowMs/topicMinMsgs/sensitivity/coldSilenceMs/'
      + 'silenceEnabled/repeatEnabled/repeatMin/repeatWindowMin/repeatCooldownMin。没写的字段沿用全局。'
      + '⚠️ 用面板「群聊」页的群卡片改更直观。',
  },
  {
    key: 'pacing.reply.groups', group: '主动接话', type: 'group', label: '允许主动接话的群',
    default: [],
    hint: '群号列表（空 = 没有群允许主动接话）。推荐在「群聊」页每张群卡片勾「允许主动接话」；这里和群卡片改的是同一份配置。',
  },
  {
    key: 'pacing.reply.style.splitEnabled', group: '主动接话', type: 'bool', label: '拆条（先短反应再补正话）', default: true,
    hint: '小概率把一条回复拆成两条发（先丢个短反应、隔一会儿补正话），治“每条一个路子”的机器感。',
  },
  {
    key: 'pacing.reply.style.splitProbability', group: '主动接话', type: 'int', label: '拆条概率', unit: '%',
    scale: 0.01, min: 0, max: 100, step: 5, default: 0.5,
    hint: '每次回话拆条的概率；太短的话不拆（见「高级」里的最小长度）。',
  },
  {
    key: 'pacing.reply.style.stickerProbability', group: '主动接话', type: 'int', label: '表情包概率', unit: '%',
    scale: 0.01, min: 0, max: 100, step: 5, default: 0.8,
    hint: '每轮回话有多大机会被提醒“可以配一张表情”；它也可以不发。',
  },

  // ── 主动接话·高级（控制台折叠在「高级」按钮里，一般不用动）─────
  {
    key: 'pacing.reply.topicWindowMs', group: '主动接话', advanced: true, type: 'int', label: '机会窗口（到点后再等多久时机）', unit: '分钟',
    scale: 60000, min: 1, max: 30, step: 1, default: 600000,
    hint: '到了机会点后在窗口里等一条“值得接”的消息；一直等不到就放弃这次机会（不硬凑）。',
  },
  {
    key: 'pacing.reply.topicMinMsgs', group: '主动接话', advanced: true, type: 'int', label: '窗口内至少几条消息才按话题接',
    min: 1, max: 20, step: 1, default: 3,
    hint: '窗口里消息太少就不按“话题”挑时机（防硬接）；冷场找话不受这条限制。',
  },
  {
    key: 'pacing.reply.style.splitMinLen', group: '主动接话', advanced: true, type: 'int', label: '拆条最小长度', unit: '字',
    min: 0, max: 200, step: 1, default: 12,
    hint: '短于这个字数的回复不拆条（太短了拆成两条很怪）。',
  },
  {
    key: 'pacing.reply.style.splitDelayMs', group: '主动接话', advanced: true, type: 'int', label: '拆条两条之间的间隔', unit: '秒',
    scale: 1000, min: 0, max: 10, step: 1, default: 1000,
    hint: '拆出来的第二条隔多久发；调大更像“打完一句再想一句”。',
  },
  {
    key: 'pacing.reply.style.stickerEnabled', group: '主动接话', advanced: true, type: 'bool', label: '回话时允许提醒发表情', default: true,
    hint: '关掉后主动回话不掷骰提醒发图（表情包子插件自己的总开关在「表情包」页）。',
  },
  // 9 项语境权重：只影响主动接话的“挑时机”，一般只调语境敏感度就够
  { key: 'pacing.reply.weights.intercept', group: '主动接话', advanced: true, type: 'float', label: '语境分：基础分（截距）', min: -5, max: 5, step: 0.05, default: -1.2005, hint: '所有加分项都从这一分开始；数越负整体越安静。' },
  { key: 'pacing.reply.weights.mentionBot', group: '主动接话', advanced: true, type: 'float', label: '语境分：提到它名字', min: -5, max: 5, step: 0.05, default: 1.5852, hint: '消息里出现它的名字/别名时加分（真 @ 或叫到走唤醒那条路，不看这些分）。' },
  { key: 'pacing.reply.weights.atOther', group: '主动接话', advanced: true, type: 'float', label: '语境分：@ 了别人', min: -5, max: 5, step: 0.05, default: -1.1157, hint: '群友在点名别人 = 不是冲它来的，减分。' },
  { key: 'pacing.reply.weights.hasQuestion', group: '主动接话', advanced: true, type: 'float', label: '语境分：在提问（问号）', min: -5, max: 5, step: 0.05, default: 0.4807, hint: '消息带问号 = 这话在等人回应，加分。' },
  { key: 'pacing.reply.weights.placeholderOnly', group: '主动接话', advanced: true, type: 'float', label: '语境分：只有表情/图', min: -5, max: 5, step: 0.05, default: -1.0281, hint: '只有表情包/图片、没有文字可接，减分。' },
  { key: 'pacing.reply.weights.selfRatio', group: '主动接话', advanced: true, type: 'float', label: '语境分：它自己的话占比', min: -5, max: 5, step: 0.05, default: 2.6525, hint: '近 5 分钟群里的话有多少是它说的；权重最大的一项。' },
  { key: 'pacing.reply.weights.recentCount', group: '主动接话', advanced: true, type: 'float', label: '语境分：群里刷屏程度', min: -5, max: 5, step: 0.05, default: -0.0367, hint: '近 5 分钟的消息条数；越刷屏越观望。' },
  { key: 'pacing.reply.weights.logSecondsSinceBot', group: '主动接话', advanced: true, type: 'float', label: '语境分：它多久没说话', min: -5, max: 5, step: 0.05, default: 0.0571, hint: '距它上次发言的秒数取对数；越久没说话越有信心。' },
  { key: 'pacing.reply.weights.pendingCount', group: '主动接话', advanced: true, type: 'float', label: '语境分：一次来几条', min: -5, max: 5, step: 0.05, default: 0.1012, hint: '它正在回一轮时又来消息 = 群里正热，小幅加分。' },

  // ── 其他（2026-10-20）：原来隐藏的 权限/门禁/文件/发图/头像 五组统一并到这一页 ──
  {
    key: 'info.other', group: '其他', type: 'info',
    text: '这里是低频 / 高级配置，按来源分组说明（每一项都有详细悬停解释）：\n'
      + '· 权限：主人 QQ —— 一般由内核按实例配置自动填，不用改。\n'
      + '· 门禁：屏蔽群 / 群内黑名单 / 群内白名单 / 全局允许用户 —— 「群聊」页每张群卡片也有同样的开关，改哪边都一样。\n'
      + '· 文件 / 发图：入站文件落盘目录、可发图片目录白名单。\n'
      + '· 头像：QQ 头像缓存目录与过期时长。\n'
      + '平时不用动；改错了热生效，且有配置备份可回滚。',
  },
]

// ============================================================
// 注册表 ②：动作按钮（需要 ops 的动作未配置时返回“本机未配置”，不是 500）
// ============================================================

/** @typedef {{id:string,group:string,label:string,hint?:string,confirm?:{title?:string,okLabel?:string},hidden?:boolean}} ActionDef */
export const ACTIONS = [
  {
    id: 'dream-run', group: '梦境', label: '🌙 现在做一次梦',
    hint: '立刻让她做一次梦（不等今晚的自动时刻）。会调用一次模型；做完可在「梦境」页看结果。',
  },
  {
    id: 'selfcheck', group: '运维', label: '跑离线自检',
    hint: '调用本机 ops 提供的离线自检（不碰 QQ）；未配置运维能力时点了会提示“本机未配置”。',
  },
  {
    id: 'clear-qq-sessions', group: '危险操作', label: '🧹 一键清空 QQ 对话',
    hint: '清空全部 QQ 线映射并归档这些会话（含游离会话）。点击后弹窗二次确认才执行；归档只影响侧栏显示、不删文件。',
    confirm: { title: '⚠️ 确认清空全部 QQ 对话？', okLabel: '确认清空' },
  },
  {
    id: 'cleanup-tmp', group: '运维', label: '🧽 清理临时文件',
    hint: '调用本机 ops 的清理能力（默认先预演，确认后才真删）。',
    confirm: { title: '⚠️ 确认清理临时文件？', okLabel: '确认清理' },
  },
  {
    id: 'dedup-baks', group: '运维', label: '🧹 备份代际去重',
    hint: '调用本机 ops 的备份去重能力（默认先预演，确认后才真删）。',
    confirm: { title: '⚠️ 确认删掉旧备份代？', okLabel: '确认去重' },
  },

  // 新手向导 / 连接自检（契约 §3.1）
  {
    id: 'napcat-check', group: '运维', label: '🔌 测试 NapCat 连接',
    hint: '向 NapCat 发一次 get_login_info：通了一次就能收到消息；失败会给出原因（未启动 / 地址错 / token 错）。',
  },
  {
    id: 'napcat-reconnect', group: '运维', label: '↻ 重新连接 NapCat',
    hint: '重连 NapCat 的 WebSocket（改完地址/token 但没自动重连时用）。',
  },
  {
    id: 'ensure-workspace', group: '运维', label: '📁 检查 / 创建 QQ 工作区',
    hint: '按「QQ 线工作区」路径在 DSH 侧栏注册工作区（已存在则复用，不重复创建）；「QQ 线工作区名称」是显示名。',
  },
  {
    id: 'check-host-deps', group: '运维', label: '🧪 检查运行环境',
    hint: '逐项检查「安装即用」需要的依赖：DSH 会话 / 工具 / 工作区 / preset 服务、内置 qq-chat、工作区自举、数据目录可写；'
      + '缺什么给出修复建议（可直接把结果交给 DSH，让它安装依赖）。',
  },
  {
    id: 'imagegen-check', group: '运维', label: '🖼 检查生图配置',
    hint: '校验协议 / 地址 / 模型 / API Key；必填都过了会再试一次 GET {base}/models（不通不算失败，只给提示）。',
  },
  {
    id: 'diagnose', group: '运维', label: '🩺 一键诊断 / 导出运维报告',
    hint: '检查配置、DSH preset、工具注册、NapCat 连接、人设、目录可写、生图配置，生成脱敏报告并告诉你保存位置；可直接交给 DSH 本体修复。',
  },

  // 隐藏动作（由控制台特定页面调用，不出现在按钮列表里）
  { id: 'reply-preset', hidden: true, group: '隐藏', label: '主动接话档位', hint: '内部动作：{id:"reply-preset", preset:"quiet|semi|active"}' },
  { id: 'reset-session', hidden: true, group: '隐藏', label: '重置单条会话', hint: '内部动作：{id:"reset-session", chat:"group:<群号>"}' },
  { id: 'welcome-images', hidden: true, group: '隐藏', label: '入群欢迎图片池', hint: '内部动作：列图片池目录' },
  { id: 'welcome-test', hidden: true, group: '隐藏', label: '模拟入群欢迎', hint: '内部动作：{id:"welcome-test", group_id, confirm?}' },
]

/** 控制台「运维」页要渲染的动作按钮（过滤隐藏项；confirm 透传给前端二次确认）。 */
export function visibleActions() {
  return ACTIONS.filter((a) => !a.hidden).map((a) => ({
    id: a.id, group: a.group, label: a.label, hint: a.hint || '', confirm: a.confirm || null,
  }))
}

// ============================================================
// 配置路径 → 白名单键（endpoints 的 group / memory 端点共用）
// ============================================================

/** 群管控写哪几段配置（v2 结构）。唤醒词落点 = `pluginConfig['gate-wake'].keywords`（文本行）。 */
export const GROUP_PATHS = {
  ignore: ['pluginConfig', 'gate-wake', 'ignoreGroups'],
  allowlist: ['pluginConfig', 'gate-wake', 'groupUserAllowlist'],
  blocklist: ['pluginConfig', 'gate-wake', 'groupUserBlocklist'],
  keywords: ['pluginConfig', 'gate-wake', 'keywords'],
  spont: ['pacing', 'reply', 'groups'],
  welcome: ['pluginConfig', 'group-welcome', 'groups'],
}

// ============================================================
// 子插件展开
// ============================================================

const defOf = (item) => (item && item.plugin) || item

/**
 * 全部**已发现**的子插件定义（含被配置停用的）。
 * 内核优先给 `kernel.pluginDefs`；退回 `kernel.pluginsAll`；最后退回 `kernel.plugins`（只有已加载的）。
 * @returns {{id:string, def:object, cfg:object|null, loaded:boolean}[]}
 */
export function pluginDefs(kernel = {}) {
  const out = []
  const seen = new Set()
  const add = (item, loaded) => {
    const def = defOf(item)
    const id = String((item && item.id) || (def && def.id) || '')
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push({ id, def: def && typeof def === 'object' ? def : {}, cfg: (item && item.cfg) || null, loaded })
  }
  if (Array.isArray(kernel?.pluginDefs)) for (const p of kernel.pluginDefs) add(p, false)
  if (Array.isArray(kernel?.pluginsAll)) for (const p of kernel.pluginsAll) add(p, false)
  if (Array.isArray(kernel?.plugins)) for (const p of kernel.plugins) add(p, true)
  // 插件定义（kernel.pluginDefs）里没有 cfg；把内核已加载条目的**已解析 cfg**（含默认值/绝对路径）补上，
  // 这样控制台某字段在 raw 没写时能回落到真正的运行时值，而不是 schema 里的相对默认值。
  const loadedCfg = new Map(
    (Array.isArray(kernel?.plugins) ? kernel.plugins : []).map((p) => [String(p?.id || p?.plugin?.id || ''), p?.cfg || null]),
  )
  for (const rec of out) if (!rec.cfg) rec.cfg = loadedCfg.get(rec.id) || null
  const order = (p) => Number(p.def?.order) || 100
  return out.sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id))
}

/** 核心项 → 注册项（内部形态；`configPath` 为 raw 配置点路径数组）。 */
function coreEntries() {
  return CORE_CONTROLS.map((c) => ({
    kind: 'core',
    key: c.key,
    // info 是纯说明块：不映射任何配置路径，读写都被挡（见 readValue/writeValue）
    configPath: c.type === 'info' ? null : String(c.key).split('.'),
    plugin: 'core',
    field: '',
    group: c.group,
    type: c.type,
    label: c.label,
    unit: c.unit || '',
    scale: Number(c.scale) > 0 ? Number(c.scale) : 1,
    min: c.min,
    max: c.max,
    step: c.step,
    options: Array.isArray(c.options) ? c.options : null,
    hint: c.hint || '',
    text: c.text,
    suggestions: Array.isArray(c.suggestions) ? c.suggestions : null,
    default: c.default,
    secret: c.secret === true,
    // 进阶项：控制台折叠显示（如「主动接话」页的「高级」按钮）
    advanced: c.advanced === true,
  }))
}

/** 子插件 configSchema → 注册项：key = `<插件id>.<字段>`，落到 `pluginConfig.<id>.<field>`。 */
function pluginEntries(kernel) {
  const out = []
  for (const { id, def, cfg } of pluginDefs(kernel)) {
    const schema = def?.configSchema
    if (!isPlainObject(schema)) continue
    const title = String(def.title || id)
    const hidden = HIDDEN_PLUGIN_FIELDS[id] || null
    for (const [field, fdef] of Object.entries(schema)) {
      if (!isPlainObject(fdef)) continue
      if (hidden && hidden.has(field)) continue // 权威配置在核心项里，见文件头
      // 插件字段可以映射到别的配置路径（例：生图凭据仍存 credentials.gptImage.*，
      // 但面板归属算 imagegen —— 这样「生图」页 = 一个子插件，旧配置零迁移）
      const configPath = fdef.type === 'info'
        ? null
        : (Array.isArray(fdef.configPath) ? fdef.configPath : ['pluginConfig', id, field])
      out.push({
        kind: 'plugin',
        key: String(fdef.key || `${id}.${field}`),
        configPath,
        plugin: id,
        field,
        title,
        cfg,
        group: fdef.group || title, // 不写 group 的字段按插件标题归组
        type: String(fdef.type || 'str'),
        label: fdef.label || field,
        unit: fdef.unit || '',
        scale: Number(fdef.scale) > 0 ? Number(fdef.scale) : 1,
        min: fdef.min,
        max: fdef.max,
        step: fdef.step,
        options: Array.isArray(fdef.options) ? fdef.options : null,
        hint: fdef.hint || '',
        text: fdef.text,
        suggestions: Array.isArray(fdef.suggestions) ? fdef.suggestions : null,
        default: fdef.default,
        secret: fdef.secret === true,
      })
    }
  }
  return out
}

/** 注册表全量（核心 + 子插件）。 */
export function allControls(kernel) {
  return [...coreEntries(), ...pluginEntries(kernel)]
}

/** 按 key 找注册项；找不到返回 null（写值时调用方负责抛“不在白名单”）。 */
export function findControl(kernel, key) {
  const k = String(key || '')
  return allControls(kernel).find((e) => e.key === k) || null
}

/** raw 配置里该注册项的**存储值**（子插件项缺键时退回内核已加载的插件 cfg，再退回 schema 默认值）。 */
function storedValue(entry, rawConfig = {}, kernel = {}) {
  if (entry.type === 'info') return undefined
  const raw = rawConfig || {}
  if (entry.kind === 'core') return getPath(raw, entry.configPath)
  const inFile = getPath(raw, entry.configPath)
  if (inFile !== undefined) return inFile
  const fromCfg = entry.cfg && entry.field ? entry.cfg[entry.field] : undefined
  if (fromCfg !== undefined) return fromCfg
  return kernel?.runtime ? getPath(kernel.runtime, entry.configPath) : undefined
}

/** 存储值 → 面板值（核心项按 scale 除；子插件项原样；秘密字段回显占位符）。 */
function panelValue(entry, rawConfig, kernel) {
  if (entry.type === 'info') return undefined
  const stored = storedValue(entry, rawConfig, kernel)
  let value = stored === undefined ? entry.default : stored
  if (entry.secret && value) return SECRET_MASK
  if (entry.kind === 'core' && entry.scale !== 1 && typeof value === 'number' && Number.isFinite(value)) {
    return round3(value / entry.scale)
  }
  return value
}

/** 按注册项的类型/范围归一**面板值**（不做 scale 换算 —— 换算在 writeValue 里一次性做）。 */
export function coercePanel(entry, raw) {
  const key = entry.key
  if (entry.type === 'info') throw new Error(`${key} 是说明块，不能写值`)
  if (entry.type === 'bool') {
    if (typeof raw !== 'boolean') throw new Error(`${key} 需要布尔值（true/false）`)
    return raw
  }
  if (entry.type === 'int') {
    const n = Number(raw)
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${key} 需要整数`)
    if (entry.min != null && n < entry.min) throw new Error(`${key} 不能小于 ${entry.min}${entry.unit || ''}`)
    if (entry.max != null && n > entry.max) throw new Error(`${key} 不能大于 ${entry.max}${entry.unit || ''}`)
    return n
  }
  if (entry.type === 'float') {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`${key} 需要数字`)
    if (entry.min != null && n < entry.min) throw new Error(`${key} 不能小于 ${entry.min}`)
    if (entry.max != null && n > entry.max) throw new Error(`${key} 不能大于 ${entry.max}`)
    return n
  }
  if (entry.type === 'str' || entry.type === 'text') {
    const s = raw == null ? '' : String(raw)
    if (/[\u0000]/.test(s)) throw new Error(`${key} 不能包含空字符`)
    return s
  }
  if (entry.type === 'enum') {
    const v = raw == null ? '' : String(raw)
    const hit = (entry.options || []).some((o) => String(o && o.value !== undefined ? o.value : o) === v)
    if (!hit) throw new Error(`${key} 不在可选项里：${v}`)
    return v
  }
  if (entry.type === 'json') {
    // 对象/数组类配置（例如按群覆盖表）：接受对象，或 JSON 字符串
    let v = raw
    if (typeof raw === 'string') {
      const t = raw.trim()
      if (!t) return entry.default && typeof entry.default === 'object' ? entry.default : {}
      try { v = JSON.parse(t) } catch { throw new Error(`${key} 需要合法 JSON`) }
    }
    if (v === null || typeof v !== 'object') throw new Error(`${key} 需要对象或数组`)
    if (JSON.stringify(v).length > 20000) throw new Error(`${key} 内容太大`)
    return v
  }
  if (entry.type === 'group') {
    // 群号列表这类：接受数组或逗号/空白分隔字符串 → 统一成字符串数组（去空、去重）
    const arr = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，\s]+/)
    const out = []
    for (const x of arr) {
      const s = String(x).trim()
      if (s && !out.includes(s)) out.push(s)
    }
    return out
  }
  throw new Error(`${key} 的控件类型未知：${entry.type}`)
}

/** 面板值 → 存储值（核心项按 scale 乘，子插件项原样 —— 见文件头单位口径）。 */
function storedOf(entry, panel) {
  if (entry.kind !== 'core' || entry.scale === 1 || typeof panel !== 'number') return panel
  const stored = round6(panel * entry.scale)
  return entry.type === 'int' && entry.scale >= 1 ? Math.round(stored) : stored
}

/**
 * 读一个白名单键的**面板值**（供 schema/status 与测试用）。
 * @param {object} kernel
 * @param {string} key
 * @param {object} [rawConfig]
 */
export function readValue(kernel, key, rawConfig = {}) {
  const entry = findControl(kernel, key)
  if (!entry) throw new Error(`不在控制台白名单里：${key}`)
  if (entry.type === 'info') return undefined // 说明块：Read 不产出
  return panelValue(entry, rawConfig, kernel)
}

/**
 * 写一个白名单键：校验/归一 → 返回该落在 raw 配置的哪个路径、存什么值。
 * **不落盘**（落盘由 admin/store.js 负责，方便先校验后备份）。
 * @returns {{key:string, value:unknown, stored:unknown, configPath:string[], unchanged?:boolean}}
 */
export function writeValue(kernel, key, value, rawConfig = {}) {
  const entry = findControl(kernel, key)
  if (!entry) throw new Error(`不在控制台白名单里：${key}`)
  if (entry.type === 'info') throw new Error(`${key} 是说明块，不能写值`)
  if (entry.secret) {
    const s = value == null ? '' : String(value)
    if (s === SECRET_MASK) {
      return { key, value: SECRET_MASK, stored: SECRET_MASK, configPath: entry.configPath, unchanged: true }
    }
    // 秘密字段允许直接写成空串（清空）或新值
  }
  const panel = coercePanel(entry, value)
  const stored = storedOf(entry, panel)
  if (isPlainObject(rawConfig)) setPath(rawConfig, entry.configPath, stored)
  return { key, value: panel, stored, configPath: entry.configPath }
}

// ============================================================
// 汇总：controls / groups / modules / actions
// ============================================================

/**
 * 原来的「隐藏组」：权限/门禁/文件/发图/头像 五组不再各占一页，而是统一并到「其他」页
 * （配置路径与插件读取逻辑完全不变，只是换了个面板入口 + 补详细悬停解释）。
 */
const OTHER_GROUPS = new Set(['权限', '门禁', '文件', '发图', '头像'])
const OTHER_LABEL = '其他'

/** 跟随「人设」显示在同一页（「总览」的人设区块下方）的分组。当前为空：句池 / 唤醒 已各自成页（子插件 1:1）。 */
const PERSONA_GROUPS = []

/** 控制面板值（含默认值回填；schema 端点直接返回它）。 */
function controlView(entry, rawConfig, kernel) {
  if (entry.type === 'info') {
    // 说明块：只带 text（前端渲染整行说明），没有 value/min/max/options
    return {
      key: entry.key,
      group: entry.group,
      type: 'info',
      label: entry.label || '',
      text: String(entry.text || ''),
      hint: entry.hint || '',
    }
  }
  const view = {
    key: entry.key,
    group: entry.group,
    type: entry.type,
    label: entry.label,
    unit: entry.unit,
    scale: entry.scale,
    min: entry.min,
    max: entry.max,
    step: entry.step,
    options: entry.options,
    value: panelValue(entry, rawConfig, kernel),
    hint: entry.hint,
    default: entry.default,
  }
  if (entry.kind === 'plugin') {
    view.plugin = entry.plugin
    view.field = entry.field
    // 字段映射到别的配置路径（key 不以 <插件id>. 开头）→ 标 mapped，前端/测试都别按老约定猜
    if (!String(entry.key).startsWith(`${entry.plugin}.`)) view.mapped = true
  }
  if (entry.secret) view.secret = true
  // 进阶项：控制台默认折叠在「高级」按钮里（比如主动接话的语境权重）
  if (entry.advanced) view.advanced = true
  // str 控件的输入建议（前端渲染 <datalist>）
  if (Array.isArray(entry.suggestions) && entry.suggestions.length) view.suggestions = entry.suggestions
  return view
}

/**
 * 子插件清单（控制台「子插件」页与「总览 → 可选模块」）。
 * `on` = 配置层面的启用态；`loaded` = 内核当前是否真的加载成功。
 */
export function collectModules(kernel, rawConfig = {}) {
  const raw = isPlainObject(rawConfig) ? rawConfig : {}
  const errs = kernel?.pluginErrors instanceof Map ? kernel.pluginErrors : null
  const loadedIds = new Set(
    (Array.isArray(kernel?.plugins) ? kernel.plugins : []).map((p) => String(p?.id || p?.plugin?.id || '')).filter(Boolean),
  )
  const list = []
  const seen = new Set()
  for (const { id, def } of pluginDefs(kernel)) {
    seen.add(id)
    const cfg = raw.pluginConfig && isPlainObject(raw.pluginConfig[id]) ? raw.pluginConfig[id] : {}
    const hardOff = Boolean(raw.plugins && raw.plugins[id] === false)
    const hasEnabled = isPlainObject(def.configSchema) && Boolean(def.configSchema.enabled)
    // on：raw 里没写过这个插件的配置时，用内核 pluginDefs 的 enabled（已考虑停用/插件级关闭）
    const cfgOn = cfg.enabled !== false && !hardOff
    const on = isPlainObject(raw.pluginConfig) && isPlainObject(raw.pluginConfig[id]) ? cfgOn : (def.enabled !== false && !hardOff)
    const order = Number(def.order) || 100
    const err = errs?.get?.(id)
    const defError = typeof def.error === 'string' && def.error ? def.error : null
    const loaded = loadedIds.has(id)
    list.push({
      id,
      title: def.title || id,
      label: `${def.title || id}（${id}）`,
      order,
      key: hasEnabled ? `${id}.enabled` : null,
      on,
      alwaysOn: !hasEnabled,
      loaded,
      lastError: err ? String(err?.message || err) : defError,
      desc: String(def.description || def.desc || ''),
      hint: `管线顺序 order=${order}｜${loaded ? '已加载' : '未加载'}`
        + (hardOff ? '｜插件级关闭（plugins.<id> = false）' : ''),
    })
  }
  if (errs) {
    for (const [id, e] of errs) {
      if (seen.has(id)) continue
      seen.add(id)
      list.push({
        id, title: id, label: id, order: 100, key: null, on: false, alwaysOn: false,
        loaded: false, lastError: String(e?.message || e), desc: '',
        hint: '插件加载失败（详见内核日志）',
      })
    }
  }
  for (const [id, v] of Object.entries(raw.plugins || {})) {
    if (v !== false || seen.has(id)) continue
    list.push({
      id, title: id, label: id, order: 100, key: null, on: false, alwaysOn: false,
      loaded: false, lastError: null, desc: '', hint: '在配置里被插件级关闭（plugins.<id> = false）',
    })
  }
  return list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/**
 * 汇总成控制台能直接渲染的 schema（形状对齐现网 /admin/schema 响应）。
 * @param {object} kernel
 * @param {object} [rawConfig] 实例配置 raw（v2；缺省用 kernel.raw）
 * @returns {{controls:object[], groups:{name:string,plugins:string[]}[], modules:object[], actions:object[]}}
 */
export function collectSchema(kernel, rawConfig) {
  const raw = isPlainObject(rawConfig) ? rawConfig : (isPlainObject(kernel?.raw) ? kernel.raw : {})
  // 权限/门禁/文件/发图/头像 → 统一并到「其他」页（配置路径不变，只是换分组）
  const entries = allControls(kernel).map((e) => (OTHER_GROUPS.has(e.group) ? { ...e, group: OTHER_LABEL } : e))
  const controls = entries.map((e) => controlView(e, raw, kernel))
  const groups = new Map() // group 名 -> Set<来源>（core / 插件 id），保持首次出现顺序
  for (const e of entries) {
    // PERSONA_GROUPS 当前为空（句池/唤醒 已各自成页）；机制保留：以后要折叠进总览的小组写这里
    if (PERSONA_GROUPS.includes(e.group)) continue
    if (!groups.has(e.group)) groups.set(e.group, new Set())
    groups.get(e.group).add(e.kind === 'core' ? 'core' : e.plugin)
  }
  return {
    controls,
    groups: [...groups].map(([name, plugins]) => ({ name, plugins: [...plugins] })),
    modules: collectModules(kernel, raw),
    actions: visibleActions(),
    // 跟随「人设」一起显示在「总览」页的组（不再单独成页）
    personaGroups: [...PERSONA_GROUPS],
  }
}
