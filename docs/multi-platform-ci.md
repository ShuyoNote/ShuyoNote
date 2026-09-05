# 多平台自动构建发布（CI）

> 目标：打 `v*` tag 时，自动构建 **Windows / macOS / Linux** 安装包并发布。
> 平台限制：**GitCode 流水线只有 Linux（EulerOS）runner**；Windows/macOS 需 GitHub Actions（有 win/mac/linux runner）。

## 一套方案

### 方案 A：GitHub Actions（推荐，真·三平台自动发）

**前提**：把仓库**镜像到 GitHub**（或在 GitHub 建同源私库/镜像），用 `.github/workflows/release.yml`。

- 打 `v*` tag → 矩阵跑 **ubuntu-24.04 / windows-latest / macos-latest** 三平台：
  - Linux：`--bundles deb,appimage`
  - Windows：`--bundles nsis`
  - macOS：`--bundles dmg,app`
- 上传产物 → `softprops/action-gh-release` 汇总创建一个 Release。

**需配置的 GitHub 仓库 Secrets**：
| Secret | 说明 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 签名私钥（客户端更新器签名） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥口令 |
| `TAURI_SIGNING_PRIVATE_KEY` + `GITHUB_TOKEN` | 内置，无需手动 |
| （可选）`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | macOS 公证 |

> 国内网络：workflow 里 `pnpm install` 走 `npmmirror`，若 GitHub runner 可直连也可去掉该 env。

### 方案 B：GitCode 流水线（仅 Linux）

`.gitcode/workflows/build-linux.yml`：打 `v*` tag → EulerOS runner 上装 Node/Rust/Tauri 依赖（`dnf`），构建 `.deb` + `.AppImage`。

- **只能出 Linux 包**（GitCode 只有 EulerOS runner）。
- 依赖的包管理器命令（`dnf` vs `apt`）可能需要按 runner 实际调整。

### 方案 C：现状（人工 + 远程脚本）

- Windows：本机 `pnpm tauri build` + `release.mjs`（latest 通道）。
- Linux：远程 Ubuntu 脚本（已打通，见 `docs/SYNC.md` 之外的本机折腾记录）。
- macOS：需一台 Mac。

## 推荐

- 想真正「一劳永逸三平台」 → **方案 A（GitHub Actions）**，把仓库镜像到 GitHub 即可。
- 只想要 Linux 自动发 + 不离开 gitcode → **方案 B**。
- 不想动发布地址（留在 gitcode）→ 继续方案 C，必要时加开自托管 runner。

## 相关文件
- `.github/workflows/release.yml` —— GitHub Actions 三平台
- `.gitcode/workflows/build-linux.yml` —— GitCode 流水线（Linux）
