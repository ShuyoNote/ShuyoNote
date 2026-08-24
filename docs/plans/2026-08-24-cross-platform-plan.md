# 跨平台适配（全平台通吃）实现方案

> 目标：把 ShuyoNote 从「**Tauri 桌面绑定**」演进为「**平台无关核心 + 多个可插拔平台壳**」——同一套 bundle 跑 浏览器 PWA / 安卓 / iOS / 鸿蒙 ArkWeb，**不再依赖 `window.__TAURI__`**。
> 关联方案：[本地优先方案](plans/2026-08-15-local-first-note-app-plan.md)（数据层）与 [每空间独立存储](plans/2026-08-22-per-workspace-storage-plan.md)（存储布局）；由 [路线图 M6（移动端适配）](roadmap.md) 升级而来——**从「移动端」扩展为「全端通吃」**。**这是一次高成本、改架构的演进，采用「分层 + driver 可插拔 + 渐进迁移」策略（见 §5），绝不一步到位重写存储层。**

> ⚠️ **本方案定位说明**：这是**架构演进提议**，尚未进入实现。文中「推荐路径」「里程碑 M16.x」为规划，`docs/README.md` / `roadmap.md` 按「规划（待里程碑落地）」登记，**未标记 ✅**。现有 app 继续保持 Tauri 桌面形态正常运行。

---

## 1. 背景与动机

ShuyoNote 当前是 **Tauri 2 桌面应用**：前端 React 19 + Lexical + TS（Vite），后端 Rust + SQLite（rusqlite），所有能力经 Tauri `invoke` 桥接。这带来两个深层约束：

| 约束 | 现状 | 后果 |
|---|---|---|
| **平台绑定** | 前端大量直接调用 `@tauri-apps/*` | 只跑桌面，无法覆盖移动/浏览器/鸿蒙 |
| **存储依赖** | 全部持久化走 Tauri `invoke` | 只要换个容器（WebView/浏览器），`window.__TAURI__` 不存在，整站失效 |

**为什么要通吃**：数据是用户的，工具应是活的。用户可能在手机看、在浏览器分享、在鸿蒙 PC 用。若只为鸿蒙做一次（[路径 B](#4三路径对比)),收益局限于单一新平台；而**存储核心解耦**能一次投入、多端复用——这是本方案要解决的问题。

> 关键现实判断：纯粹补一个鸿蒙壳（[路径 A](#4三路径对比)）会**抛弃全部 Rust 后端**；而「Web 核心 + WASM」才是免费拿到浏览器 + 安卓 + iOS + 鸿蒙的共同路径。

## 2. 现实盘点：你面对的「鸿蒙」是什么

| 事实 | 含义 |
|---|---|
| `HarmonyOS NEXT`（纯血鸿蒙）**已不兼容安卓 APK** | 「套壳安卓再上鸿蒙」在 NEXT 上走不通 |
| 鸿蒙 WebView = **ArkWeb** 组件 | 可加载 React/Vite 产物，但 `localStorage`/`IndexedDB` 支持有坑（本地优先应用是硬伤） |
| Tauri 社区正在做 **OpenHarmony 适配**（已有 `tauri-demo` 验证链路） | 理论可行，但**社区早期/实验性**，工具链要自己搭 |
| 鸿蒙 PC（MateBook / HarmonyOS）与鸿蒙手机**形态不同** | 桌面形态与移动形态的适配策略分开考虑 |

> 结论：**ArkWeb 可以承载 UI，但不能假设它能承载本地优先存储**；存储必须走「自己可控的抽象层」。

## 3. 现状耦合盘点（决定工作量）

我把代码库实际耦合点数了一遍（基于 `grep` + 读 `api.ts`）：

- **`src/lib/api.ts`**：约 **60 个 `invoke` 命令**（`list_pages`/`save_page`/`search`/`sync_now`/`save_image`/`attachment_path`/`export_workspace`/`fetch_bookmark_metadata` …）。这是**路由层**，真正的业务逻辑全在 Rust。
- **`@tauri-apps/*` 引用**：**33 处**分布在 12+ 组件（dialog 打开/保存/目录选择、opener 打开外链/路径、`convertFileSrc` 资产 URL、`invoke`）。
- **Rust 后端能力（这才是「要重做」的部分）**：
  - `rusqlite`：SQLite（表结构 + 迁移）
  - `sha2`：附件**内容寻址**（sha256 去重）
  - `argon2` + `chacha20poly1305`：**端到端加密**
  - `zip`：备份 / 导出 / 导入
  - `reqwest`：同步（自建 sync-server，outbox + LWW + 附件内容寻址）
  - `boa_engine`：**插件运行时**（`run_plugin_command` 跑用户 JS，含 `__od` 宿主对象、`Manifest` 白名单）

**一个关键误区要纠正**：跨平台改造**不是改 `api.ts` 的接口**，而是**把 Rust 里的整套业务语义在 TS/WASM 侧重写**（schema、哈希去重、加密、备份格式、同步、插件运行时）——这也是本方案真正的成本来源。

## 4. 三路径对比

| 路径 | 做法 | 收益 | 成本 | 最大风险 | 推荐 |
|---|---|---|---|---|---|
| **A. ArkWeb + ArkTS 原生桥** | Vite 产物塞进鸿蒙 `Web` 组件，JSBridge 把 `api.ts` 映射到 ArkTS 原生 | UI 零改动 | 用 ArkTS **重写整个 Rust 层** | 鸿蒙 `Web` 组件对 `localStorage`/`IndexedDB` 支持有坑；只覆盖鸿蒙 | ⚠️ 高成本低覆盖，**不做首选** |
| **B. Tauri → OpenHarmony** | Rust 后端 + 前端原样，只把系统 WebView 换成 OpenHarmony/鸿蒙 PC 之 | 业务零改动，`api.ts` 不碰，后端一轮不动 | 中（工具链自搭，wry/tao 需调） | **社区早期/不稳定** | ⭐ 桌面优先、只求鸿蒙时最匹配 |
| **C. 存储解耦 → Web 核心** | `api.ts` 抽成 driver 接口，核心语义用 TS 沉淀，SQLite 走 WASM/OPFS | **一次投入全端通吃**（浏览器+安卓+iOS+鸿蒙） | **高**（业务语义重写，含插件 JS 引擎） | **插件引擎 + WASM 性能 + 备份格式兼容** | ⭐ **终局正确，但要渐进** |

**决策**：若你要的只是鸿蒙（尤其鸿蒙 PC），且不动业务 → **路径 B** 收益/风险比最好。若要**全平台通吃** → **路径 C** 是终局，但**绝不能一步到位重写存储层**，需按 §5 分层迁移。

## 5. 推荐架构：分层 + driver 可插拔（吃掉大部「弊」）

把「核心语义」和「平台壳」分离，让跨平台变成**换 driver**，而不是**重写业务**。

```
┌─ 平台无关核心 (pkg/core) ────────────────────────────┐
│  schema / 迁移 / 附件内容寻址 / 加密 / 备份打包语义    │
│  存储 driver 接口: SQLiteDriver / FsDriver / OpenUrl  │
│  (纯 TS，先以 Rust 为参考实现，保证格式兼容)          │
└─────────────────────────┬────────────────────────────┘
                          │  只换 driver，不碰业务
   ┌───────────────┬──────┴──────────┬───────────────┐
   │ Tauri driver  │  Web driver      │  ArkWeb/Android/iOS driver │
   │  rusqlite     │  wa-sqlite/OPFS  │  复用 Web driver 或按平台补 │
   │  (现状)       │  (WASM)          │                            │
```

**核心原则**：
1. **`api.ts` 只换 driver，业务与 UI 零改动。** 把 `invoke(...)` 那 60 个调用抽成 driver 接口，Tauri 实现继续用 `invoke`（现状即 driver A），Web 实现用 `wa-sqlite`/`sql.js` + OPFS（driver B）。
2. **核心语义沉淀在 `pkg/core`，且先用 Rust 驱动跑通现有数据。** 你在 TS 侧重写 Schema/迁移/加密/附件哈希/备份格式，但**先用 rusqlite 驱动**跑通，保证与现有 SQLite 文件格式兼容；WASM 驱动成熟后再切。
3. **渐进迁移，不「停摆重构」。** 今天仍用 Tauri 桌面（功能不损失），WASM 驱动慢慢补齐，边跑边搬。
4. **插件 JS 引擎是隐性深坑**：`run_plugin_command` 依赖 Rust 里的 `boa_engine`。Web 核心下这个引擎**也要移入 WASM 或浏览器**，执行隔离、宿主对象、白名单权限模型全要过一遍——这是最易被忽略、也最深的成本。

## 6. 需要适配的「平台壳」能力

| 能力 | 现状（Tauri） | 浏览器/WebView 后 |
|---|---|---|
| SQLite | `rusqlite` 同步直写 | `wa-sqlite`/`sql.js`（WASM 或异步 OPFS），性能 + 事务/锁语义要重测 |
| 附件归属 | 真实磁盘文件（内容寻址） | OPFS/虚拟文件系统，或各平台 JSBridge 兜底；「系统里能看到」语义丢失 |
| 备份/导出/导入 | 真实 `.zip` 文件、真实路径 | 退化为 OPFS 抽象层或 JSBridge |
| 加密 | `argon2`+`chacha20`（原生） | WASM 可行，但**密钥管理/内存/侧信道**不如原生可控，且要与现有加密库互操作 |
| 同步 | `reqwest` | 浏览器 `fetch`（天然可行） |
| 插件运行时 | `boa_engine`(Rust) | 移入 WASM/浏览器，隔离与权限模型重做 |
| 打开外链/系统对话框/文件拖拽/跨窗口 | Tauri 插件 | 浏览器没有，需各平台 JSBridge 补 |

> 诚实的取舍：**「真实文件」能力在浏览器里是不存在的**（用户无法在系统文件管理器看到、拖进去）。这主要是**产品能力损失**，不只是实现改动。移动 / 鸿蒙可用 JSBridge 还原一部分，但要按平台逐个补坑。

## 7. 里程碑（M16）规划

> 本方案为**规划**，未落地。下列 M16.x 是建议顺序，仍沿用「新增 + 校验 + 切换 + 保留可回滚」的风险控制。

- **M16.0 `api.ts` 抽 driver 接口（零行为变化，最高优先，✅ v1.46.0）**：定义 `Executor`/`DialogDriver`/`OpenerDriver`/`EventDriver`/`AssetDriver`/`WebviewDriver` 接口，`tauri.ts` 唯一宿主 `@tauri-apps/*`，Tauri 实现即现状。**这一阶段纯收益、不返工，无论最终走哪条路径都用得上。**
- **M16.0b 浏览器 Web 平台可跑（✅ v1.47.0）**：`web.ts`（`createWebPlatform`）——`index.ts` 按环境（`window.__TAURI_INTERNALS__`）自动选 Tauri/Web；`web.ts` 的 `invoke` 用 localStorage 持久化 mock 后端（核心笔记 CRUD + 其余命令安全空值不抛错），dialog/opener/event/asset/webview 用浏览器原生驱动；`pnpm dev:web`（独立 5173 端口）。已验证 app 在浏览器引擎真实挂载并渲染、进入编辑器。
- **M16.2 核心语义 TS 化（先以 Rust 驱动跑通）**：`pkg/core` 重写 Schema/迁移/附件寻址/加密/备份格式的 TS 语义，仍走 rusqlite 驱动保证现有数据兼容。
- **M16.3 Web/WASM driver**：`wa-sqlite`+OPFS 落地，逐命令回归（list/tags/search/graph/backlinks/db/属性/版本/附件/同步）。
- **M16.4 插件运行时降级迁移**：`boa_engine` 移入 WASM/浏览器，权限模型对齐。
- **M16.5 各平台壳**：浏览器 PWA → 安卓 WebView → iOS WKWebView → 鸿蒙 ArkWeb（各平台 JSBridge 补齐文件/外链/对话框）。
- **M16.6 验收 + 回归**：全功能回归（存储/加密/同步/插件/附件/备份），生产构建 + 运行验证；原 Tauri 桌面形态保留为 driver A 不回归。

> **里程碑拆分建议**：**M16.0（driver 抽象）+ M16.0b（浏览器可跑）都已完成**——先用 `pnpm dev:web` 让 app 在纯浏览器跑起来验证分层可行，然后再决定是否继续 M16.1–M16.5（存储/语义 TS 化）。

## 8. 后端 / 前端改造要点

- **前端**：`api.ts` 改为从 driver 接口取命令；组件里的 `@tauri-apps/*` 直接调用（dialog/opener/convertFileSrc）抽到对应 driver，UI 不感知平台。
- **后端（Rust）**：保留为 Tauri driver A；its schema/迁移/加密/附件/同步语义作为 `pkg/core` 的**参考实现**，同时在 Rust 侧验证格式兼容。
- **`pkg/core`（新）**：纯 TS，定义 driver 接口 + 核心语义 + 各平台实现；作为前端可复用、可单测的独立包（vitest 直接测，无需起 Rust）。

## 9. 测试与验收标准

- [ ] `api.ts` 各命令在 driver A（Tauri）下行为**完全不变**（回归现有桌面功能）。
- [ ] `wa-sqlite`/OPFS 驱动下，list/tags/search/graph/backlinks/db/属性/版本/附件/同步行为与 Tauri 驱动一致。
- [ ] 现有用户 SQLite 数据文件（含加密库）能被 `pkg/core` 正确读/写/迁移，不损坏。
- [ ] 备份/导出/导入在 Web 驱动下与 Tauri 驱动产出**兼容**（同一 zip 可互相导入）。
- [ ] 插件在 WASM 运行时下与 `boa_engine` 行为一致（含 `__od` 宿主对象 / `Manifest` 白名单）。
- [ ] 浏览器 PWA「新增 + 打开 + 编辑 + 搜索 + 同步 + 附件」端到端可用。
- [ ] 安卓 / iOS / 鸿蒙 ArkWeb 至少一个平台证实 JSBridge 覆盖文件、外链、对话框路径。

## 10. 风险与取舍（诚实标注）

- **最大风险**：插件 JS 引擎（`boa_engine`）移入 WASM/浏览器的隔离与权限模型重做；WASM SQLite 在大数据量下的性能与事务/锁语义；备份格式在「Rust zip ↔ Web zip」间的**互操作兼容**。
- **成本分布**：重写核心语义（schema/加密/附件/同步）在 Rust 侧已沉淀，则 TS 侧是**格式对齐**而非从零发明；但仍是整个方案的大头。
- **能力取舍**：浏览器下单 Web 壳**丢失真实文件 / 系统级对话框 / 跨窗口**，靠 JSBridge 补救，逐平台有「N 个坑」要调。
- **回报后置**：重构是纯成本，收益要到 3 个平台都跑通才显现；对个人项目是**时间预算**风险。
- **不做最优解**：本方案优先保证「业务/前端复用最大」，代价是「每个平台都要单独适配」，并接受 WASM 性能略逊于原生的现实。

## 11. 结论

「全平台通吃」值得做，但**不是重写，而是分层换壳**：把 `api.ts` 抽成可插拔 driver，核心语义在 `pkg/core` 沉淀，先用 Tauri 驱动跑通现有数据，WASM/浏览器驱动逐条补齐。这让你**既拿到跨浏览器 + 安卓 + iOS + 鸿蒙的终局，又不用停摆现在的 app**。**M16.0（driver 抽象）+ M16.0b（浏览器可跑）已完成**——现在 `pnpm dev:web` 就能在纯浏览器跑起来（localStorage mock 后端）。若你只是要鸿蒙（尤其桌面），路径 B（Tauri→OpenHarmony）可比本方案更省。

配套取舍见[设计哲学](design-philosophy.md)（本地优先 + 数据可移植）。
