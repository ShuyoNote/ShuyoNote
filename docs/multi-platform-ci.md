# 多平台自动构建发布（CI）

> 目标：打 `v*` tag 时，自动构建 **Windows / macOS / Linux** 安装包并发布。
> 平台限制：**GitCode 流水线只有 Linux（EulerOS）runner**；Windows/macOS 需 GitHub Actions（有 win/mac/linux runner）。

## 现状（2026-09，v1.83.0）

- **发布渠道（应用内「检查更新」与下载）以 GitCode 为准**：`tauri.conf.json` 的 `plugins.updater.endpoints` 与 `src-tauri/src/updates.rs` 的 `DEFAULT_MANIFEST_URL` 都指向 `https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json`。
- **GitHub（`ShuyoNote/ShuyoNote`）作为镜像 / 多平台构建源**，与 gitcode (`shuyo-cn/ShuyoNote`) 保持同源。要用多平台构建就把仓库镜像到 GitHub，用 `.github/workflows/release.yml`。
- 手动发布工具 `scripts/release.mjs`（gitcode）：校验 tag →（可选 `tauri build`）→ 收集 installer+`.sig` → 生成 `latest.json` → 建 release、上传、更新 `latest` 通道。

## 方案 A：GitHub Actions（构建多平台）

**前提**：把仓库**镜像到 GitHub**，用 `.github/workflows/release.yml`。触发：打 `v*` tag 或 workflow_dispatch。

- **矩阵**（`strategy.matrix.include`）：
  - `ubuntu-24.04` → `--bundles deb,appimage`
  - `windows-latest` → `--bundles nsis`
  - **`macos-latest` → `--bundles dmg,app`（当前被注释，见「macOS 待启用」）**
- **released 步骤**：`actions/upload-artifact@v4` 上传 `src-tauri/target/release/bundle/`；末尾 `release` job 用 **curl + GitHub API** 创建/更新 Release 并只挂 `.exe/.dmg/.deb/.AppImage`（不依赖 `gh` CLI，也不依赖 `softprops/action-gh-release`）。
- **说明**：GitHub Release 只挂安装包；**`latest.json`（更新清单 + 签名）不在 GitHub Release 上**。应用更新通道是 GitCode，所以需把安装包 + `latest.json` 同步到 GitCode（见「发布到 GitCode」）。

**需配置的 GitHub 仓库 Secrets**：
| Secret | 说明 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 签名私钥（客户端更新器签名） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥口令 |
| `GITHUB_TOKEN` | 内置，无需手动 |
| （macOS 待启用）`APPLE_CERTIFICATE` | 开发者 ID 证书 `.p12` 的 base64 |
| （macOS 待启用）`APPLE_CERTIFICATE_PASSWORD` | `.p12` 密码 |
| （macOS 待启用）`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | macOS 公证 |

### macOS 待启用（被 Apple 签名/公证凭据阻塞）
`release.yml` 里 macOS 矩阵**仍注释**，原因：仓库目前**只有** `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，**没有** `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` / Apple ID 三项。缺凭据时，`Import Apple Developer ID cert + keychain` 步骤会因空 `APPLE_CERTIFICATE` base64 解码而必然失败。等这些 secrets 配好，再解开第 26 行 `- platform: macos-latest  bundles: dmg,app` 即可跑通。

### 发布到 GitCode（更新通道）
- 手动：`node scripts/release.mjs --no-build`（需 `GITCODE_TOKEN` + `RELEASE_NOTES`），其生成的 `latest.json` 用**同一签名私钥**产出的 `.sig`，并自动上传 installer/`.sig`/`latest.json` 到 gitcode release 与 `latest` 通道。
- 或手动经 GitCode Open API `/api/v5/repos/:owner/:repo/releases` + `upload_url`（OBS 预签名 PUT）上传安装包与 `latest.json`（v1.83.0 曾用此路径）。
- 注意：`latest.json` 的 `url` 需指向 gitcode release（`.../releases/download/v<ver>/<file>`），签名必须与该文件字节一致（用同一构建产出的 `.sig`）。

## 方案 B：GitCode 流水线（仅 Linux）

`.gitcode/workflows/build-linux.yml`：打 `v*` tag → EulerOS runner 上装 Node/Rust/Tauri 依赖（`dnf`），构建 `.deb` + `.AppImage`。

- **只能出 Linux 包**（GitCode 只有 EulerOS runner）。
- 依赖的包管理器命令（`dnf` vs `apt`）可能需要按 runner 实际调整。
- 该 workflow 只把产物作为 pipeline artifact，**不自建 release / 不上传 `latest.json`**。

## 方案 C：人工 + 远程脚本（旧）

- Windows：本机 `pnpm tauri build` + `release.mjs`（`latest` 通道）。
- Linux：远程 Ubuntu 脚本（已打通，见 `docs/SYNC.md` 之外的本机折腾记录）。
- macOS：需一台 Mac（且已配好 Apple 证书）。

## 推荐

- 真正「一劳永逸三平台」 → **方案 A（GitHub Actions）**，把仓库镜像到 GitHub，并**配齐 Apple 签名/公证 secrets** 后解开 macOS 矩阵。
- 只想要 Linux 自动发 + 不离开 gitcode → **方案 B**。
- 不想动发布地址（**留在 gitcode，当前选择**）→ 以 GitCode 为更新通道，Windows 用 GitHub Actions 构建后把包同步到 GitCode；macOS 待证书就位再补。

## 相关文件
- `.github/workflows/release.yml` —— GitHub Actions 多平台构建 + GitHub Release（macOS 当前注释）
- `.gitcode/workflows/build-linux.yml` —— GitCode 流水线（Linux）
- `scripts/release.mjs` —— gitcode 发布（生成 `latest.json` + 上传安装包）
- `docs/macos-updater.md` —— macOS 签名/公证/自动更新细节
