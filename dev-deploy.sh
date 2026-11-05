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

UNIT=dsh-restart-$(date +%H%M%S)
sudo systemd-run --unit="$UNIT" --collect --description="dsh-web restart (dev-deploy)" \
  /home/ubuntu/dsh-workspace/dsh-restart-helper.sh 40 2>&1 | tail -1
echo "已排定 40 秒后重启。重启后新登录链接见 ~/dsh-workspace/dsh-login-url.txt"
