# ShuyoNote 项目现状摘要（客户端 · 会话延续种子）

> 本文件是**客户端权威现状**——新会话先读本文件，即可精确了解 ShuyoNote 客户端当前进度、已做取舍与下一步候选，无需依赖模糊回忆。**对齐到最新 v1.90.2（2026-09-15）**。
> 项目根：`~/zhai/ShuyoNote`（Mac）/ `C:\Users\cnzen\zhai\ShuyoNote`（Windows）；远端 gitcode + github。
> 服务端现状见 `shuyonote-sync-server/docs/SYNC_SERVER_STATE.md`；**跨平台开发接续（环境事实、待办与下一步、
> 换到 Mac 怎么接）见 `docs/SESSION_CONTINUE.md`（服务端仓库）**——本文件只写"现状"，不写操作步骤。

## 1. 项目概况

- **产品**：ShuyoNote 数友笔记 —— 本地优先 · 类 Notion 的知识管理桌面应用。
- **技术栈**：Tauri 2（桌面）＋ React 18.3.1 ＋ Lexical 0.50（编辑器）＋ SQLite（本地优先）；Web 版用 sql.js（浏览器）。
- **平台**：桌面（Tauri）＋ 浏览器 Web（平台无关 core ＋ 可插拔 driver）。
- **版本**：**v1.90.2**（`package.json` / `src-tauri/tauri.conf.json` 一致；tag `v1.90.2` → `7daea43`）。
  ⚠️ **`main` 与 `dev` 当前是真分叉**（`git merge-base --is-ancestor dev main` 为假），
  两个分支的实际 sha 与处理办法见 `SESSION_CONTINUE.md` §12.2——**动 `dev` 或发版前先读那一节**。
- **许可证**：客户端 **AGPL-3.0**；配套自建同步服务端 **商业**（`shuyonote-sync-server`，见其仓库）。

## 2. 已实现核心功能（里程碑 M1–M27）

| 里程碑 | 主题 | 状态 |
|---|---|---|
| M1–M25 | Markdown/加密/主题/仪表盘/PDF/数据库/多空间/插件/网盘/跨平台/AI/绘图/PDF批注/帮助/公式 | [x]（详见客户端 `docs/roadmap.md`） |
| M26 | 公式（数学） | [x] |
| M27 | 团队版（自建协作） | [部分] 部分（服务端 S1–S8 已落地；客户端 per-workspace `sync_profiles` + 账户 UI（U1–U4）+ E2E 加密已落地；**实时协同后置**） |

### 近期重大变更（v1.82 → v1.90.2）

- **v1.90.2 已发版上线（Android 首个正式发布件）**：GitHub Release `v1.90.2` 挂 **5 个资产**
  （`ShuyoNote_1.90.2_android-arm64-release.apk` + 其 `.sha256`、`_x64-setup.exe`、`_amd64.deb`、`_amd64.AppImage`）；
  gitcode 更新通道 `latest.json` 的平台键 = `windows-x86_64` / `linux-x86_64` / **`android-aarch64`**，
  **桌面两键仍是 minisign 签名**（Android 那条改动没有破坏桌面更新通道）。
  ⇒ Windows / Linux / Android 三端**会**收到更新提示；**macOS 无 `darwin-*` 键**（`release.yml` 未启用 macOS job）。
- **移动端适配（代码层已完成）**：窄屏（≤768px）浮层/弹窗 **19 层**统一适配（小对话框 → 底部弹层、
  大面板 → 全屏 + 内部滚动），并新增 **Android 壳适配层**（窗口 inset 桥 / 软键盘 `--kb` / 返回键回调，
  由 `scripts/android-mobile-shell.mjs` 注入 Kotlin）。**关键平台事实**：Android 上
  `env(safe-area-inset-*)` **恒为 0**（WebView 的安全区取自**物理刘海**，不是系统状态栏），
  且 `targetSdk = 36` 下 Android 15+ **强制 edge-to-edge** ⇒ 必须自己消费 window insets；
  edge-to-edge 下 `adjustResize` 空转（`innerHeight` / `visualViewport.height` 都不变）
  ⇒ **web 层根本察觉不到键盘**。详见 [MOBILE.md](MOBILE.md) §4.2 与 `CHANGELOG.md` 的 `[Unreleased]`。
- **Android 真机复验：已完成两轮，第三轮（本轮两个新 bug 的验收）待插回手机**
  （2026-09-15，Mate 40 / Android 12 / 自检包签名与正式密钥一致，升级不丢数据）：
  - 第一轮：inset 桥（`--sat` = 41）/ 顶部死区 / 返回键三层 / 软键盘 `--kb` / 横屏裁切 → **全部通过**（必须 `adb shell input tap`，CDP 合成触摸会绕过 SystemUI 假成功）。
  - 第二轮：窄屏浮层几何 + 返回栈，用自造**空间包**（`tmp/fixture/make-space.mjs`）在真机上造出**名字与 MIME 都正确**的附件当素材 → 文件预览几何 / 文件预览返回键 / PDF 返回键 **三项从"无法判定"转为通过**。
  - **本轮又抓出两个"整个功能不可用"**（都已修 + CI 绿 + 已出签名 APK，**真机行为验收已做**）：
    ① 手机上**保存到用户选的位置全部失败**（导出空间/导出备份/下载附件/导出 HTML/模板/标注副本；
    真机红字 `Read-only file system`）——根因 `content://` URI 被当路径用，修法见 `save_target.rs`；
    **真机已验：导出空间 15,870 B（含 `shuyonote.db` + 两个附件）、导出备份 220,743 B（含 `meta.db` + 3 个空间库 + 附件）、下载附件 9,582 B 且 sha256 与内容哈希逐字节一致**（修前那个是 0 字节）；
    ② 手机上**打开任何 PDF 都失败**（真机 `Promise.withResolvers is not a function`）——根因设备系统
    WebView 停在 **Chrome 114** 而 pdf.js 4.8 要 119+，修法见 `public/es-polyfills.js` + `pdfjs-worker-shim.mjs`；
    **真机已验：`第 1 / 4 页`、正文渲染成页面图、控制台日志来自真 worker（无 `Setting up fake worker`）**。
    选择器导入**丢附件名与 MIME**也已真机验证：用唯一名素材（`probe-zhenji.png` / `probe-pdf.pdf`）
    导入后列表显示的就是**系统给的原名** + 🖼/📕 图标，点开进内置预览（`naturalWidth=256`）/ 内置 PDF 阅读器。
  - **待办（本轮新发现）**：窄屏下 PDF 阅读器**内部分栏**没适配（目录栏 240 常驻、页面图右溢出屏幕）
    ——"能打开"≠"能看"，改法与 §4.1 同一条纪律，见 [MOBILE.md](MOBILE.md) §4.3.4；
    另一个未做真机验证的小项：手机上装 **zip 插件包**（判据已改对，但本机环境造不出选择器可见的
    插件包：`adb push` 进去的文件没有 MediaStore 条目，见 §4.3.3）。
  - 验收脚本与素材都在 `tmp/`（`fixture/make-space.mjs`、`savecheck.ps1`、`fetch-apk.ps1`、`reverify/`）；
    **`gen/android` 必须重新 `pnpm tauri android init`**（本机那份是陈旧的，`--check` 会红，
    现在它还会与 `scripts/vendor/` 逐字节比对）。
- **第一批一方插件 + 一处能力缺口**（`dev`，未发版）：`weekly-review` / `page-to-md` / `eye-care-theme` / `high-contrast-theme`（都能直接装来用，均进回归测试）；写它们时撞出并修掉 `blocks.list` 省略 pageId 不回退当前页（此前「能写当前页、读不到当前页」）；记下相邻缺口：插件拿不到当前页 id/标题（候选 `api.page.meta()`，等第二个插件也撞到再动）。
- **信任面收口：插件更新后声明扩张必须重新确认**（`dev`，未发版）：启用时记授权快照，新增权限/事件后**后端拒绝执行 + 停止事件派发**，直到用户在插件管理里点「重新确认」；存量插件首次扫描补记一次；只跟踪启用中的插件。作者文档 §4.5.1 记了这条对发版的影响。
- **v1.85.1 热修复：命令面板白屏**（2026-09-10）：1.85.0 起按 `Ctrl+K` 会抛 React 错误（生产为 Minified React error #310）并让**整棵树被卸载成白屏**——`CommandPalette` 把参数表单的三个 `useState` 放在了 `if (!open) return null` 之后（hooks 不能有条件调用），而它挂在 App 根部、上面没有 ErrorBoundary。修复 = hooks 移到早退之前；补上**渲染级**回归测试 `src/components/commandPaletteHooks.test.ts`（修复前必失败）。**教训**：既有验证全都不渲染 React 组件，主路径可以一直炸而全套检查全绿——所以随后补了两层：根部错误边界（`main.tsx` 的整屏兜底 + `PanelBoundary` 逐浮层隔离，`src/components/errorBoundary.test.ts` 钉住"边界外的界面照常可用"），以及开发指南里"组件/hooks 类改动要有渲染级测试"这一条。
- **E2 口令锁 UX + 同一类 hooks 错的第二例**（2026-09-16，`feat/vault-lock-ux`）：给锁定屏补"忘记口令"出路与开启加密的硬确认时，先发现**锁定屏根本到不了用户眼前**——`App` 里的加密闸门是一句**排在七八个 hooks 之前**的早退（与 1.85.1 白屏**同一类**错：hooks 不能有条件地少跑），加密安装**重启即抛 `Rendered fewer hooks than expected`**，被根部 ErrorBoundary 接住 ⇒ 用户看到崩溃屏。E1 当初只验了设置页开关、没验"重启"，所以这道屏一次都没出现过。修法 = 闸门与外壳**拆成两个组件**（`App` 只有一个 hook，锁定态外壳**不挂载**）+ 新增状态中枢 `src/lib/vault.ts`（原来 App 与设置页各持一份副本，导致"设置页点立即锁定界面不切屏"）。判据 `src/vaultGate.test.ts`（渲染**真 App**）+ `src/components/lockScreen.test.ts`，都做过变异验证；并新增 `scripts/check-hook-order.mjs`（`pnpm check:hook-order`，已接进 `pnpm build`）把这类写法钉死。当天已随 `merge: dev 合入 main`（`62bc733`）进 `main`——合并时解掉五处冲突，其中 `scripts/lib/releaseArtifacts.mjs` 是**语义冲突**：main 的"universal 要占两个 darwin 键"与 dev 的"darwin 清单要指向 `.app.tar.gz`"互补，已合成一套（universal 的 `.app.tar.gz` 同时喂两个键；两个架构各自的 dmg + 无名 `.app.tar.gz` 仍照旧报错），两边判据都在。**已随 v1.91.3 发出**（2026-09-16：tag `v1.91.3` → GitHub Actions 出三平台包 + Android 发版件 → 发到 gitcode 更新通道，`latest.json` 已是 1.91.3，`check:release-state` 14 项通过 + GitHub Release 指纹互证通过；APK 证书指纹 `6ee89e6f…` 与正式 keystore 一致）。**真机复验仍未做**（手机不在本机，且这条路径要在真机上跑"开启加密 → 重启 → 解锁"）。注意两条环境事实：这台机器的系统 DNS 把 `api.github.com` 解析到假 IP（要钉 IP）、出方向 22 端口被封 ⇒ **国内主站 `shuyo.cn/app` 本次没上传，仍是 1.91.2**（Pages 入口已随 main 自动到 1.91.3；两个入口当前**不是同一版本**）。教训与 1.85.1 一致且再次成立：**渲染级测试是这类错的唯一有效门禁**。
- **多账号聚合邮箱**（v1.83，**仅桌面版**——移动端不提供，见 [MOBILE.md](MOBILE.md) §2.1）：多账号 IMAP 聚合收件箱 + 存为笔记 + AI 总结 + 发件人标签 + 按月直达 + 设置多账号管理/测试连接。
- **附件哈希前缀分桶存储**（v1.84.2）：附件从单目录平铺改为 `attachments/<hash前2>/<hash>.<ext>`，旧数据双读兼容，服务端空间桶内再按哈希前 2 字符分片。
- **同步一致性加固（seq-LWW + dirty 优先本地）**（v1.84.3）：根治团队多人同改时钟漂移丢改动。
- **v1.84.3 发布收尾 + 安全审计**（2026-09-09）：三平台安装包（Win/Linux）已发布 gitcode + GitHub + 官网/Pages（应用内「检查更新」通道 `latest/latest.json` 已通）；安全审计修 3 项上线前高危（插件持锁无超时、E2EE 同步不丢数据、import/purge id 校验），详见 `docs/SECURITY.md`。
- **近实时协作**（开发中，`feat/near-realtime`）：同页冲突提示（P0.1）+ presence 在线/谁在编辑（P0.2）+ 评论/@/通知（P1）+ SSE 推送（P1.5）——服务端 `collab.rs`/`migrate_v10` + 客户端命令/UI，集成回归 `test:sync-collab` 15 断言全绿。

## 3. 关键架构

- **平台 driver**：`src/lib/platform/`（types/tauri/web/index）；`api.ts` 经 `platform.executor.invoke` 调命令，命令契约见 `src/lib/platform/commands.ts`（`CommandMap`）。
- **同步**：outbox `changes` + LWW（服务端 seq 基准 + dirty 优先本地，v1.84.3）；附件内容寻址去重。
- **存储**：每工作空间独立库（`meta.db` + `spaces/<ws_id>/`）；附件内容寻址 hash + 分桶 + 可加密。
- **PDF**：桌面 native MuPDF + Web pdf.js 双引擎；`platform.pdfRender` driver。
- **编辑器**：Lexical 0.50 + 自定义节点；节点类型收敛于 `src/editor/config.ts`。
- **提版**：`scripts/release.mjs`（gitcode 更新）+ `tauri-plugin-updater`（签名 + `latest.json`）。

## 4. 边界 / 红线（重要取舍，勿轻易推翻）

- **Web 同步**：Web 版**不做多设备同步/团队版**（同步引擎在 Rust、浏览器模型与协议不匹配、凭证不安全）；Web 跨设备只走备份/导出 zip。详见 `docs/web-sync-boundary.md`。
- **i18n 暂不做（决策，非欠账）**：目标客户是国内 B 端私有部署，无英文用户信号；i18n 会给每次 UI 改动加税。触发信号（英文 issue/海外询单/上架海外）出现才启动。
- **AGPL**：不把"托管云同步 SaaS"作为服务端收费点；收费点 = AI / 私有部署交付 / 内容模板。
- **版本号约定**：验证性/修复轮不改版本号；只有 bump + 发布才重打安装包。
- **协同后置（P2）**：实时协同明确不做（详见 `docs/realtime-collab-analysis.md`）。

## 5. 验证循环

- `npx tsc --noEmit`、`pnpm build`（含 `check-versions` + `check-web-commands` + `tsc` + `vite`）、`node scripts/smoke-web.mjs`（**350 断言**）、`vitest`（**88**）、`cargo test`（**55**）。
- Rust 侧另有 CI 在跑（`.github/workflows/ci.yml` 的 `rust-tests`）：`cargo test`（含宿主子进程集成测试）
  + **`cargo test --lib plugins::`** ——后者是 2026-09-13 加的门禁，挡"只有全量跑才绿"的测试
  （那种测试单跑必红，最费时间）。
- Android：改 `.github/workflows/android.yml` **或** `src-tauri/src/**` / `Cargo.toml` / `Cargo.lock` /
  `src/**` / `scripts/**` / `tauri.conf.json` 等构建输入**都会触发**它（2026-09-13 之前 paths 只含
  workflow 文件本身，于是"改了 Rust 源码、推上去后 Actions 里连一条运行记录都没有"——判据是
  "推完去 Actions 看有没有新记录"，不是"我记得它配了"）。
  产物**已经由 CI 用正式密钥签名**（Secrets → zipalign → apksigner → 实测指纹与 `6E:E8:…:7A:88`
  硬比对，不一致即红）：
  - `android-apk-aarch64-signed-test-hooks` —— **可直接 `adb install`**，但带着测试钩子，**只能自检**；
  - `android-apk-aarch64-unsigned` —— 保留用于量体积。
  对外发版件（不带测试钩子）**已接入** `release.yml` 的 Android job，并用一个**临时 tag**
（`v1.90.1-rc1`）真跑过一次：四个 job 全绿，CI 与本地 `apksigner` **各读一遍指纹都对**（`6ee89e6f…`）、
包内 ABI 恰为 `arm64-v8a`、真机 `install -r` 成功且**数据未丢**（firstInstallTime 不变）、
反向判据「测试钩子未启用（这是正式构建）」成立 ⇒ 发版包**确实不带测试钩子**。
验证完 tag 与 Release **已删除**（Release/ref-by-tag 均 404，run 记录保留）。详见 `CHANGELOG.md`。
- `pnpm run dev:desktop`（桌面开发，自建干净 PATH，见 `scripts/tauri-dev.mjs`）。
- 发布：`git tag vX && git push origin vX && git push github vX && git push origin main && git push github main`
  → `node scripts/release.mjs`。（tag 与 main 都推**两个远端**：`github` 才触发 Actions 的三平台构建 /
  发版件，`origin`=gitcode 是镜像与应用内「检查更新」通道；口径见 [RELEASING.md](RELEASING.md) ④）

## 6. 下一步候选（按需选一项继续）

1. **M27 团队版剩余**：实时协同（后置）；本地多用户档案。
2. **PDF 批注阶段 2**：写回源 PDF / OCR 精确划词（延后；导出带批注副本已实现）。
3. **Android 移动端（M6）——当前最活跃的一条线**。路线＝**Tauri 原生壳**（不是 WebView 壳；后者只留给 Tauri 不可达的平台，如鸿蒙 ArkWeb）。
   - **CI 能在 Linux runner 上出包**（`.github/workflows/android.yml`）：路上翻出并修掉**两个只在 Linux 上暴露**的坑
     （NDK 没有 `aarch64-linux-android-ranlib`、`mupdf-sys` 的 bindgen 不带 `--target`）——修法与理由都写在 workflow 的步骤注释里；
   - **体积 156.7 → 53.41 MiB**（`strip` + tesseract-core 白名单 + OCR 语言包改按需下载），当初定的 55–70 MiB 目标已达成；
   - **真机首次跑通**（2026-09-13 · HUAWEI Mate 40 `OCE-AN10` / Android 12）：装上、冷启动、界面正常渲染（截图存证）；
   - **Boa 在 Android 上的 nan-boxing panic 已修并真机复验**（移动端开 `jsvalue-enum`）——见 [MOBILE.md](MOBILE.md) §2.1。
   - **2026-09-13 这一轮做完的**（细节见 [MOBILE.md](MOBILE.md) 与 `CHANGELOG.md`）：
     - **正式 keystore 已生成**（RSA-4096 / 10000 天，`~/.shuyonote-release-keystore/` +
       一份异地备份；**测试专用 key 与它分开**，那个只用于真机自检包，别混用）；
     - **深链在 Android 上修好了并真机验证**：原先 `attach()` 被 `#[cfg(desktop)]` 挡掉，
       插件 emit 了 `deep-link://new-url` 却**没有订阅者**，表现是"点深链完全没反应"。
       现在 warm（`onNewIntent`）与冷启动（`get_current` 补收）两条路径都在真机上收到 URL，
       前端也真的执行了动作（见 §2.3）；
     - **Rust 侧 HTTPS 的 panic 已修并真机验证通过**：启动时初始化系统证书校验器
       （两套 jni 的裸指针桥，见 §2.4.1 / §2.5），真机上 `[tls]` 初始化成功、panic 0 条，
       **真实 HTTPS 请求取回 107 字节内容**。（**更正**：当天把"打 `shuyo.cn` 失败"判成**服务端证书链**
        有问题、要上 `--preferred-chain "ISRG Root X1"`——**该结论同日已证伪作废**：那条链自带
        `ISRG Root X2 ← ISRG Root X1` 交叉签名，用**只装 X1 的信任库**实测 PKIX 握手 `OK`
        （对照组：同一个库连百度 FAIL）⇒ **服务端未动、也不需要动**；设备侧那次失败的真实报错
        待连着手机复测。详见 [MOBILE.md](MOBILE.md) §2.4.1。）
     - **真机自动化有了五条测试钩子**（`run-plugin` / `new-page` / `http-probe` / `list-pages` / `pick-file`），
       只在 `VITE_TEST_HOOKS=1` 的构建里存在，正式发版不带。两条判据**都已验掉**：
       「跑一条插件命令」端到端 ✓（toast 报出插件返回值、页面上出现新建的页）；
       **Phase 0 持久化** ✓（`list-pages`：41 页 → 建页 42 页 → `force-stop` 重启**仍 42 页**）。
       注意持久化**不能靠截图判**：重启后应用总停在空白新页上。
     - **「选文件」拿不到可读路径已实施**（`tauri-plugin-fs` 的 `open()`：Android 经
       `ContentResolver` 取 fd，见 §2.2）——**CI 已编译通过，真机待点一次**。
       ⚠️ 真机点这一遍时撞上了**临时目录**的坑：Android 上**没有 `/tmp`**，于是选文件、备份
       /恢复、插件包解压、空间包导入导出**全线**受影响。已统一收口到
       `src-tauri/src/tempdir.rs`（临时根 = 应用缓存目录，启动时定向），见 [MOBILE.md](MOBILE.md) §2.2.1。
   - **仍未做 / 未验**：② 的**真机点一次**、逐条真机验收清单
     （附件 / PDF / 本地 OCR（语言包首次需联网一次）/ 加密锁定 / 深链 / 同步 / 备份 / 小屏横屏；**其中「深链」这一项已真机验证**，见上）。
     真机验收能用哪些手段、有哪些边界，见 [MOBILE.md](MOBILE.md) §2.3（别重复踩盲点坐标那个坑）。
      上线计划见私有仓库 `shuyonote-sync-server` 的 `docs/android-launch-plan.md`（公开仓已不留副本）。
    - **壳适配层的真机复验也没做完**（2026-09-15，手机中途从 USB 掉了）：四项判据（inset 是否真送进网页 /
      顶部 41 CSS px 死区是否恢复 / 返回键三层 / 键盘 `--kb`）、新包 artifact、以及"新旧包
      `versionName`/`versionCode` 相同、必须靠 `--kb` 与 `window.__SHUYONOTE_BACK__` 区分"这些
      都在同仓库的 `docs/SESSION_CONTINUE.md` **§12.5**；先读它再连设备。
4. **插件体系：M11.13 方案已拍板、**阶段 1+2 已落地——应用已真正跑在子进程上**（协议 + 帧 + `HostClient`；能力调用走 IPC 回父进程服务；命令与事件两条路都已切流；进程内执行路径已删除、14 处测试迁到生产路；实测进程启动 ~5 ms、每次能力 IPC ~0.1 ms；阶段 3 = 超时即杀 + OS 上限 + 打包验收；6 个决定见方案 §8.1）**——[插件宿主子进程化 + OS 级资源限制方案](plans/2026-09-10-plugin-host-isolation-plan.md)：把 Boa 挪进独立子进程（纯解释器：不碰 DB/密钥/路径，能力全部 RPC 回父进程；**应用现已跑在这条边界上**），取消与超时改为真杀进程，OS 级内存/CPU 上限三平台落地，4 阶段约 9–10 天；它是 M11.11a 分发的硬前置。**M11.9 已全部收口**（视图落点 `overlay`/`rail`）；一方插件 11 个（8 个能直接用）+ [可发布清单](plugin-recipes.md) 已备好。
5. **插件体系进化 M11.8 触发面与事件**：M11.5/M11.6/M11.7 均已落地（时限与资源上限、ABI v1 + 能力注册表 + 权限与写中介、20 条能力 + 与 AI 工具层合并，**以及 M11.6 收口的作者工具链**——应用内校验/热重载/`pnpm plugin:validate`/示例插件/类型包 globals）；**M11.8 已落地四档**（命令参数 → 宿主渲染表单、结构化返回、事件钩子 v1 + **7 个发射点全部接上**（`app.started`/`page.opened`/`page.deleted`/`space.switched`/`page.saved`/`import.finished`/`sync.completed`，后两个是后台事件、在单一咽喉点播报）、**触发面 v1：编辑器 `/` 菜单**）；**M11.8 已全部落地**（命令参数、结构化返回、事件钩子 + **7 个发射点全齐**、编辑器 `/` 菜单、**页面列表行菜单 `page.context`**、**文件列表右键菜单 `file.context`**、**编辑器工具栏 `editor.toolbar`**、插件设置）；**M11.9 已落地三档**（零代码插件 `runtime: declarative` + 宿主渲染的声明式视图 + 零 JS 示例 reading-board；主题插件 `theme.tokens` + 主题检查进校验器 + 示例 warm-night；**导入触发 `manifest.triggers`**——命令面板入口 → 选文件 → **宿主** `readTextFile` 读内容 → `{ fileName, content }` 当 `argsJson` 交给 `run_plugin_command`，**没有新能力也没有新命令**，权限与写中介原样成立，顺带把 `MAX_ARGS_BYTES` 16 KiB → 1 MiB 并把注释语义改成「行为的界」，示例 md-outline）；**M11.9 第四档也已落地**（声明式视图参数化：查询字段可用 `{fromSetting}` 引用用户设置——零代码也能「用户可配」；顺带修掉三个静默失效的坑：视图 camelCase 字段被丢弃、声明式缺「加载器会不会拒」兜底、`select` 候选项短写法被拒载）；**M11.9 第五档也已落地**（导出：新能力 `api.files.export` + 权限 `export:files` + 触发 `kind: "export"`——**不直接写盘**，命令跑完后逐个弹系统保存对话框、用户点保存才写；插件给不出路径；事件里无效；示例 index-export）；**M11.9 已完成**（第六档：视图落点 `views[].placement`——`overlay` 浮层 / `rail` 右侧常驻面板，两种形态共用同一张表、互斥与"点行不关面板"都有渲染级测试；示例 reading-board 两种落点各示范一个）；之后是 M11.10 沙盒 UI（闸门=M11.9 声明式穷尽）；**那处信任缺口已闭合**（授权快照：声明扩张由后端拒绝执行 `approval_required`，直到用户重新确认，见路线图）。见[插件体系进化方案](plans/2026-09-10-plugin-evolution-plan.md)（**定位=做第一不做更大**：做**第一个「有权限模型 + 作用在 E2EE 可自托管数据上」的可信插件体系**，不比能力条数）。
6. **数友社区上线当天（不等 M11.13）**：开「模板 / 主题 / 插件配方」分类 + 发布 `plugin-index.json` 规范 + 招募 3 位共创作者；**不做**应用内市场 UI——见[插件分发策略](plans/2026-09-10-plugin-distribution-strategy.md)（协议而非平台 + 贡献阶梯，前三级为惰性数据可立即开放）。
   - **卡片阅读量已上线（v0.70.7，2026-09-15）**：首页与标签页的帖子卡片 meta 行，在点赞旁补了 `eye` 图标 + `p.views`（此前只有详情页与精选页有浏览数）。线上验收不是"页面上有数字就算"：① 结构判定——首页 16 张卡、标签页 1 张卡，**每张**卡片的 meta 行里点赞与浏览图标同时存在（`tmp/fixture/verify-community-views.mjs`）；② 活数据判定——先读某卡浏览量，**打开该帖详情**（服务端在此 +1）再回读同一张卡，`34 → 35`（`tmp/fixture/verify-community-views-live.mjs`）。两条都过才算数。
7. **插件分发（M11.11）已随 v1.88.0 / v1.89.0 发出**：**a** = `plugin-index.json` 索引 + 索引签名（minisign）+ zip/URL 安装（先校验后落盘：https 白名单 / 体积上限 / `sha256` / 临时目录解包 / manifest 校验）+ 前端「从索引安装（给 URL）」；**升级 / 重装 / 拒绝降级**（先备份后动手，失败回滚，不动用户的启用状态与授权快照）；**b 的技术核心** = 离线撤回列表（索引说过的"这个版本不该再用"落库，运行与安装两条路都拦，离线也拦得住，用户可显式「仍然使用」）+ 发布者公钥固定（TOFU：首次装成功后固定，换 key 一律拒绝并摆出新旧指纹，确认后可「信任新密钥并安装」）。v1.89.0 又补上：**多源订阅**（一组索引可增删、一次检查全部、逐条记结果）、**按发布者密钥撤回**（`revokedKeys`：用它签的条目不可安装、已装插件运行被拦、安装前也查；离线生效，用户可显式「仍然使用」）、**事实清单**（来源/体积/声明/静态扫描 + **内容指纹**：装完之后那份文件有没有被改过——只摆事实、不评分）、以及[插件开发者政策](plugin-policy.md)与 SECURITY 的插件一节。**仍未做**：市场 UI 的搜索/浏览（c）、评分卡（有意做成事实清单，不做评分）、Windows 的 RSS 与内核硬上限；闸门不变（作者文档 + ≥3 真实第三方插件）。M11.10 UI 插件 / M23.5 协同 / 移动端（M6）：已评估延后（M11.10 闸门=声明式贡献面穷尽）。

8. **跨机器多端同步测试（Windows ⇄ Mac，服务器放 Mac）—— ✅ 2026-09-15 已实测通过**：
   会合协议 `scripts/sync-multidevice.mjs`（两端各跑一次、不需要约定先后：写标记 → 等对方 →
   **互改对方的页**再等回改 ⇒ 证明"就地更新也双向到达"，不只是"新页能看见"）。
   **实测结果**：Mac `{"role":"mac",…,"pass":6,"fail":0}`、Windows `{"role":"windows",…,"pass":6,"fail":0}`，
   两端 `peerSeen`/`bidirectional` 均 `true`（账号制：各自注册、Windows 建空间并把 Mac 加为 editor，
   无任何密钥跨机器传递）。顺带确认两台机器**在同一网段**（直连与隧道**两条都通**）。
   手册 [sync-multidevice-test.md](sync-multidevice-test.md) 的 §0.5 记了完整结论与仍缺的一格
   （**真客户端 GUI 那一步**没人点，Mac 侧无 GUI 自动化）。
   凭据来源＝服务端 K1 设备密钥（schema v14，可签发/作废、只存指纹）+ 客户端 K2（粘贴密钥即可，
   无需注册）；跨网段时用 SSH 反向隧道（公网服务器回环 + 8799）。交接与回报区在服务端仓
   `docs/SESSION_CONTINUE.md` §13；往来信道是**信箱仓 `ShuyoNote-collab`**（不是这份文档）。

> 注：功能明细 / 里程碑总览以客户端 `docs/roadmap.md` + `docs/README.md`（文档索引）为准；本文件只作"新会话现状种子"，重开会话先读它再读 roadmap/architecture。
