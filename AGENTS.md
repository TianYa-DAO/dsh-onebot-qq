# 仓库约定（给在本仓库里工作的 AI agent）

1. 本仓库是 `YUsaltyfish/dsh-onebot-qq` 的**本地二次开发分支**：
   - `origin` = `git@github.com:TianYa-DAO/dsh-onebot-qq.git`（本人仓库，改动推这里）
   - `upstream` = `https://github.com/YUsaltyfish/dsh-onebot-qq.git`（只 fetch，绝不 push）
2. 分支 `main`；提交信息用 `local: ...` 前缀，便于与上游提交区分。
3. 改动前后都要 commit；推送用 `git push origin main`。
4. 推送/发布前必须跑 `node scripts/check-no-secrets.mjs` 并全部通过。
5. `config.json` 已被 .gitignore 忽略，内含 NapCat wsToken/httpToken：**绝不** `git add -f`，也不要写进注释、文档或测试 fixture。
6. 源码里不要留真实 QQ 号/群号，示例一律用 `10001` 这类占位值（`plugins/group-memory/index.js` 的提示串是已知点）。
7. 同步上游：`git fetch upstream && git merge upstream/main`；冲突以本地功能为准，合并后跑 `node --test test/local-*.test.js` 回归。
8. 运行方式是常驻进程 + 热重载（`dev-deploy.sh` / `inotifywait`），改完确认没把正在跑的服务打挂。
