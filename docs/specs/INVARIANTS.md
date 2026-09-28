# 不变式清单（本仓当前契约）

> **收录条件（三条，缺一不可）**：① 能指到**一条会红的判据**；② 那条判据有**「看过它红」的证据**
> （`_workspace/mutation-evidence.json` 里按脚本 sha 绑定；**判据代码一改，证据自动过期**）；
> ③ **证据能原地重做** —— 判据那边得有一个「再注入」的口子（`--root` ／ 位置参数 ／ `--self-test` ／
> 或已写明的**假根配方**）。⚠️ 缺第③条，判据一改（sha 变）第②条就**永远补不回来**，那条不变式只能被动撤下 ——
> 例：`check-pdfjs-worker-shim` **满足②**（有新鲜证据）但**暂时不满足③**（它的判定方式是"在受控 `globalThis` 里跑"，
> `--root` 夹具被撤回）⇒ 因此**不收**，并在 `_workspace/notes/2026-09-28-spec-layer-readiness.md` 里记着为什么。
> ⇒ **过期即从本表撤下**（先重做证据，再放回）。本表不是"愿望清单"。
>
> 「口径」一列**逐字引自** `scripts/lib/gates.mjs` 的 `label`（本仓门禁注册表＝单一事实来源）；
> 「挡的是哪次事故」见同处 `incident` 字段。**本表不重写口径、不复述实现**。
>
> 收录范围与「为什么不收其余 34 条」见 [README.md](README.md) §现状。

| id | 口径（引自注册表 `label`） | 判据 | 会红证据 |
|---|---|---|---|
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

## 怎么核（**别信本表，跑命令**）

```bash
# 1) 这 17 条判据现在是否都绿（走注册表 ＝ CI 同款路径）
node scripts/test-report.mjs --only check-changelog,check-changelog-numbers,check-changelog-tags,check-changelog-version-parity,check-dead-code-receipts,check-derived-writers,check-doc-content-access,check-hook-order,check-main-only-commits,check-plan-status,check-store-subscriptions,check-ps1-ascii,check-workflow-yaml,check-versions,check-gitcode-workflow-rules,check-deep-link,check-web-commands

# 1b) 第 13 条那条规则的承重通道（D3 测试形态判据）—— 必须单独跑它
pnpm exec vitest run scripts/check-workflow-yaml.test.mjs

# 2) 本表「会红证据」是否还新鲜（判据代码一改，账本里那条就过期 ⇒ 判据 D2 会红）
node _workspace/bin/check-gate-manifest.mjs
node _workspace/bin/check-all.mjs
```

> 判据 D2 的口径（工作区 `AGENTS.md` §10 那份表）：每条仓内 `check-*.mjs` 都要有
> **真变异证据**（`exit` ∈ {1,2,3}、逐字 `finding`、`gateSha256`）或**带理由的豁免**。
> ⇒ 「本层的会红证据」与「D2 的账本」是**同一本账**，不是两套。

## 本层**故意不含**的（免得被当成遗漏）

- **其余 28 条门禁**：理由（缺可再注入的口子 / 平台绑定造不出夹具）见 [README.md](README.md) §现状；
  普查与复现命令在 `_workspace/notes/2026-09-28-spec-layer-readiness.md`。
- **跨仓契约**（对外表述红线、定价口径）：唯一出处是 `shuyo-site/docs/red-lines.md` 与
  `shuyo-site/ops/business/contract-outline.md`，**不在此处复制**。
- **还在 plan 里的、没有判据兜着的规矩**：它们留在 `docs/plans/`，**不进这一层**（这正是本层的门槛）。
