# 多平台自动构建发布（CI）

> 目标：打 `v*` tag 时，自动构建 **Windows / macOS / Linux** 安装包并发布。
> 平台限制：**GitCode 流水线只有 Linux（EulerOS）runner**；Windows/macOS 需 GitHub Actions（有 win/mac/linux runner）。

## 现状（2026-10-23 更新）

- **发布渠道（应用内「检查更新」与下载）以 GitCode 为准**：`tauri.conf.json` 的 `plugins.updater.endpoints` 与 `src-tauri/src/updates.rs` 的 `DEFAULT_MANIFEST_URL` 都指向 `https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json`。
- **GitHub（`ShuyoNote/ShuyoNote`）作为镜像 / 多平台构建源**，与 gitcode (`shuyo-cn/ShuyoNote`) 保持同源。要用多平台构建就把仓库镜像到 GitHub，用 `.github/workflows/release.yml`。
- **macOS 已接进 `release.yml` 矩阵**（2026-10-23）：`macos-latest` → `--bundles app,dmg`，签名/公证/装订在同一个 build job 里完成；本机已用公司主体 `D53949JLS2` 实测签名+公证通过。
- 手动发布工具 `scripts/release.mjs`（gitcode）：校验 tag →（可选 `tauri build`）→ 收集 installer+`.sig` → 生成 `latest.json` → 建 release、上传、更新 `latest` 通道。

## 方案 A：GitHub Actions（构建多平台）

**前提**：把仓库**镜像到 GitHub**，用 `.github/workflows/release.yml`。触发：打 `v*` tag 或 workflow_dispatch。

- **矩阵**（`strategy.matrix.include`）：
  - `ubuntu-24.04` → `--bundles deb,appimage`
  - `windows-latest` → `--bundles nsis`
  - **`macos-latest` → `--bundles app,dmg`（已启用）**
- **released 步骤**：`actions/upload-artifact@v4` 上传 `src-tauri/target/release/bundle/`；末尾 `release` job 用 **curl + GitHub API** 创建/更新 Release，挂 `.exe/.dmg/.deb/.AppImage` 以及 macOS 的 `.app.tar.gz`/`.sig`（更新器工件，供 GitCode 通道使用）。
- **说明**：GitHub Release 只挂安装包；**`latest.json`（更新清单 + 签名）不在 GitHub Release 上**。应用更新通道是 GitCode，所以需把安装包 + `latest.json` 同步到 GitCode（见「发布到 GitCode」）。

**需配置的 GitHub 仓库 Secrets**：
| Secret | 说明 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | 更新器签名私钥（Windows/Linux/macOS 共用） |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥口令 |
| `GITHUB_TOKEN` | 内置，无需手动 |
| `APPLE_CERTIFICATE` | **公司** Developer ID 证书 `.p12` 的 base64 |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 密码 |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 公司 Apple ID、**App 专用密码**、Team `D53949JLS2` |

### macOS 已接入（凭据还需配到 GitHub）
`release.yml` 的 macOS 矩阵已启用；缺 `APPLE_*` secrets 时，导入证书/签名步骤会显式失败（不会静默出未签名包）。签名身份按 `APPLE_TEAM_ID` 过滤，避免仓库同时导入个人证书时选错。
`macos-signed.yml` 仍是手动调试档，步骤与 release 里的 macOS 分支一致；第一次建议先手动跑它，绿了再打 tag。

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

- 真正「一劳永逸三平台」 → **方案 A（GitHub Actions）**，把仓库镜像到 GitHub；macOS 矩阵**已启用**，只差配齐 Apple 签名/公证 secrets。
- 只想要 Linux 自动发 + 不离开 gitcode → **方案 B**。
- 不想动发布地址（**留在 gitcode，当前选择**）→ 以 GitCode 为更新通道，Windows 用 GitHub Actions 构建后把包同步到 GitCode；macOS 已接入 CI，等 secrets 配好即可。

## 相关文件
- `.github/workflows/release.yml` —— GitHub Actions 多平台构建 + GitHub Release（macOS 已接入）
- `.gitcode/workflows/build-linux.yml` —— GitCode 流水线（Linux）
- `scripts/release.mjs` —— gitcode 发布（生成 `latest.json` + 上传安装包）
- `docs/macos-updater.md` —— macOS 签名/公证/自动更新细节
