<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 发布管线（必读，部署相关改动前先看）

- 线上地址：https://ezmusicstore.com/scorefollow/ ，静态托管（cPanel/LiteSpeed，无 node 运行时）。
- 发布方式：本机 commit + `git push origin main`，再让用户（或 ezmusics shell）跑 `~/scorefollow/deploy.sh`
  （= git pull + npm install + next build + cp out/* 到 ~/public_html/scorefollow/）。不要传 zip、不要手拷贝。
- 铁律（违反即线上 404/构建炸）：
  1. `next.config.ts` 的 `output: "export"` + `basePath: "/scorefollow"` 不许动。
  2. 禁止新增 `app/api/*` route handler（静态导出不兼容）。
  3. 所有站内绝对路径必须经 `app/page.tsx` 的 `BASE` 常量前缀（worker/wasm/metro-engine/demo pdf 等），裸 `/xxx` 上线即 404。
  4. push 前本地必须 `npx tsc --noEmit && npm run build` 双绿（node 用 `~/.local/node-v22.17.0-linux-arm64/bin`）。
- 仓库：git@github.com:Birdywen/scorefollow.git（本机 SSH 已配好，直接 push）。
