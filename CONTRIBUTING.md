# Contributing to ShuyoNote

欢迎参与 ShuyoNote 的贡献。项目文档按主题组织，统一入口是 [`docs/README.md`](docs/README.md)。

## 我要做什么 → 看哪里

| 目的 | 入口 |
|---|---|
| 跑起来 / 改代码 / 验证 / 提版 | [docs/development.md](docs/development.md)（开发指南：命令、验证循环、版本号提升规则、常见坑） |
| 了解产品定位 / 架构 / 路线图 | [docs/README.md](docs/README.md) 导航表 |
| 某功能的技术方案 / ADR / 里程碑 | `docs/plans/` |
| UI/UX 设计与实现 | `design/` |
| 版本变更历史 | [CHANGELOG.md](CHANGELOG.md) |

## 提交前请遵守

- **改功能先验证**：跑 `node scripts/smoke-web.mjs`（期望 `N passed, 0 failed`）、`npx tsc --noEmit`、`pnpm build`、`cargo check --manifest-path src-tauri/Cargo.toml`。
- **发版要同步 6 处**：`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` / `README.md` 徽章 / `docs/README.md` / `CHANGELOG.md`（详见 development.md 第 5 节）。
- **不要用 shell 重写含中文的 UTF-8 文件**（会乱码）。
- **新增文档记得登记进 `docs/README.md` 索引**。

> 详细约定见 [docs/development.md](docs/development.md)。
