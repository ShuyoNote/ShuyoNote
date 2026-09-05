# macOS 构建 · 签名 · 公证 · 自动更新（Mac 版）

> 目标：在 **macOS 机器**上构建**签名 + 公证**的 `.dmg`/`.app`，并用 `tauri-plugin-updater` 做**自分发自动更新**（不走 App Store）。
> 硬件前提：一台 **macOS 机器**（周一到位）+ 一个 **Apple Developer 账号**。

## 一、Mac 机器要做的事（一次性）
```bash
# Xcode Command Line Tools（签名/公证 + 编译需要）
xcode-select --install
# Rust + node + pnpm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
# pnpm（走 npmmirror 国内镜像）
npm config set registry https://registry.npmmirror.com
npm install -g pnpm@latest
```

## 二、Apple 签名 + 公证（自动更新的硬前提）
需要 **付费 Apple Developer 账号**（$99/年）：
1. **Developer ID Application 证书**（用于 `codesign`）——从 Apple Developer 后台下载 `.p12` + 密码。
2. **Notarization 凭据**：`APPLE_ID`（Apple ID 邮箱）、`APPLE_PASSWORD`（该 Apple ID 的**App 专用密码**）、`APPLE_TEAM_ID`（Team ID）。

> 导出/准备：
> - 证书安装到本机「钥匙串」或临时导入为 `APPLE_CERTIFICATE`（base64.p12）+ `APPLE_CERTIFICATE_PASSWORD`。
> - 相关 secrets 在 CI（方案 A）配置：`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`/`APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`。

## 三、Tauri 客户端更新器配置（`src-tauri/tauri.conf.json`）
```jsonc
{
  "plugins": {
    "updater": {
      "pubkey": "<你的真实公钥>",        // tauri signer generate 生成
      "endpoints": [
        "https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json"
      ]
    }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg"],                 // mac 用 dmg（可加 app）
    "macOS": {
      "signingIdentity": "<Developer ID Application: 你的名字 (TEAMID)>",  // 或用 env
      "entitlements": null
    }
  }
}
```
> 注意：当前 `targets:["nsis"]` 仅 Windows；**发布三平台时**用 `--bundles` 按平台覆盖（mac 用 `dmg,app`），或把 `targets` 改成 `"all"`（每个平台各出各的）。
> E1 附件加密/密钥与更新器无关；`pubkey` 与 Windows 共用同一签名密钥即可（`~/.tauri/shuyonote.key`）。

## 四、Mac 上打（签名 + 公证）包
```bash
cd ShuyoNote
pnpm install --no-frozen-lockfile
# 签名（本机已装证书的话，Tauri 自动 codesign；否则用 env 注入）
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/shuyonote.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/shuyonote.key.pw)"
export APPLE_ID="..." APPLE_PASSWORD="..." APPLE_TEAM_ID="..."
# 构建 dmg（默认本机架构；要 universal 加 --target universal-apple-darwin）
pnpm tauri build --bundles dmg
```
- 产物：`src-tauri/target/release/bundle/dmg/ShuyoNote_<ver>_aarch64.dmg`（M 系）或 `_x64.dmg`（Intel）。
- **公证**：Tauri 2 在配置 `APPLE_*` 后会**自动** `xcrun notarytool submit` + `stapler`，产出公证过的 dmg。

## 五、发布到 gitcode + 自动更新
- 用**已有** `scripts/release.mjs`（它已处理 `dmg` → `darwin-x86_64/darwin-aarch64` 平台 key）：
```bash
GITCODE_TOKEN=<token> TAURI_SIGNING_PRIVATE_KEY=<...> \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<...> RELEASE_NOTES="ShuyoNote v1.82.x" \
node scripts/release.mjs --no-build
```
- 它会：建 release、上传 `.dmg (+.sig)`、生成并上传 `latest.json`（含 mac 平台清单）。
- **mac 客户端**用 `endpoints`（`/releases/download/latest/latest.json`）查更新 → 下载公证后的新 dmg → 用户点「安装」更新。
- 注意：`latest.json` 的 `platforms` 会同时含 `darwin-x86_64`/`darwin-aarch64`（按 Mac CPU 选）。

## 六、CI（方案 A：GitHub Actions）
`.github/workflows/release.yml` 里 macOS job 已预留 `APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID`；在 GitHub 仓库配好 **secrets**（上述 5 项），打 `v*` tag 即自动打三平台（含 mac 签名+公证）。

## 七、边界 / 注意
- **自动更新只对「签名+公证」版本有效**；未签名/未公证的 mac 包会被 Gatekeeper 拦，无法自动更新（可手动下载）。
- **更新器 macOS 是整包替换 `.app`**；用户需点「下载并安装」确认（半自动，不问强行重启）。
- **Universal（同时支持 M 系 + Intel）**：`--target universal-apple-darwin`（产物更大）；想省体积可分开出 aarch64 / x86_64。
- Mac 本地打是一种方式；**长期建议**用 **GitHub Actions**（有 macos runner）做全自动三平台，Mac 主要用于测试 + 签名证书申请。

## 八、Mac 到手当天清单（照着做）
1. `xcode-select --install` + rust + node + pnpm（见 §一）。
2. 装 Developer ID 证书到钥匙串（或导出 `.p12`）。
3. `pnpm tauri signer generate -w ~/.tauri/shuyonote.key`（若还没有）→ 把 pubkey 写进 `tauri.conf.json`；确认与 Windows 共用同一把。
4. `pnpm tauri build --bundles dmg`（带 `APPLE_*` 环境变量）→ 应产出**公证过**的 dmg。
5. `node scripts/release.mjs --no-build` 上传 + 生成 mac latest.json。
6. mac 上装一次确认 Gatekeeper 不拦（右键打开 / 已公证），再测「检查更新」。

## 相关文件
- `scripts/release.mjs` —— 发布（含 dmg/darwin 平台 key）
- `.github/workflows/release.yml` —— GitHub Actions 三平台（含 mac secrets 预留）
- `src-tauri/tauri.conf.json` —— updater endpoints + pubkey + bundle.macOS
