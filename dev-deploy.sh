#!/usr/bin/env bash
# 把本地源码同步到 profile 的 node_modules，并排一次 dsh 重启。
# 用法：./dev-deploy.sh [--no-restart]
set -uo pipefail

SRC=/home/ubuntu/dsh-onebot-qq-src
DST=/home/ubuntu/.dsh/profiles/web/node_modules/dsh-onebot-qq
LOG=/home/ubuntu/dsh-workspace/dev-deploy.log

[ -d "$SRC" ] || { echo "源码目录不存在: $SRC"; exit 1; }
[ -d "$DST" ] || { echo "目标目录不存在: $DST"; exit 1; }

echo "$(date '+%F %T') ---- 开始同步 ----" >>"$LOG"

# 语法自检（挡住手滑写坏的语法，别等重启后插件整条不激活）
cd "$SRC" || exit 1
bad=0
while IFS= read -r f; do
  node --check "$f" >/dev/null 2>&1 || { echo "❌ 语法错误: $f"; node --check "$f" 2>&1 | head -5; bad=1; }
done < <(find . -name '*.js' -not -path './node_modules/*' -not -path './.git/*')
if [ "$bad" = 1 ]; then
  echo "语法检查未通过，已中止（线上代码未动）。"
  exit 1
fi
echo "语法 OK"

command -v rsync >/dev/null 2>&1 || { echo "缺 rsync"; exit 1; }
rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' \
  --exclude 'README_LOCAL.md' --exclude 'dev-deploy.sh' \
  "$SRC"/ "$DST"/ || { echo "同步失败"; exit 1; }
echo "已同步到 $DST"
echo "$(date '+%F %T') 同步完成" >>"$LOG"

if [ "${1:-}" = "--no-restart" ]; then
  echo "跳过重启（--no-restart）。改了 .js 的话要重启才生效。"
  exit 0
fi

# 立刻把补丁守护跑一次，确认补丁仍在（防止同步时把打过补丁的文件冲成上游原样）
/home/ubuntu/napcat-setup/reapply-patches.sh "$DST" >/dev/null 2>&1 || true

# ── 写"待验证"标记：重启后自动验证脚本会读它，把这次部署了什么记进结果 ──
PENDING=/home/ubuntu/.dsh/dsh-onebot-qq/deploy-pending.json
mkdir -p "$(dirname "$PENDING")"
python3 - "$PENDING" "$SRC" <<'PY2'
import json, sys, subprocess, datetime
out, src = sys.argv[1], sys.argv[2]
def sh(c):
    try: return subprocess.check_output(c, cwd=src, shell=True, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception: return ''
json.dump({
    'at': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    'commit': sh('git rev-parse --short HEAD'),
    'dirty': bool(sh('git status --porcelain')),
    'changedFiles': [x for x in sh('git status --porcelain').split('\n') if x.strip()][:30],
}, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY2
[ -f "$PENDING" ] && chown ubuntu:ubuntu "$PENDING" 2>/dev/null || true

UNIT=dsh-restart-$(date +%H%M%S)
sudo systemd-run --unit="$UNIT" --collect --description="dsh-web restart (dev-deploy)" \
  /home/ubuntu/dsh-workspace/dsh-restart-helper.sh 40 2>&1 | tail -1

# ── 自动排定部署验证（关键：不依赖任何 agent 会话/提醒）──
# 重启在 40s 后，验证脚本自己会再等 dsh-web 变 active（最多 150s）。
VERIFY_UNIT=dsh-verify-$(date +%H%M%S)
sudo systemd-run --unit="$VERIFY_UNIT" --collect --description="post-deploy verify" \
  --on-active=55 \
  /home/ubuntu/dsh-onebot-qq-src/scripts/post-deploy-verify.sh >/dev/null 2>&1 \
  && echo "✅ 已自动排定部署验证（${VERIFY_UNIT}，55 秒后运行）" \
  || echo "⚠️ 排定部署验证失败——重启后请手动跑 scripts/post-deploy-verify.sh"

echo "已排定 40 秒后重启。重启后新登录链接见 ~/dsh-workspace/dsh-login-url.txt"
echo "验证结果：~/.dsh/dsh-onebot-qq/deploy-last-result.json ｜ ~/dsh-workspace/部署验证日志.md"
echo "（失败时会出现：~/dsh-workspace/⚠️部署验证失败.txt）"
