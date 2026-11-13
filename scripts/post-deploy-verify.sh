#!/usr/bin/env bash
# 部署后自动验证（由 dev-deploy.sh 通过 systemd-run 排定，**不依赖任何 agent 会话**）。
#
# 为什么存在：以前"重启后去确认服务好了"靠 agent 自己记得立提醒；
# 会话一中断（bash 被中断 / 上下文丢失 / 人不在）就没人验证了。
# 现在验证由 systemd 定时跑，结果落盘，谁都能查：
#   ~/.dsh/dsh-onebot-qq/deploy-last-result.json   机器可读
#   ~/dsh-workspace/部署验证日志.md                人可读（追加）
#   ~/dsh-workspace/⚠️部署验证失败.txt             失败时才出现（显眼）
set -uo pipefail

# OV_DST 只给测试用（构造"源码与线上不一致"的失败场景），生产不要传
DST=${OV_DST:-/home/ubuntu/.dsh/profiles/web/node_modules/dsh-onebot-qq}
OUT_JSON=/home/ubuntu/.dsh/dsh-onebot-qq/deploy-last-result.json
OUT_LOG=/home/ubuntu/dsh-workspace/部署验证日志.md
FAIL_MARK=/home/ubuntu/dsh-workspace/⚠️部署验证失败.txt
PENDING=/home/ubuntu/.dsh/dsh-onebot-qq/deploy-pending.json
WAIT_MAX=150          # 最多等多久让 dsh-web 起来（秒）

started_at=$(date '+%F %T')
fails=()
notes=()

# ── 1. 等 dsh-web 变成 active ───────────────────────────────
ready=0
for _ in $(seq 1 "$WAIT_MAX"); do
  if systemctl is-active --quiet dsh-web; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || fails+=("dsh-web 在 ${WAIT_MAX}s 内没有变成 active")

# 取本次启动时间，后面所有检查都以它为界
active_since=$(systemctl show dsh-web -p ActiveEnterTimestamp --value 2>/dev/null)

# ── 2. 内核就绪行（插件/工具/命令数量）─────────────────────
# 时间窗 = 「dsh-web 本次启动时刻」，语义最准（就是"这次启动之后"）。
# 不能用"脚本启动时刻"（验证可能在就绪后才跑 → 漏掉内核就绪行）；
# 也不能用固定 "-6min"（手动/延迟跑时会差几十秒就漏 → 假失败）。
if [ -n "${active_since:-}" ] && since_bound=$(date -d "$active_since" '+%F %T' 2>/dev/null); then
  SINCE="$since_bound"
else
  SINCE="-15min"
fi
# ⚠️ systemd 的 active 比"插件加载完"早 ~15 秒（实测 22:26:10 active / 22:26:25 内核就绪），
#    所以这里必须轮询等它，不能查一次就判死 —— 否则每次部署都假失败。
kernel_line=''
for _ in $(seq 1 60); do
  kernel_line=$(journalctl -u dsh-web --since "$SINCE" --no-pager 2>/dev/null | grep -E "内核就绪" | tail -1)
  [ -n "$kernel_line" ] && break
  sleep 1
done
if [ -z "$kernel_line" ]; then
  fails+=("等了 60 秒仍没看到「内核就绪」日志（插件可能加载失败）")
else
  notes+=("$kernel_line")
  # 不再硬编码 13：插件会增加（新增 message-monitor 后是 14），只要"已加载 = 总数"就算过
  plug=$(echo "$kernel_line" | grep -oE '插件 [0-9]+/[0-9]+' | head -1)
  if [ -z "$plug" ]; then
    fails+=("没在启动日志里找到插件计数")
  else
    a=${plug#插件 }; a=${a%%/*}; b=${plug##*/}
    if [ "$a" != "$b" ]; then fails+=("插件没全部加载：$plug"); fi
  fi
fi

# ── 3. 启动后的异常（ERROR / Traceback / 未捕获异常）───────
errs=$(journalctl -u dsh-web --since "$SINCE" --no-pager 2>/dev/null \
        | grep -cE "ERROR|Traceback|UnhandledPromiseRejection" || true)
[ "${errs:-0}" -eq 0 ] || fails+=("启动后出现 ${errs} 条 ERROR/Traceback")

# ── 4. 部署副本与源码是否一致（只比 .js，排除本地文件）────
if [ -d "$DST" ] && [ -d /home/ubuntu/dsh-onebot-qq-src ]; then
  d=$(diff -rq --exclude='.git' --exclude='node_modules' --exclude='README_LOCAL.md' \
        --exclude='dev-deploy.sh' --exclude='*.log' \
        /home/ubuntu/dsh-onebot-qq-src/ "$DST"/ 2>/dev/null | grep -cE '^Files .*\.js .*differ' || true)
  [ "${d:-0}" -eq 0 ] || fails+=("有 ${d} 个 .js 文件源码与线上不一致（同步没覆盖到？）")
fi

# ── 5. OneBot 连接（可选：没连上要给提示，但不算致命）────
# WS 连接比内核就绪晚一点点（实测差 1 秒就会误报），所以这里等一会儿再看
ws_ok=0
for _ in $(seq 1 30); do
  if journalctl -u dsh-web --since "$SINCE" --no-pager 2>/dev/null | grep -q "NapCat WS 已连接"; then ws_ok=1; break; fi
  sleep 1
done
if [ "$ws_ok" = 1 ]; then
  notes+=("NapCat WS 已连接")
else
  notes+=("⚠️ 等了 30 秒仍未看到「NapCat WS 已连接」（QQ 可能掉线，需要看 NapCat）")
fi

# ── 6. 落盘 ────────────────────────────────────────────────
ok=$([ ${#fails[@]} -eq 0 ] && echo true || echo false)
mkdir -p "$(dirname "$OUT_JSON")"
python3 - "$OUT_JSON" "$PENDING" "$ok" "$started_at" "$active_since" "${errs:-0}" \
         "$(printf '%s\n' "${fails[@]:-}")" "$(printf '%s\n' "${notes[@]:-}")" <<'PY'
import json, sys, os, datetime
out, pending, ok, started, since, errs, fails, notes = sys.argv[1:9]
def lines(s):
    return [x for x in s.split('\n') if x.strip()]
res = {
    'ok': ok == 'true',
    'verifiedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    'deployStartedAt': started,
    'dshActiveSince': since,
    'pluginErrors': int(errs or 0),
    'failures': lines(fails),
    'notes': lines(notes),
}
try:
    res['pending'] = json.load(open(pending, encoding='utf-8'))
except Exception:
    pass
json.dump(res, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(json.dumps(res, ensure_ascii=False, indent=2))
PY

# 人可读日志：只留最近 30 条，避免无线增长
{
  echo ""
  echo "## $started_at 部署验证 · $([ "$ok" = true ] && echo '✅ 通过' || echo '❌ 失败')"
  echo "- 验证时间：$(date '+%F %T')"
  echo "- dsh-web 启动于：${active_since:-未知}"
  echo "- 启动后异常：${errs:-0} 条"
  for n in "${notes[@]:-}"; do [ -n "$n" ] && echo "- $n"; done
  for f in "${fails[@]:-}"; do [ -n "$f" ] && echo "- ❌ $f"; done
} >> "$OUT_LOG"
tail -c 20000 "$OUT_LOG" > "$OUT_LOG.tmp" 2>/dev/null && mv "$OUT_LOG.tmp" "$OUT_LOG"

if [ "$ok" = true ]; then
  rm -f "$FAIL_MARK"
else
  { echo "部署验证失败于 $started_at"; for f in "${fails[@]:-}"; do [ -n "$f" ] && echo "  - $f"; done
    echo ""; echo "详情：$OUT_JSON"; } > "$FAIL_MARK"
fi

# ── 7. 状态写进任务看板（agent 每次开工都会读它，失败一眼看见）──
BOARD=/home/ubuntu/dsh-workspace/任务看板.md
if [ -f "$BOARD" ]; then
  line="> 上次部署验证：$([ "$ok" = true ] && echo '✅ 通过' || echo '❌ 失败') · $(date '+%F %T') · dsh 启动于 ${active_since:-未知} · 异常 ${errs:-0} 条"
  [ "$ok" = true ] || line="$line · 详见 ⚠️部署验证失败.txt"
  if grep -q "^> 上次部署验证：" "$BOARD"; then
    python3 - "$BOARD" "$line" <<'PY3'
import sys, io
board, line = sys.argv[1], sys.argv[2]
txt = open(board, encoding='utf-8').read().split('\n')
for i, l in enumerate(txt):
    if l.startswith('> 上次部署验证：'):
        txt[i] = line
        break
open(board, 'w', encoding='utf-8').write('\n'.join(txt))
PY3
  else
    python3 - "$BOARD" "$line" <<'PY3'
import sys
board, line = sys.argv[1], sys.argv[2]
txt = open(board, encoding='utf-8').read()
# 插在第一个二级标题之前，保持醒目
i = txt.find('\n## ')
txt = (txt[:i] + '\n' + line + '\n' + txt[i:]) if i > 0 else (txt + '\n' + line + '\n')
open(board, 'w', encoding='utf-8').write(txt)
PY3
  fi
fi

chown ubuntu:ubuntu "$OUT_JSON" "$OUT_LOG" 2>/dev/null || true
[ -f "$FAIL_MARK" ] && chown ubuntu:ubuntu "$FAIL_MARK" 2>/dev/null || true
rm -f "$PENDING" 2>/dev/null || true

[ "$ok" = true ] && exit 0 || exit 1
