# 不变式清单（本仓当前契约）

> **收录条件（三条，缺一不可）**：① 能指到**一条会红的判据**；② 那条判据有**「看过它红」的证据**
> （`_workspace/mutation-evidence.json` 里按脚本 sha 绑定；**判据代码一改，证据自动过期**）；
> ③ **证据能原地重做** —— 判据那边得有一个「再注入」的口子（`--root` ／ 位置参数 ／ `--self-test` ／
> 或已写明的**假根配方**）。⚠️ 缺第③条，判据一改（sha 变）第②条就**永远补不回来**，那条不变式只能被动撤下 ——
> 例（**2026-09-28 更正**）：`check-pdfjs-worker-shim` 先前被我判成"③暂时不满足"——**那条判断是错的**：账本里它的配方（假根：真 `public/` ＋ 真 `scripts/` ＋ 整份 `node_modules/pdfjs-dist`，只改垫片那两行的顺序）是**可复现**的 ⇒ ③ **满足** ⇒ 它**已在表内**。教训："可注入性"要看**账本里那条证据是怎么做出来的**，别拿"有没有 `--root` 开关"当判据。
> ⇒ **过期即从本表撤下**（先重做证据，再放回）。本表不是"愿望清单"。
>
> 「口径」一列**逐字引自** `scripts/lib/gates.mjs` 的 `label`（本仓门禁注册表＝单一事实来源）；
> 「挡的是哪次事故」见同处 `incident` 字段。**本表不重写口径、不复述实现**。
>
> 收录范围与「为什么不收其余 34 条」见 [README.md](README.md) §现状。

| id | 口径（引自注册表 `label`） | 判据 | 会红证据 |
|---|---|---|---|

> ⭐ **2026-09-29 补注（windows 裁定，AMD 落地）**：收录条件**没有**"载体必须是 `scripts/check-*.mjs`"这一条 ✗ ——
> **载体可以是测试**。先例：`INV-RELEASE-sm-pipeline` 走"兄弟测试"通道 ✓；本表 2026-09-29 起另有三条
> `INV-WIKI-*` 走同一形态。⇒ 对这类条目：
> **「口径」列引测试里那句断言的逐字原话**（它没有注册表 `label`）、**「判据」列写测试文件名 ＋ 跑它的命令**、
> **「会红证据」列写 D3 测试形态那本账**（本仓目前用**仓内可复跑**的变异脚本充当"能原地重做"的口子 ✓）。
> ⚠️ 别再照着"门禁"两个字把测试形态的条目摘出去 ✗。

| **INV-CHANGELOG-structure** | CHANGELOG 结构 | `scripts/check-changelog.mjs`（可传目标文件注入） | ✅ 账本 `exit=1`（sha `d850ec3a8688`）｜2026-09-28 夹具实测：合法 exit 0 ／ 让 `###` 出现在任何 `##` 之前 ⇒ **exit 1** |
| **INV-CHANGELOG-gate-numbers** | CHANGELOG 门禁数字（与基线一致） | `scripts/check-changelog-gate-numbers.mjs`（`--root`） | ✅ 账本 `exit=1`（sha `48cff11c1047`）｜夹具实测：台账写 999 / 基线 1000 ⇒ **exit 1**（逐字判语「vitest：写的是 999，基线是 1000」） |
| **INV-RELEASE-tag-tree** | 每个 tag 的树自带本版台账段头 | `scripts/check-changelog-tags.mjs` | ✅ 账本 `exit=1`（sha `0867f9f96165`） |
| **INV-RELEASE-version-parity** | CHANGELOG 已发布标题与版本文件同改 | `scripts/check-changelog-version-parity.mjs`（`--repo` / `--commit` / `--range`） | ✅ 账本 `exit=1`（sha `3ec4f858809c`） |
| **INV-RUST-deadcode-receipts** | 死代码收据（`allow(dead_code)` 必须带日期 ＋ 删除条件） | `scripts/check-dead-code-receipts.mjs`（`--root`） | ✅ 账本 `exit=1`（sha `0189cd725058`）｜夹具实测：**只删掉那行收据注释** ⇒ **exit 1**；空扫 ⇒ 拒绝给绿 |
| **INV-STORE-derived-writers** | 派生表唯一写入者（Rust 生产代码不许写 attachment_text / chunks） | `scripts/check-derived-writers.mjs`（`--root`） | ✅ 账本 `exit=1`（sha `c712fd808842`）｜夹具实测：生产代码里加一句 `INSERT INTO attachment_text` ⇒ **exit 1** |
| **INV-STORE-doc-content-layer** | 文档内容直接访问（只减不增：新文件 / 超基线即红） | `scripts/check-doc-content-access.mjs`（`--root`） | ✅ 账本 `exit=1`（sha `a90819ac28ec`）｜夹具实测：同文件 1 → 2 处 ⇒ **exit 1**（逐字判语「直接访问变多：src/lib/a.ts 1 → 2」） |
| **INV-UI-hook-order** | hooks 顺序（早退不许越过 hooks） | `scripts/check-hook-order.mjs --self-test` | ✅ 账本 `exit=1`（sha `2205ea7a24ba`）＋ 脚本自测里放的是**两次真事故的真实写法**（必须判红） |
| **INV-BRANCH-release-line** | 发布线独占提交（漏在 main 上的开发改动） | `scripts/check-main-only-commits.mjs` | ✅ 账本 `exit=1`（sha `18ff6c24af18`） |
| **INV-PLAN-status-evidence** | 方案状态位与完成的证据（每篇 plan 头部要有 `状态：`；报完成必须带可核证据；只减不增） | `scripts/check-plan-status.mjs --self-test`（`--root`） | ✅ 账本 `exit=1`（sha `8e8cec4edebd`） |
| **INV-UI-store-subscriptions** | Zustand 订阅粒度（组件不许整店订阅；只减不增） | `scripts/check-store-subscriptions.mjs --self-test`（`--root`） | ✅ 账本 `exit=1`（sha `2cc253f5a955`） |
| **INV-TOOLING-ps1-encoding** | PowerShell 脚本编码（纯 ASCII 或 BOM） | `scripts/check-ps1-ascii.mjs`（`--root`，2026-09-28 加） | ✅ 账本 `exit=1`（sha `c7bffc955a4b`）｜夹具实测：纯 ASCII exit 0 ／ **同一份文件加一行中文注释（仍无 BOM）⇒ exit 1**（逐字「24 个非 ASCII 字节，行 2」）／ 空扫 ⇒ 拒绝给绿 |
| **INV-RELEASE-sm-pipeline** | workflow YAML 窄规则 ＋ 私有 CARGO_HOME 交接（按 job） | `scripts/check-workflow-yaml.mjs`（窄规则可传目录；**国密四件套那条不在目录参数模式里**） | ✅ 有，但**走另一条通道**：兄弟测试 `scripts/check-workflow-yaml.test.mjs`（**16/16 通过**，含正例 `gmPipelineRequirements(GOOD)` 为空 ＋ **逐条必备文本各一个「删掉 ⇒ 必须红」**）—— 即工作区账本里的 **D3 测试形态判据**那一本。⚠️ 2026-09-28 实测：**用夹具删掉 `--features sm-library` 那一行，门禁仍 exit 0** ⇒ 这条规则的承重**不能**靠目录参数夹具，**只能**靠那个测试文件 |
| **INV-RELEASE-version-consistency** | 版本号一致（`package.json` ／ `src-tauri/Cargo.toml` ／ `tauri.conf.json` ／ README 徽章 ／ `docs/README.md` ／ `CHANGELOG.md` 六处） | `scripts/check-versions.mjs`（`--root`，2026-09-28 加） | ✅ 账本 `exit=1`（sha 见账本）｜夹具实测（内容是**真仓六处文件的拷贝**，只改一处）：原样 exit 0（`版本号一致：1.91.26`）／ **只把 `package.json` 改成 `9.9.9` ⇒ exit 1**（逐字「`src-tauri/Cargo.toml: 1.91.26 != 9.9.9`」） |
| **INV-IPC-web-commands** | 命令覆盖三个方向一致（Rust 有 → `web.ts` 必须实现 ／ Rust 有 → `CommandMap` 必须声明 ／ `CommandMap` 有 → 桌面 Rust 必须注册或登记为 web 专属），且参数键为 camelCase | `scripts/check-web-commands.mjs`（`--root`，2026-09-28 加） | ✅ 账本 `exit=1`（sha 见账本）｜假根实测（**不拷真仓大文件**）：空假根 exit 0 ／ **只建一处**（`lib.rs` 的 `generate_handler!` 注册 `plug::approve_plugin`，另两处都没有）⇒ **exit 1**（逐字「Web 平台缺失 1 个桌面命令（前端调用会抛「未实现命令」）：- approve_plugin」）。⚠️ **边界**：**空假根也 exit 0**（"Rust 0 个命令…覆盖完整"）—— 按五档契约这属"无可检查对象"，改它属**契约决定**，**不擅自动** |
| **INV-DEEPLINK-protocol** | Windows 交付通道协议（`shuyonote://`）四处一致：scheme ／ `single-instance` 的 `deep-link` feature ／ 插件注册与事件接线 ／ 事件名前后端与 `CommandMap`／web shell | `scripts/check-deep-link.mjs`（`--root`，2026-09-28 加） | ✅ 账本 `exit=1`（sha 见账本）｜夹具实测（拷真仓那 6 处文件，只改一处）：原样 exit 0（`交付通道协议一致：scheme shuyonote://…`）／ **只把 `tauri.conf.json` 的 scheme 改成 `shuyonote-typo` ⇒ exit 1**（逐字「声明了 scheme 但没有 shuyonote（实际：shuyonote-typo）」） |
| **INV-CI-gitcode-platform-rules** | GitCode workflow 的三条平台硬约束（`runs-on` 白名单 ／ 每个 step 必须有非空 `name` ／ 不接受简写 action） | `scripts/check-gitcode-workflow-rules.mjs`（`--root`，2026-09-28 加） | ✅ 账本 `exit=1`（sha 见账本）｜夹具实测（真仓 workflow 的拷贝，只改一处）：原样 exit 0（`3 个文件（豁免 0 个）`）／ **只把 `runs-on` 换成 `macos-latest` ⇒ exit 1**（逐字「job `build-linux` 的 runs-on 不在白名单（macos-latest）」）。⚠️ **边界**：没有 `.gitcode/workflows` 的检出上它会「跳过」并 **exit 0** ⇒ 那种检出上**这条不变式没被检查过** |

| **INV-UI-overlay-registry** | 浮层登记（返回栈 / 移动端量测） | `scripts/check-overlay-registry.mjs` | ✅ 账本 `exit=1`（sha `959422b40119`）｜配方：对照组 = 真 `src/` 原样复制（A 段 24 条登记全部对得上、B 段 OVERLAYS 无幽灵、豁免清单无过期条目）⇒ `exit 0`；变异组**只**把 `src/components/AboutDialog.tsx` 里那一行 `useOverlayLayer("about", open, …)` 的登记调用注释掉（浮层容器 `.shortcuts-overlay` 仍在渲染）⇒ … |
| **INV-UI-prism-single-path** | 代码块高亮只有一条装配路径（不许再有 vendored 的 Prism script） | `scripts/check-prism-components.mjs` | ✅ 账本 `exit=1`（sha `f3feb69c6afa`）｜配方：对照组 = 真 `index.html`（零 Prism `<script>`、`public/prism` 已删）＋ 真 `src/editor/prismSetup.ts` ⇒ `exit 0`；变异组**只**在 `index.html` 的 `</head>` 前加一行 `<script src="prism/prism-core.js"></script>`（第二条装配路径）⇒ 必须报红… |
| **INV-DOC-links-and-index** | 文档相对链接 | `scripts/check-doc-links.mjs` | ✅ 账本 `exit=1`（sha `655f07547d6f`）｜配方：假根里 docs/README.md 只有标题（无死链、无快速导航表、无 plans 索引）⇒ 必须 exit 0；随后**只**加一行指向不存在文件的相对链接 ⇒ 必须报红（逐字配方见账本 what/command；⚠️ 这里**故意不照抄那行的链接写法** —— 抄进来会被 `check-doc-links` 当场当成真死链，2026-09-28 实测踩过一次）… |
| **INV-DOC-gate-registry-names** | 文档里的机器事实（门禁 / 能力 / 命令数）与代码一致 | `scripts/check-doc-facts.mjs` | ✅ 账本 `exit=1`（sha `aa4e92cbf836`）｜配方：对照组 = 真 `docs/TESTING.md` + 真 `scripts/`（它自己再起 `check-web-commands` / `check-capabilities` 两个子进程并解析汇总行）⇒ `exit 0`、51 条门禁全在文档里有名字；变异组**只**把 `docs/TESTING.md` 里门禁 id `check-ps1-ascii` 全部改名成 `check-ps1-a… |
| **INV-INSTALL-nsis-fork** | NSIS 安装器模板（fork 的一行改动 + CLI 版本核对） | `scripts/check-nsis-template.mjs` | ✅ 账本 `exit=1`（sha `b06c6271bdfd`）｜配方：对照组 = 真 `src-tauri/tauri.conf.json` + 真 `src-tauri/nsis/installer.nsi` + 真 `package.json`（模板头部 `cli-version` 与 package.json 一致、那一行 fork 改动恰好 1 次、没有残留上游旧默认目录）⇒ `exit 0`；变异组**只**把 installer.nsi 里那一行 for… |
| **INV-ANDROID-apk-contents** | 验一个 **APK 产物**：壳适配层真的进包了吗？ABI 是不是只有一个？（**逐字引自脚本头部** —— 它没有注册表 label：注册表只跑「不带参数」的判据，而它要 APK 路径；真实调用点＝`release.yml:690` 的 `run: node scripts/check-apk-contents.mjs "$RUNNER_TEMP/…apk"`，本地入口＝`pnpm check:apk`） | `scripts/check-apk-contents.mjs` | ✅ 账本 `exit=1`（sha `f9586fe1f054`）｜配方：对照组 = 合成 APK（stored zip 自写：`classes.dex` 含四条能力串 + `lib/arm64-v8a/libpdfium.so` + `META-INF/CERT.RSA`）⇒ `exit 0`；变异组**只**从 `classes.dex` 里删掉 `installApk` 这一个串（ZIP 其余字节不动）⇒ 必须报红。⚠️ 真仓没有 APK 产物，所以这一条的对照组… |
| **INV-ANDROID-ocr-assets** | OCR 资源清单 | `scripts/check-ocr-assets.mjs` | ✅ 账本 `exit=1`（sha `198755594212`）｜配方：对照组 = 真 `public/ocr/core/` 原样复制（三档 SIMD 齐全、无死重变体）⇒ `exit 0`；变异组**只**删掉 `public/ocr/core/tesseract-core-simd-lstm.wasm`（它的 `.wasm.js` 同伴还在）⇒ 必须报红… |
| **INV-PDF-worker-shim-order** | pdf.js worker 垫片（顺序不变量，裸 Node） | `scripts/check-pdfjs-worker-shim.mjs` | ✅ 账本 `exit=1`（sha `d416bef1052e`）｜配方：**对照组 = 真仓 in-place `exit 0`**（3/3 全过）；变异组 = 假根（真 `public/` + 真 `scripts/`，另整份复制真 `node_modules/pdfjs-dist`）里**只**把 `public/pdfjs-worker-shim.mjs` 那两行（先补 polyfill、后动态 import 真 worker）**对调顺序** ⇒ `exit … |
| **INV-PLUGIN-capabilities-parity** | 能力注册表 | `scripts/check-capabilities.mjs` | ✅ 账本 `exit=1`（sha `c2455b3c6d75`）｜配方：对照组 = 真 `capabilities/` + `packages/plugin-types/` + `src/lib/capabilities/frontend.ts` + 真生成物（25 条能力 / 10 个 TS 适配器两侧参数口径都比对）⇒ `exit 0`；变异组**只**把 `blocks.list` 适配器里 `intArg(args, "limit", BLOCKS_LIMIT… |
| **INV-SM-registry-clean** | 共享 registry 没留国密补丁（默认构建别被它悄悄改掉） | `scripts/check-gm-registry-clean.mjs` | ✅ 账本 `exit=1`（sha `e43e90508225`）｜配方：假根（真 `scripts/` 的副本 ＋ 最小 `src-tauri/Cargo.lock`）里 `libsqlite3-sys` 那一条**只删掉 `source` 与 `checksum` 两行**（＝ `--prepare` 留下的残渣形态）⇒ 必须报红。⚠️ 单变量：对照组只有这两行之别。… |

| **INV-KB-ontology-generated** | 本体表与能力注册表一致（生成物不许手改） | `scripts/check-ontology-generated.mjs`（`--self-test` ／ `--file` 夹具 ／ 出口码 0-1-2） | ✅ 账本 D2 `exit=1`（sha `a1dae878b872`）｜2026-09-28 实测：删掉生成物 ⇒ **exit 1**（逐字「✗ 本体表缺失：…」）／生成后 exit 0 ／**手改生成物一行 ⇒ exit 1**（指出第 17 行＋两边原文）／`--self-test` **4/4** ✓ |
| **INV-KB-apiversion-bump** | 外部接口指纹与 `apiVersion` 一致（改了接口必须升版本） | `scripts/check-api-surface-version.mjs`（`--update` 是文档化出口 ／ `--self-test`） | ✅ 账本 D2 `exit=1`（sha `707981c8f57d`）｜实测：删记录 ⇒ exit 1 ／ `--update` ⇒ exit 0 ／**篡改指纹 ⇒ exit 1**（逐字「✗ **接口变了但 `apiVersion` 没变**（1.0.0）—— 正在用它的外部程序会**没有信号地坏掉**」）／`--self-test` **5/5** ✓。指纹**刻意不含 `desc`**（改文案不算破坏接口 ✓） |
| **INV-KB-derived-rebuildable**（**只收录"可重建"半边** ✗） | 生成物自证来源（sha）且可重建（生成命令的脚本存在） | `scripts/check-generated-artifacts.mjs`（`--dir` 夹具 ／ `--self-test` ／ 出口码 0-1-2-3） | ✅ 账本 D2 `exit=1`（sha `f67c38772197`）｜实测：控制组 3 个生成物 exit 0 ／**删掉「注册表 sha256」行 ⇒ exit 1** ／**篡改 sha ⇒ exit 1**（逐字「已标脏」）／`--self-test` **5/5** ✓。⚠️ "删索引 ⇒ 功能不降级"那半**要等索引面成形**（Phase 1）⇒ 本表**没收录** ✗ |
| **INV-KB-readonly-surface** | 外部工具面（生成物）与注册表一致 ＋ 只读面 0 写能力 ＋ 描述无内部标识 | `scripts/check-agent-surface.mjs`（`--phase` ／ `--file` 夹具 ／ `--self-test`） | ✅ 账本 D2 `exit=1`（sha `3e086e7aa4bc`）｜实测：**注入 `pages.create` ⇒ exit 1**（逐字「只读面里出现写能力」）／`--self-test` **5/5** ✓。⚠️ **与 `INV-MCP-readonly-first` 是同一条**：那份仍是它的正文，**本条以"已实现的判据"入表** ✓ |
| **INV-KB-tool-desc-clean** | 外部工具面（生成物）与注册表一致 ＋ 只读面 0 写能力 ＋ 描述无内部标识 | `scripts/check-agent-surface.mjs`（同上：`--phase` ／ `--file` ／ `--self-test`） | ✅ 同一条账本证据（sha `3e086e7aa4bc`）｜实测：**描述里注入 `content_json` ⇒ exit 1** ／ 收窄为"只扫 desc 格"后，表头里合法的 `capabilities.json` 不再假红 ✓ ／ `--self-test` **5/5** ✓ |
| **INV-WIKI-provenance** | `每个 sources 都必须在输入里出现过（不许拼、不许猜）`（**逐字引自测试里那句断言** —— 本条载体是测试，没有注册表 `label`） | `src/lib/ai/libraryMap.test.ts`（`pnpm exec vitest run src/lib/ai/libraryMap.test.ts`）＋ 真模型现场：`scripts/measure-wiki-cost.mjs` 的 `[n]` 越界检查 | ✅ 有（**走 D3 测试形态通道**；「能原地重做」的口子＝仓内脚本 `scripts/mutate-wiki-invariants.mjs`，零依赖 ✓）｜2026-09-29 实测：控制组 **exit 0** ／ 变异组（回链里混进 `ghost-source`）**exit 1**，红的用例逐字＝上面那句 ／ 跑完**逐字节还原** ✓ |
| **INV-WIKI-coverage-visible** | `★ 没读数（null）⇒ 画成「未知」，且这一项里不出现 0`（**逐字引自渲染级测试那句断言**） | `src/components/LibraryMapView.test.tsx` ＋ 纯函数层 `src/lib/ai/libraryMap.test.ts`（成对断言：`null` ⇒ 画「未知」且不出现 0 ／ `0` ⇒ 画 0 且不出现「未知」） | ✅ 有（同上通道与脚本）｜2026-09-29 实测：变异组（把「未知」画成 `0`）**exit 1**，红的用例逐字＝上面那句 ✓ |
| **INV-WIKI-readonly-default** | `调用前后输入逐字段未变（快照比对）` ＋ `输入被深冻结也能跑完（说明它不写输入），且两次调用结果深度相等`（**逐字引自测试**） | `src/lib/ai/libraryMap.test.ts`（另含静态断言：不 import `api`／`platform`／`store`）。⚠️ 目前只覆盖"地图与视图不改数据"；"生成层不改 `pages`"待第三块才有载体 | ✅ 有（同上通道与脚本）｜2026-09-29 实测：变异组（生成时偷改 `report.pages.indexed`）**exit 1**，红的用例逐字＝上面两句 ✓ |

> ⚠️ **这三行在分支 `feat/llm-wiki-map` 上**（与它们的判据**同批** —— 那三个测试文件也在那条分支上）。
> **现在不要把这三行合到 `dev`** ✗：`dev` 上那三个测试文件还不存在 ⇒ 合过去就是**假声明**（本层最恨的那种）。
> 正确顺序：**先把判据合进来，再随判据一起入表** ✓

## 怎么核（**别信本表，跑命令**）

```bash
# 1) 与不变式相关的判据现在是否都绿（走注册表 ＝ CI 同款路径）
#    ⚠️ `--only` 吃的是注册表里的 **id**，而 **id ≠ 文件名**（2026-09-28 实测三例：
#       `check-pdfjs-worker-shim` 的 id 不是文件名；`check-changelog-gate-numbers` 的 id 是 `check-changelog-numbers`；
#       `check-gm-registry-clean` 的 id 是 `gm-registry-clean`）⇒ **先 `--list` 拿 id，别照文件名拼**。
node scripts/test-report.mjs --list
# 想省事就直接跑全部（下表 27 条里的 26 条都在这个盘子里）：
node scripts/test-report.mjs

# 1b) 表里**唯一不在注册表**的那一条：`scripts/check-apk-contents.mjs`
#     —— 它要 APK 路径参数（注册表只跑"不带参数"的判据），真实调用点是**流水线**：
#     `release.yml:690` 打完包就验 ／ 本地：`pnpm check:apk <apk 文件>`
pnpm check:apk <某个 .apk>

# 1c) 那条走 D3（测试形态判据）通道的规则 —— 必须单独跑它的兄弟测试
pnpm exec vitest run scripts/check-workflow-yaml.test.mjs

# 1d) 走同一条 D3 通道的**第二批**：三条 `INV-WIKI-*` 的「看过它红」
#     （控制组绿 ／ 变异组红 ／ 跑完逐字节还原；红的用例逐条点名 ⇒ 三条各一次）
node scripts/mutate-wiki-invariants.mjs

# 2) 本表「会红证据」是否还新鲜（判据代码一改，账本里那条就过期 ⇒ 判据 D2 会红）
node _workspace/bin/check-gate-manifest.mjs
node _workspace/bin/check-all.mjs
```

> 判据 D2 的口径（工作区 `AGENTS.md` §10 那份表）：每条仓内 `check-*.mjs` 都要有
> **真变异证据**（`exit` ∈ {1,2,3}、逐字 `finding`、`gateSha256`）或**带理由的豁免**。
> ⇒ 「本层的会红证据」与「D2 的账本」是**同一本账**，不是两套。

## 本层**故意不含**的（免得被当成遗漏）

- **其余 18 条门禁**：理由（缺可再注入的口子 / 平台绑定造不出夹具）见 [README.md](README.md) §现状；
  普查与复现命令在 `_workspace/notes/2026-09-28-spec-layer-readiness.md`。
- ⚠️ **发现（2026-09-28，未处置）**：`scripts/check-release-parity.mjs`（两条 Android 流水线的步骤一致性）**没有任何自动调用者** ——
  不在 `scripts/lib/gates.mjs` 注册表里，也没有任何 workflow step 调它（`release.yml:499` 只有一句**注释**提到它）。
  ⇒ 这正是本仓 `AGENTS.md` §3 点名的形态（「只挂在 build 链上 ⇒ 在 `pnpm verify` 与 CI 上隐形」）⇒ **它会静默腐烂**。
  处置（**需仓主决定**，我不擅自加）：要么注册进 `gates.mjs`（它是无参数判据，注册得进去），要么在它头部写明为什么不必 —— 现状是**两者都没有**。

- **跨仓契约**（对外表述红线、定价口径）：唯一出处是 `shuyo-site/docs/red-lines.md` 与
  `shuyo-site/ops/business/contract-outline.md`，**不在此处复制**。
- **还在 plan 里的、没有判据兜着的规矩**：它们留在 `docs/plans/`，**不进这一层**（这正是本层的门槛）。
