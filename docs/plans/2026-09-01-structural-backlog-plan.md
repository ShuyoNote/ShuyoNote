# 后续迭代立项：安全加固后的结构性改进

> 背景：2026-09-01 完成 ShuyoNote 客户端 + shuyonote-sync-server 服务端两端的 P0/P1/P2 安全加固、E1 加密兼容、H1 高可用、前端单测地基（71 断言）后，剩余三项**结构性改进**独立立项。每项均为「重构/基建」而非「安全补丁」，收益在长期可维护性与规模化，故各自独立迭代、分步落地，不与功能迭代混排。
> 关联：[development.md](../development.md)（验证循环）、[architecture.md](../architecture.md)（平台 driver）、服务端 `docs/roadmap.md`（H1–H4）。

## 进度状态（2026-09-01 更新）

| 立项 | 状态 | 已落地 |
|---|---|---|
| ① markdown round-trip 单测 | ✅ **达成** | `mdToHtml`（12）+ `mdPreview`（5，经 `$convertFromMarkdownString`/`$importHtml`）+ happy-dom 测试环境（`vitest.config.ts` + `src/test/setup.ts`） |
| ② web.ts 命令契约层 | 🔶 **前两步达成** | 未知命令改为抛错（`web.ts` 兜底）+ 补齐 10 个缺失命令 + `scripts/check-web-commands.mjs` 覆盖率检查（接入 `pnpm check:web-commands`）；完整 CommandMap 类型化迁移待排期 |
| ③ 服务端单 Mutex 并发瓶颈 | 🔶 **第一步达成** | `push` 批量 INSERT 改单事务（`sync.rs`）；读写分离/连接池待排期 |

> 另：本轮顺带完成「Web 版平台能力边界显式降级提示」（SyncPanel/ThemeSettings/PluginManager 三入口）与服务端「register 口令强度 ≥8 字符」，不在原三项立项内。

## 立项 1：markdown round-trip 单测（客户端）

### 背景 / 问题
前端单测已覆盖核心纯函数（71 断言），但 **markdown ↔ Lexical 的转换层**（`src/editor/markdownTransformers.ts`、`htmlToLexical.ts`、`mdToHtml.ts`）仍零测试。这是「Markdown 无损往返」（M1）正确性的高风险区——标题/列表/待办/表格/代码块/引用/分栏/公式任一转换回归，都会静默丢内容。

### 目标
为 markdown 导入 / 导出往返补测试，防止格式丢失回归。

### 方案
1. 引入 Lexical 无头编辑器（`@lexical/headless` 或 `createEditor`）在 Node 环境跑 `$convertFromMarkdownString`。
2. 测试 `markdown → editor state → $convertToMarkdown` 的往返。
3. 覆盖块类型：标题（1–6 级）、列表（有序/无序/待办）、表格、代码块（带语言）、引用、Callout、分栏（降级为段落，需明确断言降级行为）、图片（尺寸/alt）、行内公式 / 块级公式。

### 验收
- 核心块类型 round-trip 不丢内容（标题层级、列表嵌套、表格单元格、代码语言、链接 URL 均保持）。
- `pnpm test` 全绿，断言并入验证循环。

### 风险 / 取舍
- Lexical 在 Node 环境需要 DOM mock（`jsdom` / `happy-dom`），需先验证 `@lexical/headless` 在 Node 的可跑性。
- DecoratorNode（分栏/绘图/公式）的 markdown 是**有损降级**，测试需断言「降级后信息不丢、可读」，而非「字节级往返」。

---

## 立项 2：web.ts 命令契约层（客户端）

### 背景 / 问题
`src/lib/platform/web.ts`（2375 行单体）手写 ~70 个命令的 SQL 实现，与 Rust 后端 116 个 command **双份平行维护**。无编译期契约：命令名是裸字符串，参数形状漂移靠 `a.args ?? a` 双形态补丁，未知命令静默返回 `{}`（掩盖前端 bug），新增/修改命令需在两处手工同步。

### 目标
建立命令契约层，消灭双份后端漂移，让「漏实现 / 参数形状不一致」在编译期或测试期暴露。

### 方案
1. 定义 `CommandMap` 类型（命令名 → `{ args; result }`），由 `api.ts` 消费；`tauri.ts` / `web.ts` 各自实现同一接口。
2. `smoke-web.mjs` 加**命令覆盖率检查**：断言「桌面注册的 command，web 均有实现且返回形状一致」。
3. 分步迁移：先落地契约类型 → 再逐命令迁移 web.ts 的 `makeInvoke` 分支 → 最后清掉 `a.args ?? a` 补丁。

### 验收
- 新增 / 修改命令在两端同步，契约层编译期报错；覆盖率检查进 `pnpm build` 或 `pnpm test`。
- web.ts 命令分支迁移到类型化实现，未知命令返回明确错误而非 `{}`。

### 风险 / 取舍
- web.ts 重构面大（2375 行），必须**分步、每步可回滚**；先契约层后迁移，避免一次性重写。
- 需与 smoke-web.mjs（347 断言）保持同步，迁移期断言只增不减。

---

## 立项 3：服务端单 Mutex 并发瓶颈（shuyonote-sync-server）

### 背景 / 问题
`AppState` 的 `Mutex<Connection>` 串行化所有 DB 操作：`push` 在锁内逐条 `INSERT`、`pull` 在锁内 `query_map + collect`，高并发（多设备同时 push/pull）下成为吞吐瓶颈。SQLite 单写者 + WAL 模式本可支持「多读一写」，当前单 Mutex 把它压成了「全串行」。

### 目标
降低锁竞争、提升并发吞吐，同时保持 WAL 一致性与事务语义。

### 方案
1. **低成本**：`push` 批量 INSERT 改为单事务（`BEGIN`/`COMMIT` 包裹循环），减少持锁时间与 fsync 次数。
2. **中成本**：读写分离——WAL 模式下用独立只读连接服务 `pull`/`list_*`，写连接保留单 Mutex。
3. **复核**：附件上传/下载的流式 IO 已在锁外（`spawn_blocking` / 提前 drop guard），逐一复核剩余持锁点，把长操作移出锁。

### 验收
- 并发 push/pull 基准测试吞吐提升（如 8 并发对比单并发）。
- `cargo test` 全绿（当前 9 断言），不破坏迁移幂等 / 空间隔离 / device 归属等既有语义。

### 风险 / 取舍
- SQLite 单写者约束使「读快照」与「写锁」的收益有上限，规模化（H3/H4）仍需 PostgreSQL + 对象存储。
- 连接池改动触及核心连接管理，需充分回归；此项目在「有真实付费团队」前为**可选优化**，优先级低于前两项。
