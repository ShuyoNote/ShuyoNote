# 自动升级 / OCR 手动验收清单（v1.59.178，真机）

> 这两项**依赖真实环境**（自动升级需签名发布 + 更新托管；OCR 需真实扫描件 + tesseract 语言数据），无头环境无法完整验证。下面逐条在桌面版（`pnpm tauri dev` / 1420）走一遍。

## 0. 自动化门禁（应全绿）
- [ ] `npx tsc --noEmit`
- [ ] `node scripts/smoke-web.mjs`（**296 passed**）
- [ ] `pnpm build`、`cargo check`、`cargo test --lib`（**32**）

## A. 自动升级
1. **入口**：`Ctrl+K` →「关于」→ 看到「**检查更新**」按钮。
2. **离线**：断网点「检查更新」→ 显示「**检查失败（离线）**」，不崩。
3. **已是最新**：能连通 gitcode 且最新也是 1.59.178 →「**v1.59.178 已是最新**」。
4. **有新版**（若 gitcode tag > 当前）→「**发现新版本 vX**」+「下载并安装」（真签名发布后）/ 或「前往发布页」。
5. **桌面更新器接线**（阶段 2）：当前 `plugins.updater.pubkey/endpoints` 是**占位符** → `check()` 会失败回退到阶段 1 拉取，故上面 2/3/4 属阶段 1 行为；**真升级**需按 `docs/development.md §5.1` 配签名密钥 + 发布 `latest.json`。
6. **发布管线**：`TAURI_SIGNING_PRIVATE_KEY=… UPDATE_BASE_URL=… node scripts/release.mjs` → 产出安装包 + `.sig` + `latest.json`（需真签名密钥，无法在本环境白测）。

## B. OCR 兜底
7. 打开一个**无文本层的扫描件** PDF →「阅读并批注」→ 顶部提示「无文本层（矩形/画笔/便签更稳）」。
8. 出现「**OCR 识别本页**」按钮 → 点它 → 若在线且语言数据可加载 → 下方出「**OCR 识别结果**」面板（可选中复制）；若失败（离线/缺语言数据）→ 无结果不崩。
9. **离线场景**：默认 tesseract.js 从 CDN 拉 `chi_sim` 语言数据，离线会失败；如需离线请配置 `langPath` 指向本地 traineddata（`src/lib/ocr.ts` 用 `langs="chi_sim+eng"`）。
10. **文本层 PDF** 不应出现 OCR 按钮（有文本层走精确划词）。
11. **精确划词**：有文本层的 PDF 用「高亮」拖选文字 → 高亮**吸附文字字框**（`snapHighlightToText`），而不是松散大框。

## C. 已知边界（诚实标注）
- **自动升级**：真更新需你的一次**签名发布**（配密钥 + 部署 `latest.json`），本环境未端到端验证。
- **OCR**：tesseract.js 从 CDN 加载语言数据，**离线需本地 `langPath`**；识别结果目前仅「查看/复制」，未接「OCR 文本可选词高亮」。
- 阅读器/批注/回链为浏览器交互，以[PDF 批注验收清单](2026-08-27-pdf-annotation-acceptance.md)为准。

## D. 建议
- 生成签名：`pnpm tauri signer generate -w ~/.tauri/shuyonote.key`（私钥保密），公钥写 `tauri.conf.json → plugins.updater.pubkey`，然后跑一次 `release.mjs` 做一次真实发布，即可在真机验证「检查更新 → 下载并安装」。
