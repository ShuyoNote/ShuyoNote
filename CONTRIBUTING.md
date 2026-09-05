# Contributing to ShuyoNote

欢迎参与 ShuyoNote 🎉。感谢你愿意为这个「本地优先」的知识库出一份力。下面从「从哪开始」到「怎么合入」都有，照着走就行。项目文档按主题组织，统一入口是 [`docs/README.md`](docs/README.md)。

## 从哪开始（第一次参与）

1. **跑起来**：`pnpm install && pnpm tauri dev`（桌面），或 `pnpm dev:web`（浏览器）。
2. **找活干**：看 [路线图](docs/roadmap.md) 里还没实现/待做的项，或从 `docs/plans/` 挑一份已被拆解的方案；没有想法就从顺手的小事入手（修 UI 细节、补空/加载/错误态、加单测、修文档）。
3. **提 Issue**：先搜有没有人提过；说清楚「复现步骤 / 期望 / 实际 / 版本」。**不要**在 Issue 里贴大段日志，给关键行 + 复现即可。

## 我要做什么 → 看哪里

| 目的 | 入口 |
|---|---|
| 跑起来 / 改代码 / 验证循环 / 版本号提升 / 常见坑 | [docs/development.md](docs/development.md)（开发指南） |
| 产品定位 / 架构 / 路线图 | [docs/README.md](docs/README.md) 导航表 |
| 某功能的技术方案 / ADR / 里程碑 | `docs/plans/` |
| UI/UX 设计系统与实现 | `design/`、[design/README.md](design/README.md) |
| 版本变更历史 | [CHANGELOG.md](CHANGELOG.md) |

## 提交前请遵守（硬性）

- **改功能先验证**：跑
  - `node scripts/smoke-web.mjs`（期望 `N passed, 0 failed`）
  - `npx tsc --noEmit`
  - `pnpm build`（含 tsc + vite + `check-web-commands` + `check-versions`）
  - `cargo check --manifest-path src-tauri/Cargo.toml`（若动了 Rust）
- **发版要同步 6 处**：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `README.md` 徽章 / `docs/README.md` / `CHANGELOG.md`（详见 [docs/development.md](docs/development.md) 第 5 节）。
- **不要用 shell 重写含中文的 UTF-8 文件**（会乱码）；用编辑器/文本工具改。
- **新增文档记得登记进 `docs/README.md` 索引**。

## 代码风格

- **前端**：TypeScript（严格）、React 函数组件 + hooks、Zustand store；组件按功能分目录；样式用 design token（`App.css` 里的 CSS 变量），不硬编码颜色。
- **Rust**：`cargo fmt` + `cargo clippy` 无警告；错误用 `Result<_, String>`（与现有命令齐平）；读路径不阻塞（`spawn_blocking`）。
- **命令契约**：新增后端命令须同步 `src/lib/platform/commands.ts` 的 `CommandMap`（`check-web-commands` 会校验 Rust 命令 ⊆ CommandMap）。
- **命名/文案**：与现有 UI 一致（中文文案）；i18n 暂不做（见 [docs/SHUYONOTE_STATE.md](docs/SHUYONOTE_STATE.md) 的边界说明）。

## 怎么提 PR

1. 从最新的 `main` 拉一个分支：`git checkout -b feat/your-change`。
2. **小步**：一个 PR 只做一件事；提交信息用 `type(scope): summary`（如 `feat(db): add rollup column`、`fix(sync): exclude .part on upload`）。
3. 提交前跑上面「提交前请遵守」的验证。
4. 开 PR 时描述：**改了什么 / 为什么 / 怎么验证 / 有没有破坏点**；关联 Issue。
5. 保持可读：改动范围尽量聚焦，别把无关重构混进来。

## License

ShuyoNote 客户端以 **AGPL-3.0** 开源。参与即代表你同意以该许可贡献你的改动；自托管/团队同步的 `shuyonote-sync-server` 为独立商业组件，不适用本客户端仓库。

## 其它

- **行为准则**：友善、就事论事；对新人耐心。
- **有问题**：在 Issue 或 Discussions 里讨论；先读 [docs/development.md](docs/development.md) 的「常见坑」，很多答案在里面。

> 详细约定见 [docs/development.md](docs/development.md)；当前状态见 [docs/SHUYONOTE_STATE.md](docs/SHUYONOTE_STATE.md)。
