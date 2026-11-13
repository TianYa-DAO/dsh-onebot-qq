# 本地开发副本 · dsh-onebot-qq

这是 QQ 插件（绘梨衣用的那只）的**完整源码**，包含我们在服务器上打的本地补丁。

## 基线

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/YUsaltyfish/dsh-onebot-qq |
| 基线提交 | `a153df0b`（2026-10-23，`fix(group-memory)` + 合并转发） |
| 版本号 | 0.1.1 |
| 要求 | node >= 22（本机 v24.21.0）、dsh `>=0.2.1-rc.2 <0.3.0` |

Git 历史：

```
580686e  upstream a153df0b (baseline)   ← 上游原样
ea65e64  local: 本地补丁                ← 我们加的
```

拉上游更新：

```bash
cd /home/ubuntu/dsh-onebot-qq-src
git remote -v                     # origin 已指向 GitHub
git fetch origin && git diff --stat HEAD origin/main
```

> ⚠️ 直连 GitHub 很慢/常断，可以走镜像：
> `git remote set-url origin https://gh-proxy.com/https://github.com/YUsaltyfish/dsh-onebot-qq.git`

## 我们改了哪 4 处（commit `ea65e64`）

### 1. `plugins/commands/index.js` — 非主人发命令静默
- `denyUnlessMaster()`：原来回「🙅 这个命令只有主人能用」，现在**直接 `ev.stopped = true` 静默吞掉**
- `/help` 权限 `any` → `master`
- 为什么：别人打个 `/help` 就能把机器人叫出来

### 2. `plugins/gate-wake/index.js` — 新增「必回群」
- 配置项 `alwaysReplyGroups`（控制台「唤醒」页）：命中的群**不再要求 @ 或唤醒词**
- wake 阶段最前面判定，命中直接 `ev.wake = { kind: 'always' }`
- 当前线上值：`["10001"]`（小默小洛群）

### 3. `plugins/gate-wake/index.js` — 撤回判定严格化
- 原来：只要消息里有「撤回」等词且是引用消息，就尝试撤回 → 群里聊到「撤回」会误触发，还把 NTQQ 原始报错吐进群
- 现在：**整条消息必须就是一句撤回指令**（去标点后 ≤8 字且匹配固定句式）
- 失败文案也软化了：`撤不动了，可能超过时间了` / `撤不掉了`

### 4. `plugins/gate-wake/index.js` — 戳一戳要说话
- 原来：被戳 → 只回戳一下就 `return`，对方看不到任何字
- 现在：**回戳（顺带）+ 一定从 `poke` 池回一句话**

## 怎么改、怎么上线

### 快速迭代（推荐）

```bash
cd /home/ubuntu/dsh-onebot-qq-src
# 改代码…
/home/ubuntu/dsh-onebot-qq-src/dev-deploy.sh
```

`dev-deploy.sh` 会：
1. 把源码同步到 `~/.dsh/profiles/web/node_modules/dsh-onebot-qq`（排除 node_modules/.git）
2. 排一个 40 秒后的 dsh 重启（detached，不会掐断你当前会话）
3. 打印新的登录链接

⚠️ **重启会断开当前 DSH 网页会话**，登录 token 会换（脚本会把新链接写进 `~/dsh-workspace/dsh-login-url.txt`）。

### 只改子插件、想热验证

子插件（`plugins/*/index.js`）是启动时 import 的，**改完必须重启**。改配置项不用重启（控制台热同步）。

### 测试

```bash
cd /home/ubuntu/dsh-onebot-qq-src
node --test            # 22 个测试文件
node --test test/audit-group-welcome.test.js   # 只跑一个
npm run check          # 语法 + 无密钥 + 打包检查
npm run verify         # 全量：测试 + 上面三项
```

### 从本地目录正式安装（不用 dev-deploy）

```bash
cd /home/ubuntu/dsh-0.2.1-rc.2
./node_modules/.bin/dsh plugin --profile web add /home/ubuntu/dsh-onebot-qq-src
```

⚠️ 这种装法会把目录**复制**进 node_modules，之后改源码还要重新 add 一次。日常迭代用 `dev-deploy.sh` 更快。

## 重要：永久安装 vs 本地副本

线上现在跑的是 `github:YUsaltyfish/dsh-onebot-qq`（进程里加载的是 node_modules 那份）。

- **`dsh plugin --profile web update dsh-onebot-qq` 会把 node_modules 那份覆盖回上游**，本地补丁全部丢失
- 所以：要么改用本地目录安装（`add /home/ubuntu/dsh-onebot-qq-src`），要么保留 `reapply-patches.sh`（现在还有 `onebot-patch-guard.timer` 每 10 分钟自动补）
- 你自己改源码之后，建议**直接改成从本地目录安装**，就别再 update 了

## 相关文件位置

| 东西 | 路径 |
|---|---|
| 源码 | `/home/ubuntu/dsh-onebot-qq-src` |
| 线上加载的 | `~/.dsh/profiles/web/node_modules/dsh-onebot-qq` |
| 人设 | `~/.dsh/dsh-onebot-qq/personas/绘梨衣.md` + `.lines.txt` + `.wake.txt` |
| 配置 | `~/.dsh/dsh-onebot-qq/config.json` |
| 群记忆 | `~/.dsh/dsh-onebot-qq/qq-memory/<群号>.md` |
| 表情库 | `~/.dsh/dsh-onebot-qq/qq-stickers/`（索引 `index.json`） |
| 补丁脚本 | `/home/ubuntu/napcat-setup/reapply-patches.sh [目录]` |
| 文档 | `docs/`（使用说明书 / 开发指南 / 配置参考） |

---

## 本地新增功能（不在上游里）

### 1. 群上文图片（`outbound.groupContextImages`）
群聊上文里的**真图**也会送进模型（原先只给「[图片]」占位）。
- `outbound.groupContextImages` 上限（默认 12，安全阀；上下文里有多少带多少）
- `outbound.groupContextImageMaxAgeMin` 只带这么多分钟内的图（默认 10）
- `outbound.imagePartsMax` 单轮总图上限（当前消息 + 上文，默认 12）
- 表情包不计入（已转成 `[表情:名]`）；提示里会标 `[上文图片]`，避免模型当成新图

### 2. 长期记忆（`plugins/mem-graph` + `/home/ubuntu/mem-graph/`）
每日归纳群聊/私聊 → 原子记忆 → 星图式联想（扩散激活）→ 200 天没被想起就淡出遗忘。
工具：`recall_memory(query)`。面板「记忆星图」页。

### 3. QQ空间（`plugins/qzone` + `/home/ubuntu/qzone/`）
看/发/删说说。服务 `qzd` 用 NapCat 的 cookie 算 g_tk，本地图 base64 直传。
- 工具：`qzone_list` / `qzone_post` / `qzone_delete`（发/删只认主人私聊）
- 按当日心情自动发：qzd 每天 `qz-config.json` 里的 `at` 时间（默认 21:30，±30 分钟）看当天记忆决定发不发
- 面板「空间」页：生成草稿、一键发、删除、开关、频率

### 4. 表情包喜好系统（`/home/ubuntu/sticker-admin/`）
策展时按**人设 + 口味档案**打 0~100 分；库满淘汰最低分到 `removed/`（不占 200 上限）；
她发某张时说「更喜欢/没那么喜欢」会调分；挑图按喜好加权。
- 口味档案：`sticker-admin/overrides/taste.md`（面板可改）
- 测试：`python3 sticker-admin/tests/test_prefs.py`

## 从上游摘取的功能（cherry-pick，非整体更新）

上游基线 `a153df0b` → 上游 HEAD `90f10fdfb`（2026-10-29，34 个提交）。我们**没有整体更新**
（上游做了 `napcat`→`onebot` 破坏性改名 + 表情库重写，会冲掉我们的补丁与喜好系统），
只摘了这三样：

| 摘取项 | 落点 | 说明 |
|---|---|---|
| **连续对话** | `kernel/pacing.js`（+130 行）、`index.js` 接线、`admin/schema.js` 4 个开关 | 真人叫过、她也回过话后，隔一会儿把新消息再判一次"要不要补一句"。适配了我们的**分层配置**（按群覆盖/时段也能生效）。默认关。 |
| **群记忆水位修复** | `plugins/group-memory/accumulate.js` 整文件换成上游版 | 消息指纹去重（同秒/乱序/轮转不再重复或漏读）+ `seenMessages` 检查点。我们只补回 `skipGroups` 一处本地改动。 |
| **`list_images`** | `plugins/imagegen/index.js` | 按需列本机图片（参考图/工作区/上传/头像），不再每轮往 prompt 塞图库清单。适配：本内核没有 `bot.shared.uploadDir`，退回 `file-transfer.uploadDir` 配置。 |

新增测试：`test/local-continuation.test.js`（5 条，含防"自转"闸门）。

### 第二批摘取（2026-11-05）

| 摘取项 | 落点 |
|---|---|
| **媒体字节上限** | 新增 `kernel/media-bytes.js`；`file-transfer` 入站文件、`stickers` 采集都改成**边读边掐**（不信声明 size / Content-Length） |
| **`send_message` 带 sticker** | 内核 `send_message` 新增 `sticker` 参数；`stickers` 抽出 `sendStickerTo()` 并注册 `bot.shared.stickerSend`（`send_sticker` 工具改为复用） |
| **删除视频识别插件** | 移除 `plugins/video-read`、`plugins/video-link-read` 及对应测试（上游 10-29 删除） |
| **link-parser 视频拆条** | 整文件换上游版：视频各自一条 → 图片一条 → 说明最后（协议端要求 video 必须是唯一 segment） |
| **`/history` 上限 200→500** | `plugins/commands/index.js` |

新增测试：`test/local-media-limit.test.js`（5 条）、`test/local-msg-sticker.test.js`（2 条）、`test/local-link-video-split.test.js`（1 条）。

**没摘的**（上游有但我们不采用）：`napcat`→`onebot` 改名重构、SnowLuma 协议端兼容、
表情库重写（`shelf.js`/索引只存标签/删黑名单/收表情开关）、`splitMaxParts` 拆条上限、
`imagegen.extraBody`、主人生图免冷却、媒体字节上限（`media-bytes.js`）、
群欢迎计时器清理、好友门禁严格模式、`send_message` 带 sticker、
删除 `video-read`/`video-link-read`、link-parser 视频拆条、控制台秘密字段遮蔽。

### 跨天时段改进（2026-11-05，我们自己实现的，上游没有）

| 改进 | 落点 | 说明 |
|---|---|---|
| **「跨天时段算在开始那天」开关** | 内核 `kernel/pacing.js` + 面板 `profileForm/readProfileForm/profileMatches` | 勾上后 `22:00~02:00` 勾「周五」= **周五 22:00 → 周六 02:00**（周五晚上整段）。不勾保持旧语义（星期按日历那天算）。存 `ownStartDay: true`，默认 false，现有配置不受影响 |
| **实际覆盖窗口显示** | 面板 `weekCoverage/coverageWindows/profileCoverageText/profilesCoverageSummary/coverageSummaryHtml` | 每条时段下方显示「实际覆盖：周五 22:00 → 周六 02:00」；整表下方显示合并覆盖 + **断档提示**（哪些时间段不生效） |

新增测试 `test/local-timeprofile-ownstart.test.js`（6 条，钉死两种语义 + `profileCoverage` 边界）。

### 合并转发（群上文本地修，2026-11-09）

线上反馈：群里有人转了一份聊天记录，她"看不了合并转发的聊天记录"。

| 场景 | 修前 | 修后 |
|---|---|---|
| @她 + 同一条带转发 | ✅ | ✅ |
| 引用一条转发再问她 | ✅ | ✅ |
| **转发出现在群上文里** | ❌ 只有 `[合并转发]` 占位符 | ✅ 正文按条读出来 |

根因：`extractText` 是纯函数（不碰网络），forward 段只产出占位符；`fetchGroupContext` 又只取 `parsed.text` → 正文丢掉。

修法（`kernel/dsh-driver.js`）：
- 新增 `resolveForwardText()`：**内联 `data.content` 优先**（真机主路径），没有再回退 `get_forward_msg`
- 10 分钟 LRU 缓存（`FWD_CACHE`，上限 200）：同一条转发被反复读上文时不再重复打接口
- 窗口改为**按消息条数**取（原来平的 `lines.slice(-count)`，一条转发带 8 行正文会把别的消息挤出去甚至截断自己）
- `resolveForwardText` **绝不抛出**：曾因模块级函数里 `log.debug` 触发 ReferenceError，
  被外层 catch 吞掉后**整段群上文消失**（取不到一条转发 ≠ 丢掉全部上文）

测试：`test/local-forward-context.test.js`（5 条：内联/只有id/缓存/长转发不挤窗口/取不到不崩不塞垃圾）

### 部署验证自动化（2026-11-11，解决"重启后没人确认"）

**问题**：以前"重启后去确认服务好了"依赖 agent 自己记得立提醒；会话一中断（bash 被中断/上下文丢失）就没人验证了。**发生过两次。**

**现在的机制：不依赖任何人的记忆 —— 由 systemd 自己跑。**

```bash
./dev-deploy.sh          # 唯一允许的部署方式
```

它会：
1. 语法自检 → rsync 同步 → 重打补丁
2. 写 `~/.dsh/dsh-onebot-qq/deploy-pending.json`（本次部署的 commit / 改了哪些文件）
3. 排定 40 秒后重启（`dsh-restart-<ts>`）
4. **自动排定验证**（`dsh-verify-<ts>`，55 秒后跑 `scripts/post-deploy-verify.sh`）

验证内容 | 判据
---|---
dsh-web 起来了 | `systemctl is-active`，最多等 150s
插件全加载 | 日志里有「内核就绪」且 `插件 13/13`
无启动异常 | 本次启动后 ERROR/Traceback 计数 = 0
线上副本与源码一致 | `diff -rq` 无 `*.js differ`
NapCat 连接 | 「NapCat WS 已连接」（没有只提示，不算致命）

**结果落三处**（谁都能查，不用问我）：

| 位置 | 用途 |
|---|---|
| `~/.dsh/dsh-onebot-qq/deploy-last-result.json` | 机器可读（ok / failures / pending）|
| `~/dsh-workspace/部署验证日志.md` | 人可读，追加，自动裁到 20KB |
| `~/dsh-workspace/⚠️部署验证失败.txt` | **只在失败时出现**，显眼 |
| `~/dsh-workspace/任务看板.md` 顶部 | 一行状态：`✅ 通过 / ❌ 失败 · 时间 · 启动于 · 异常 N 条` |

再加一道：验证失败 → systemd 单元退出码 1 → `systemctl --failed` 能看到。

**规则**：不要再手工 `systemd-run` 重启，也不要靠"我一会儿去确认" —— 走 `./dev-deploy.sh`，验证是它的事。

### QQ空间变成她的能力（2026-11-11）

需求：把「发说说」从"主人的指令"变成**她自己的能力**，写进 `qq-chat` 预设 —— 她想发就发。

改了四处：

| 位置 | 改动 |
|---|---|
| `cordis.patch.yml`（qq-chat 预设的 persona.prefix） | 新增「你的 QQ 空间」段：什么时候发 / 怎么写 / 不该发什么 / 别人让她发怎么办 / 频率 / 发完不复述 |
| `plugins/qzone/index.js` | ① 新配置 `allowSelfPost`（默认开，兜底可关）② 放开 `isMasterTurn` 硬闸：非主人会话也能发，但必须过**共享额度** ③ `postQuota()` 读 qzd 的 `maxPerDay`/`minGapHours` 与 `feeds` 实际记录 |
| `/home/ubuntu/qzone/qzd.py` | **移除夜间自动发帖线程**（改成她在对话里自主发；保留 `auto_post_once` 给面板手动试） |
| `personas/绘梨衣.md` | 删掉「只有主人问起才发」，改成「想发就自己发 + 别人让发就不发」 |

**额度是硬约束**（防她一天发几条）：一天最多 1 条、跟上一条隔 18 小时。超了工具直接报错告诉她下次，
面板 `空间` 页可调（卡片已改成「发说说额度」，不再有"每天 21:30 自动发"的开关）。

测试：`test/local-qzone-selfpost.test.js`（5 条，全部用本地 mock qzd，**绝不真发到她空间**）：
额度够能发 / 日上限拒绝 / 间隔不够拒绝 / 关开关退回旧行为 / 主人私聊不受额度限制。

⚠️ **预设文本只对新建会话生效**：改预设后必须重启 dsh（`./dev-deploy.sh` 会做），
旧会话还带着老 prompt，必要时 `/reset` 一下。

### 防空转：自言自语退避 + 沉淀只认别人的话（2026-11-11）

主人提出的问题：**「主动接话 → 半小时沉默 → 录入记忆 → 又主动接话 → 又录入」会不会空转？**
查下来比预想严重 —— 两个机制确实互相喂：

**① 冷场判定原本只看 `lastInboundAt`（别人最后说话），她自己发的话不算**
→ 她在死群里说一句之后，群照样"安静"，下一个窗口又能说 → 实测配置下**每 10 分钟自言自语一次，无上限**。

修法（`kernel/pacing.js`）：
- 她主动接话真的发出去 → `proactiveUnanswered += 1`（`noteReplySent` 里按 `wakeKind==='proactive'` 记）
- 有人说话 → 清零（`noteInbound`）
- 下一次冷场要求的时间 = `coldSilenceMs × 2^n`，**锚点是「她自己上次主动说话的时刻」**（`lastProactiveAt`）
  - ⚠️ 第一版锚在"最后一条人类消息"上，那是错的：那个时间只会越走越远，乘几倍都永远满足 = 等于没退避
- n ≥ 3 → 彻底不说了，等有人开口

**② 会话级沉淀原本会把她自己的话也当成"这一轮聊完了"**
→ 接话 → 30 分钟后沉淀 → 再接话 → 再沉淀，记忆被灌成她的自言自语。

修法（`plugins/group-memory/accumulate.js`）：
- `idleCandidates` 只数**别人**的消息（`!r.out`），且要求 ≥ `accumulateIdleMinMsgs`（默认 3）
- 最后一条是她说的 → 不触发（她刚自言自语完，没有新信息）
- `runRound` 在 `trigger==='idle'` 时用这个较低门槛（固定间隔那轮仍用 `minNewMsgs` 默认 20）

测试：`test/local-selftalk-backoff.test.js`（4 条：首次能发 / ×2 退避 / 三次后闭嘴 / 有人说话清零）、
`test/local-memory-idle.test.js` 追加 2 条（只有她的话不沉淀 / 别人够 3 条才沉淀、她收尾则不沉淀）。

#### ⏰ 重启/部署铁律（主人要求，2026-11-11）

**顺序不能反**：

1. 先给**自己**立一次提醒：`schedule_create(after_seconds=110, prompt="重启后验证：dsh active？插件13/13？异常？汇报给主人")`
2. 再跑 `./dev-deploy.sh`（它自己会排 systemd 验证）
3. 等提醒回来 → 读 `~/.dsh/dsh-onebot-qq/deploy-last-result.json` → 汇报

为什么两条都要：systemd 验证保证**结果一定落盘**（会话中断也不丢），
我自己的提醒保证**结果被读出来、被汇报**（否则用户不问就没人说）。

### 例行检查发现并修掉的 4 个问题（2026-11-11 夜）

| # | 问题 | 性质 | 修法 |
|---|---|---|---|
| 1 | 退避按**条**计数 | 我今天引入的真 bug | 拆条一轮发 2~3 条会调 2~3 次 `noteReplySent` → 一轮就攒满"三次没人接"→立刻闭嘴。改成用 `WeakSet` 按 `turnCtx` **每轮只算一次**（拿不到对象时用 60 秒窗口兜底）|
| 2 | idle 沉淀**推进轮转游标** | 我今天引入的真 bug | `runRound` 里 `cursor = ids[last]` 对 `only=[某群]` 也生效 → 打乱 8 小时那轮的公平分批。改成只在全量轮转时推进 |
| 3 | 验证脚本「NapCat WS」假失败 | 我埋的（已修） | systemd active 比 WS 连接早 ~1 秒 → 轮询 30 秒 |
| 4 | 验证脚本「内核就绪」假失败 | 我埋的（本次修） | systemd active 比插件加载完早 ~15 秒 → 轮询 60 秒。**22:26 那次部署就误报了 ❌**，手动重跑恢复 ✅ |

**教训**：验证脚本里凡是"另一个进程稍后才产生"的信号（WS 连接、内核就绪），都必须**轮询**，不能查一次就判死。

### 上游镜像（2026-11-12 起，不再走 GitHub API）

上游仓库克隆在 `/home/ubuntu/upstream/dsh-onebot-qq`（直连可 clone，1.7MB）。

```bash
cd /home/ubuntu/upstream && ./upstream-sync.sh          # 拉取 + 只看自上次看过的增量
./upstream-sync.sh --full                              # 自我们基线 a153df0 以来的全部
./upstream-sync.sh --files                             # 额外列改动文件
```
脚本会 `git fetch`、列新提交、给 shortstat 与按目录统计、抽 CHANGELOG 新增小节，并把 HEAD 记进 `.last-seen`。

### 摘了上游 11-09 的「撤回误伤」修复（2026-11-12）

**事故**：群友引用别人的消息、正文写「撤销工具」→ **别人那句被撤了**。

我们原来的实现只查正文（没查被引消息是谁发的），所以「引用别人的消息 + 说一句撤回」就会把**别人的**消息删掉（越权）。

修成**两道闸**（比上游更严）：
1. 正文必须**整条就是一句撤回指令**，动词只认 `撤回 / 撤了`（`撤销/回收/删除/撤掉` 不算，技术讨论里太常见）
2. 反查被引消息（`msgById`），**必须是本机自己发的**；反查不到 = 当不是本机 → 静默跳过，交给正常对话

**顺带修掉一个真 bug**：原正则要求「这条」在「撤回」**前面**（`这条撤回`），而中文最自然的是**「撤回这条」** → 最常见的说法一直撤不掉（这也是 `WAKE-RECALL` 测试长期失败的真因，不是测试的锅）。现在两种语序都认。

测试：`test/local-recall-gate.test.js`（4 条：自己发的能撤/别人的不撤/反查不到不撤/非命令不撤）

### 测试首次全绿（318/318）

`CMD-1 /help`、`CMD-2 非主人命令`、`WAKE-RECALL` 三个"长期已知失败"全部修掉：
- CMD-1/CMD-2 是**上游测试没同步我们 fork 的意图**（我们 `/help` 仅主人、非主人**静默吞掉**）→ 按本地意图重写测试
- WAKE-RECALL 是上面那个正则 bug → 修复后通过

### 摘 #2/#3/#4（2026-11-12）

**#2 免打扰 —— 按她自己的作息，不是死钟点**（`kernel/pacing.js`）

主人要的是「她可以熬夜、也可以不熬夜」，所以：
- 基线睡点/醒点（默认 01:30 / 09:30）+ **每天按日期确定性抖动 ±90 分钟** → 有时十二点就睡、有时两点才睡
- **周末整段后移 60 分钟**（周末熬夜）
- **只拦「冷场找话」**：夜里群里有人聊 → 话题接话照旧能接（熬夜陪着）；没人说话才安静（去睡）
- 正常回话（有人叫她）**完全不受影响**
- 面板可调：`pacing.reply.quiet.{enabled,start,end,jitterMin,weekendShiftMin}`；启动日志会打印「她的作息=HH:MM~HH:MM」

**#3 每日互动记忆**（`plugins/group-memory/daily.js` 等，摘自上游戏 2026-11-10）
- `accumulateSchedule: 'daily'`（**新默认**）→ 每天 `accumulateDailyTime`（默认 04:00，`Asia/Shanghai`）逐会话整理互动
- 三区：稳定记忆 / 近期记忆（默认保留 14 天）/ 约定与承诺；结构化增删改 + 按来源校验，比"整篇重写"更不容易漂移
- 支持独立记忆分析模型（`accumulateModelProvider` + `accumulateModel`，成对填写；留空跟随日常模型）
- 旧行为仍在：`accumulateSchedule: 'interval'` → 原「每 N 小时 + 聊完就收」；会话级沉淀（tickIdle）只在 interval 模式生效

**#4 私聊记忆 + 每会话开关**（`plugins/group-memory/index.js`）
- 私聊也有长期记忆：`<记忆目录>/private/<QQ>.md`（与群记忆分目录，防群号/QQ 号撞数字）
- `read_memory` 支持 `private:<QQ>`；仍**只能读本轮会话**那一篇（跨会话一律拒）
- 每个会话可单独关：`mutedChats: ['group:123', 'private:456']` → 不注入指针、不读、不积累（已有文件仍可直接读盘）
- 指针话术分群/私聊两种

测试：`test/local-quiet-hours.test.js`(7) + `test/local-daily-memory.test.js`(7) + `test/local-private-memory.test.js`(4)；
老的间隔模式测试显式钉成 `accumulateSchedule: 'interval'`（它们测的是旧实现）。全量 **336/336 全绿**。

### 活人感四项（2026-11-12，主人定的）

**① 作息＝随机游走（不是固定点 ± 抖动）**　`kernel/pacing.js`
- `今天睡点 = 昨天睡点 − 回拉力×(昨天−基线) + 正态步(σ=driftMin) + 周末加成`
- 通宵：每天 `allNighterPct`%（默认 4）整夜不睡；通宵那天不算睡；**第二天补觉式早睡**（往前拉 2~4 小时）
- 睡眠时长也跟着走 + 强回拉到基线，抖动 σ=35min，夹在 5.5~9.5 小时
- 状态落 `state/pacing-rhythm.json`（按天算一次，同一天绝不重抽）
- 面板 11 项：基线睡点/时长、游走幅度、回拉力、时长浮动、上下限、通宵概率、临界点…

**② 睡觉时被叫不回，醒了补回**　`kernel/pacing.js` `submit` / `tick`
- `quiet.wakeOnCall`（默认开）：睡着时 `@/引用/唤醒词` 都不回，消息进 `sleepQueue`（每会话上限 50 条，超 12 小时丢弃）
- 醒了 → `tick` 排空：**每个会话合成一轮**，hint 里给"你刚睡醒，睡着时有人找过你，共 N 条"＋逐条时间/发送者/正文，让她一轮里发多条回
- 睡前临界点 `bedtimeGraceMin`（默认 30）：能回，但 hint 提示"还有约 N 分钟，回短一点、可以带困意"
- `wakeOnCall: false` → 睡觉只影响"主动找话"，被叫立刻回

**③ 群消息机制：混合**（保留我们的自适应等待 + 摘上游两条）
- **群聊各自成轮**：群里又来一条唤醒 → 上一轮立刻发车、这条另开新槽（不再"两个人叫我只回一条"）
- **图片按条归属**：合批时注入 `[合批图片归属] 第 1~2 张来自 甲(QQ:…)；第 3 张来自 乙(QQ:…)`
- 私聊仍不合批；等待仍是自适应 2s/4s/6s（比上游固定 5s 更跟手）

**④ 表情挑图三改进**　`plugins/stickers/index.js`
- **忽略泛化标签**（表情包/搞笑/可爱/meme… 命中这些不算数）
- **优先具体标签**：候选池只留"有具体标签"的图，按标签具体度加权（喜好分仍是主因）
- **减少同图连发**：同会话最近发过的最多重抽 2 次

测试：`local-quiet-hours`(7) + `local-sleep-gate`(5) + `local-sticker-pick`(6)；全量 **347/347 全绿**。

### 私聊主动 + 消息监测（2026-11-12 晚）

**私聊主动聊天**　`kernel/pacing.js` `tickPrivate` + `index.js` `runProactiveTurn` 私聊分支
- 配置 `pacing.reply.privateAllow`（QQ 名单，留空=不主动私聊任何人）+ `privateColdHours`（默认 6 小时）
- 纪律比群里更克制：**只有聊过的人**才会被想起（要有 lastInboundAt）；睡觉不发；没回音 ×2/×4/×8 退避，三次不打扰；不算"抢话时机窗口"（私聊没人在说话）
- 启动时 `seedPrivateBaseline()` 从 `private_<QQ>.jsonl` 播种最后说话时间
- 内核 `runProactiveTurn` 私聊分支：`isGroup:false`、从归档拼最近 12 条作上文、提示语换成"你和这个人有一阵没说话了"

**消息监测规则**（**直接抄上游** `plugins/message-monitor/`，插件数 13→14，order 57）
- `matcher.js` 原样保留；`index.js` 只改两处：`bot.onebot`→`bot.napcat`、`rules`→`rulesJson`（JSON 文本框）
- 语义：只在配置的群里匹配；`contains`/`exact`；首条命中生效；同规则同群默认 30 秒冷却（`cooldownMs` 可配）；命中 → `ev.wake={kind:'monitor'}` + hint 注入附加指令（标明"控制台配置，不是发送者发言"+消息ID）
- 不覆盖已有唤醒（被 @ 了以 @ 为准）；空规则/解析失败 = 不监测不崩

**验证脚本**：插件数不再硬编码 13，改成"已加载 == 总数"（N/N），插件增减不用改脚本。

测试：`local-private-proactive`(6) + `local-message-monitor`(8)；全量 **361/361**。

### 控制台（面板）同步（2026-11-12 晚）

**坑：面板不认识 `list` / `num` 两种控件类型**（`sticker-admin/static/index.html` 的 `ctlWidget` 只认 `bool/enum/text/group/int/float/info`），
用错类型会退化成纯文本框、数组也存不对。已全部改掉：

| 配置项 | 原来 | 改为 |
|---|---|---|
| `pacing.reply.privateAllow` | `list` | `group`（逗号分隔数组）|
| `group-memory.mutedChats` | `list` | `group` |
| `quiet.baseSleepHours / minSleepHours / maxSleepHours` | `num` | `float` |

**状态页新增三行**（`static/index.html` `viewStatus`）：她的作息（今天几点睡~几点醒 + 现在睡着/醒着）、私聊主动（名单 + 冷场小时）、消息监测（几条规则在跑）。
数据来源：`pacing.stats()` 现在带 `privateAllow` / `privateColdHours` / `quiet`。

**新配置在面板的位置**：
- `状态`：她的作息 / 私聊主动 / 消息监测（三行总览）
- `配置` → 「主动接话」组：作息 11 项 + 私聊 2 项
- `配置` → 「群记忆」组：积累调度（每日/间隔）、每日执行时间、时区、近期天数、记忆分析模型、单独关掉记忆的会话
- `配置` → 「消息监测」组：开关 + 监测规则（JSON）
- `模块`：14 个子插件（新增 message-monitor）

**纪律**：加插件配置项时，`type` 只能用面板认识的 7 种；数组用 `group`，多行文本用 `text`。

### 兴趣画像 + 自主起念 + 半夜自己醒（2026-11-12 夜）

**她自己决定喜欢什么**（`kernel/pacing.js` 兴趣模块 + 两个新工具）
- 状态文件 `state/pacing-interests.json`：`topics[{name,score,why,at}]` / `people[{qq,name,affinity,why,at}]`
- 工具 **`interest_note`**（她随时可写）：`{kind:'topic'|'person', name, qq, delta(-50~50), why}`；
  **`interest_view`**：看自己现在在意什么
- 时效衰减：每天淡 2 分（不主动碰就慢慢忘，跟人一样）
- 人设前缀（preset `qq-chat`）加了「你自己的兴趣和念头」：**是她的判断，不是主人的任务**；没人叫她时想开口就开口，不想就算了；半夜醒了可以半梦半醒说一句

**自主起念**（不再只等调度器）
- `tickDesire`：清醒时按概率（每分钟 6%）冒念头 → 按**兴趣分**挑目标（兴趣最高的人 / 话题所在的群）→ `reason='desire'`
- 提示语：「[你自己想说话] 没人叫你，是你自己突然想起一件事/一个人」+ 她在意的话题/人
- 约束：`minGapMin`(150) / `hourlyMax`(1) 限速；`wake.kind` 仍是 `proactive` → 退避/最多 2 条等既有约束照旧生效

**半夜自己醒（夜醒）**
- 每晚 `nightWakePct`（默认 12%）概率半夜醒来 `awakeMinMin~awakeMaxMin`（20~60 分钟）
- 醒来这段时间 `sleepingNow()` 为 false：**能主动说话、也能回话**（别人这时找她会收到回应）
- 一晚只醒一次（`nightWokeDay` 记在 rhythm 文件）；醒完继续睡
- 提示语：「[夜醒] 你半夜醒了，睡不着，拿起手机看了看……想发就说点什么（可以是没头没尾的、半梦半醒的、或者就一句睡不着）；不想发就翻个身继续睡」

测试：`test/local-desire.test.js`(7)；另把 quiet/selftalk 两个测试显式关掉 desire（它们测别的机制）。全量 **368/368**。

### 私聊门槛的随机抖动（2026-11-12）

- 新配置 `pacing.reply.privateColdJitterMin`（默认 **30** 分钟，面板「主动接话」组）
- 实现：`privateColdMsFor(qq, now)` = 基线(6h) ± 抖动，按 **「当天 + 这个人」确定性**抽样：
  · 同一天内反复 tick 不会来回跳（否则门口会闪）；
  · 不同天、不同人门槛不同 → 不会每次都卡在同一分钟想起他；
  · 指数退避（×2/×4/×8）仍然基于这个抖动后的门槛。
- 测试：跨 20 天在"刚好 6 小时"这个点，有的天触发、有的天还没到（证明抖动真的生效）；
  抖动=0 时门槛固定；±30 分钟时超过 6.5 小时必触发。全量 **371/371**。

### 每日模式也支持「会话级沉淀（闲置触发）」（2026-11-12）

**问题**：`accumulateIdleMin` / `accumulateIdleMinMsgs` 这两个设定之前**只在 interval 模式生效** ——
切到 daily（新默认）后 `accumulate.tickIdle` 不存在 → `bot.shared.memoryAccumulateTickIdle = undefined`，
"聊完就收"静默失效（没报错，最容易被忽略）。

**修法**（`plugins/group-memory/daily.js`）：
- `round(kind, only)` / `trigger({trigger, only})`：支持只处理点名的会话（不碰轮转游标、不限批量）
- 新增 `tickIdle()`：扫归档 → 找「安静 ≥ `accumulateIdleMin` 分钟 + 未消化互动 ≥ `accumulateIdleMinMsgs` 条」的会话
  → `trigger({trigger:'idle', only:[...]})` 真去沉淀（每次最多 3 个会话）
- 60 秒定时器里：没到每日点就跑 `tickIdle()`（与 interval 模式同一套节奏）
- 纪律：最后一条是她说的先不收；同一会话 10 分钟冷却；`accumulateIdleMin: 0` 关闭
- `status()` 带上 `idleMin` / `idleMinMsgs`（控制台可见）

测试：`test/local-daily-idle.test.js`(7)；全量 **378/378**。

> **教训**：切换积累模式时，要检查"哪些能力只挂在旧实现上"。这次是 `tickIdle` 静默消失 —— 功能没报错，但行为变了。

**私聊同样走这条链路（已实测）**：`archives()` 收 `private_<QQ>.jsonl` → 会话键 `private:<QQ>` →
闲置触发时只沉淀那个私聊 → 写 `qq-memory/private/<QQ>.md`。
2026-11-12 18:35:55 线上实测：`[群记忆] 会话级沉淀（闲置）：private:10002` → 文件已生成。

⚠️ 每日模式**建基线时不追溯旧历史**（`baselineAt` 之后才算），所以刚切过来的头一两天私聊/群记忆条目会偏少；
旧归档（比如主人私聊的 536 行）不会被一次性补录，这是上游设计（避免第一天就把历史全灌进去）。

### 私聊合批（2026-11-12 夜，主人追问「私聊有合批吗」）

**原来没有**：`submit()` 里 `if (!c.enabled || !ev?.isGroup || selfInitiated) return run(ev)` ——
私聊每条唤醒**立即起一轮**。他连打三行 → 她回三次（像抢话）。

**现在**（与上游语义对齐）：
- **私聊 = debounce 合批**：窗口内每来一条新消息都并进同一轮并**刷新等待**，等他安静下来一次性入站 → 只回一次
- **群聊 = 各自成轮**（不变）：两个人群里叫 → 各回各的（`ev.isGroup` 才触发"上一轮发车、这条另开新槽"）
- 单条消息（距上一条 > `skipIfSlowMs` 30s）→ **直接答**，不做无谓等待
- 合并正文前缀：私聊用 `[昵称(QQ:号)]`，群聊保持原样

**面板位置**：「消息设置」组
- `合批等待（冷清时）` windowMs（默认 800ms）
- `合批等待（对话进行中）` windowActiveMs（默认 4000ms）← 他打字快慢主要看这个
- `合批最长等待` maxWaitMs（默认 6000ms，硬上限）
- `慢群不等阈值` skipIfSlowMs（默认 30000ms）

测试：`test/local-private-merge.test.js`(3)——连发三条只起一轮且三条都在 / 单条直接答 / 群聊仍各自成轮。
顺带修了 `local-daily-idle` 的脆测试（写死时间导致数据落在 baseline 前被过滤）。全量 **383/383**。

### 私聊合批的**真 bug**（2026-11-12 夜，主人反馈「感觉没合批」后查出来的）

**症状**：主人连发 4 句（"在学习" → 1 秒后"刚学完数学" → …），她分成两轮回，体感"没合批"。

**根因**：`skipIfSlowMs`（默认 30 秒）的语义是"距上一条超过 30 秒 → 判定为新话题、立即回答"。
私聊里主人**隔了几分钟才发第一句** → 第一句被立刻起轮；后面几句（1~4 秒后到）来不及并进去。

**修法**（`kernel/pacing.js` `submit`）：
- **私聊不受 `skipIfSlowMs` 影响**：一律走 debounce 窗口（群里保留冷场快答，抢答太快像刷屏）
- 私聊等待统一用 `max(windowActiveMs, windowMs)`（现在 = 8000ms），仍受 `maxWaitMs` 硬上限约束
- 群聊逻辑不变（各自成轮）

**测试教训（重要）**：第一版测试用"三条同步 emit" → 通过，但掩盖了真 bug（同步 emit 时 gap=0，第一句不会触发慢聊直答）。
改成**模拟真实打字节奏**（第一句前隔一段、后面 1~2 秒补一句）后，退回修复前的代码**能复现失败**（2 轮），修复后通过 —— 这才算真验证。

### 回复变慢的三项处理（2026-11-12 深夜，主人批「除了内存都做」）

**① 私聊合批等待 8s → 3s（独立配置）**
`pacing.merge.privateWindowMs`（默认 **3000ms**，面板「消息设置」可调）。
私聊不再跟群共用 8 秒窗口；群里仍按 `windowMs/windowActiveMs`。
实测证据（改前）：`[合批] private:10002 3 条 → 1 轮（等 8001ms）`。

**② 每轮首句耗时日志（可观测）**
`onAfterSend` 首次出站打一行 info：
```
[耗时] private:10002 首句 21.3s（模型段 17.9s，其余为合批/排队）| 工具：read_memory(1.2s)
```
- 端到端 = 首句时间 − `turnCtx._inboundAt`（入站时刻，含合批等待）
- 模型段 = 首句时间 − `turnCtx.startedAt`（不含等待）
- 工具轨迹 = 本轮调用过的工具与各自耗时（`_toolTrace`）
→ 用来判定"慢在等待 / 慢在模型 / 慢在她先查记忆工具"，不用再猜。

**③ 闲置沉淀空会话不再反复扫**
`round()` 跳过"没有互动"的会话时写 `state.groups[key].emptyAt`；
`idleCandidates` 对 1 小时内跑过且没东西可收的会话不再选中（原来是每 10 分钟重扫一遍，
线上 275659772 一晚上被扫了 4 次以上，纯浪费）。

测试：`local-daily-idle` 补 1 条（空会话 1 小时内不重扫）；全量 **384/384**。

### 刷屏事故：压缩触发点配错 + 两道保险丝（2026-11-12 深夜）

**症状**：私聊里她连续 13 分钟每 30~60 秒发一条（21:47→21:56 共 9 条，全程零入站），
同一个 turn(188) 一直不结束，`pressureTokens 84,549` 紧贴旧阈值 `100,000`。

**根因**：`cordis.patch.yml` 的 compaction 配的是 `thresholdRatio: 0.1` —— 对 **1M 上下文**的模型
（deepseek-v4.1-flash，contextWindow 1,000,000）意味着 **10 万 token 就压缩一次**。
她的会话本来就 84k，于是压缩在**轮中途**反复触发；每次压缩都是一整轮"总结整段对话"的额外模型调用
（几十秒），而且**压缩后模型会丢失"我刚回过"的记忆 → 再回一条 → 再压缩**，形成死循环。

**修法（三处）**：
1. `thresholdRatio: 0.1 → 0.6`，`retainTokens: 20000 → 80000`
   触发点 `min(1M×0.6, 1M−384k(maxTokens)−64k(headroom)) = 550,464`（原来 100,000，频率降 5.5 倍）
2. **每轮发送上限** `outbound.maxMessagesPerTurn`（默认 6）：超了就地拦住并提示结束本轮
3. **会话滑动窗口上限** `outbound.maxPerWindow`（默认 15 条/5 分钟）：跨轮兜底，挡"很多短轮各发几条"

`[耗时]` 日志同时是可观测手段：`首句 Xs（模型段 Ys）| 工具：…`。
事后核账：`~/.dsh/storages/session_projcache/sessions/<session>.json` 的
`contextPressure.pressureTokens / contextWindow` 就是实时压力，可直接看有没有贴阈值。

**想进一步减少压缩**：把 provider 的 `maxTokens` 从 384000 降到 96000（聊天远用不到），
预算变成 ~838k，再把 `thresholdRatio` 调到 0.8 → 触发点 800k。
