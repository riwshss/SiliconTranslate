# CLAUDE.md

絲譯 Silk Translate：Chrome MV3 網頁翻譯擴展（`src/`）+ Cloudflare Worker 後端（`server/`）。

## 開始任何功能開發前

先讀 `docs/ROADMAP.md`。其中第 3 節「開發原則」是硬約束；按階段順序做任務；完成後更新 checkbox 並追加決策記錄。

修改任何界面（面板、懸浮條、劃詞卡片、雙語譯文樣式、圖標）前，先讀 `docs/DESIGN.md`，顏色、字體、動效只用其中的 token。

## 常用命令

```bash
npm ci                 # 安裝依賴
npm run build          # 構建擴展到 dist/
npm run typecheck      # tsc --noEmit
npm test               # Vitest 單元測試（含後端 tests/server.test.ts）
npm run e2e            # Playwright 真瀏覽器 E2E（mock 後端）
cd server && npx wrangler dev      # 本地跑後端
cd server && npx wrangler deploy   # 部署後端（Phase 0.9 之後改由 CI 完成）
```

## 代碼約定

- 擴展無運行時依賴、無前端框架；不要引入新的運行時依賴。
- 和瀏覽器無關的純邏輯放 `src/core/`，必須有單元測試。
- 界面文案在 `src/shared/i18n.ts`，所有界面語言同時補齊。
- 後端 `server/src/app.ts` 保持不依賴 Cloudflare 類型，以便在 Node 裡測試；Cloudflare 綁定只在 `server/src/index.ts` 接入。
- 改完至少跑 `npm run typecheck && npm test`。
