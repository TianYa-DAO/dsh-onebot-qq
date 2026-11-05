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
