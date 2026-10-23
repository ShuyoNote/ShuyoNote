# macOS 构建 · 签名 · 公证 · 自动更新（Mac 版）

> 目标：在 **macOS 机器**上构建**签名 + 公证**的 `.dmg` / `.app`，并用 `tauri-plugin-updater` 做**自分发自动更新**（不走 App Store）。
> 前提：一台 macOS 机器（**已有**）+ 一个**付费 Apple Developer 账号**（$99/年，**已有**）。

> ⚠️ **当前状态（2026-10-23）**：本机已用公司主体
> `Developer ID Application: Puyang Shuyou Information Technology Service Co., Ltd. (D53949JLS2)`
> **签名 + 公证 + 装订成功**（1.92.24，Gatekeeper `accepted / Notarized Developer ID`）。
> `release.yml` 的 macOS 矩阵**已启用**（`macos-latest` → `app,dmg`）；GitHub 侧仍需配 5 个 Apple secrets
> （见 §2.6）才能让 CI 复现。`macos-signed.yml` 保留为手动调试档。
> ⚠️ 本机没有 `~/.tauri/shuyonote.key` ⇒ 手动包只出 dmg；自动更新工件要恢复原私钥后再构建。

> ⚠️ **更新通道的产物是 `.app.tar.gz`，不是 dmg**（本仓库 `scripts/lib/releaseArtifacts.mjs` 已按此实现并有门禁）。
> 证据：`tauri-plugin-updater`（2.10.1）`src/updater.rs` 的 macOS `install_inner()` 直接
> `GzDecoder::new(cursor)` + `tar::Archive::new(decoder)`，函数 docstring 写明期望
> `[AppName]_[version]_x64.app.tar.gz`（里面是 `[AppName].app`）。
> 名字由 `tauri-bundler` 的 `bundle::updater_bundle` 生成：`format!("{}.tar.gz", <…>/ShuyoNote.app)`
> ⇒ **`ShuyoNote.app.tar.gz`（不带版本号、不带架构）**。
> 给更新器一个 dmg（连 gzip 都不是）会**能下载、装不上**；所以清单里 darwin 必须指向 `.app.tar.gz`，
> dmg 照常发布、只用于人工下载安装。`selectArtifacts` 现在会在「有 dmg 却没有 `.app.tar.gz`」时**硬失败**。

## 一、Mac 机器要做的事（一次性）
```bash
# Xcode Command Line Tools（签名/公证 + 编译需要）
xcode-select --install
# ⚠️ 接受 Xcode 许可（**升级 Xcode 之后必须重新接受**）
sudo xcodebuild -license accept
# Rust + node + pnpm
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
npm config set registry https://registry.npmmirror.com
npm install -g pnpm@latest
```
本机现状（已核）：Xcode 完整版在 `/Applications/Xcode.app`（`xcrun notarytool` 在**接受许可后**可用）、架构 arm64。

> ⚠️ **Xcode 许可没接受时，公证这条路是断的，而且报错很像"工具坏了"**（2026-09-15 实测）：
> 本机已同意的许可版本是 **26.6**，而装着的 Xcode 是 **27.0**（升级后需重新接受），于是
> `xcrun notarytool` / `xcrun stapler` / 连 `python3` 都只打印
> `You have not agreed to the Xcode license agreements.` 就退出。
> 后果：Tauri 的公证步骤（`xcrun notarytool submit` + `stapler`）**必然失败**，
> 而 `tauri build` 本身不报这个错——**签名能过、公证过不去**。
>
> **判据**（做完上面那条命令后，这两条都要有正常输出）：
> ```bash
> xcrun notarytool --version     # 期望：打印版本号（本机实测 1.1.2），而不是许可提示
> xcrun stapler --version
> # 另可核对：已同意版本与当前 Xcode 是否一致
> defaults read /Library/Preferences/com.apple.dt.Xcode IDEXcodeVersionForAgreedToGMLicense
> xcodebuild -version
> ```

## 二、Apple 签名 + 公证（自动更新的硬前提）

要准备 **5 样东西**，全部来自付费账号。下面每步都给了**判断标准**（做完怎么知道成了）。

### 2.1 先找到 Team ID（10 位字母数字，如 `ABCDE12345`）

三处任选一处，都能看到同一个值：

1. **网页**：`https://developer.apple.com/account` 登录 → 首页下方 **Membership details** → **Team ID**。
   （免费账号没有这一项；看不到就说明账号还没付费生效。）
2. **钥匙串**：装好证书后（见 2.3），钥匙串里那张证书的名字形如
   `Developer ID Application: 你的名字 (ABCDE12345)`，**括号里那 10 位就是 Team ID**。
3. **Xcode**：`Xcode → Settings → Accounts → 选你的 Apple ID` → 右侧 **Team** 一栏的括号里。

### 2.2 生成 CSR（证书签名请求）

`钥匙串访问（Keychain Access）→ 菜单 钥匙串访问 → 证书助理 → 从证书颁发机构请求证书…`
→ 填 Apple ID 邮箱、常用名称随便写（如 `ShuyoNote`）→ 选 **存储到磁盘** → 得到
`CertificateSigningRequest.certSigningRequest`。

### 2.3 申请 Developer ID Application 证书

1. `https://developer.apple.com/account/resources/certificates/list` → 蓝色 **➕**
2. 选 **Developer ID Application**（在 **Software** 分组里）
   ⚠️ **别选错**：`Apple Development`（只能本地调试）、`Mac App Distribution`（只能上架 App Store）都不行——
   我们要的是能分发给任意用户的那种。
3. 上传 2.2 的 CSR → **Download** → 得到 `developerID_application.cer`
4. **双击 `.cer`** 装进"登录"钥匙串。
   **判断标准**：`security find-identity -v -p codesigning` 列出
   `"Developer ID Application: 你的名字 (TEAMID)"`（本机现在是 `0 valid identities found`）。

### 2.4 导出 `.p12`（CI 要用）

钥匙串访问里右键那张证书 → **导出…** → 文件格式选 **个人信息交换 (.p12)** → 设一个**导出密码**
（这个密码就是下面的 `APPLE_CERTIFICATE_PASSWORD`）。
base64 一下即可作为 CI 的 `APPLE_CERTIFICATE`：

```bash
base64 -i developerID_application.p12 | pbcopy     # macOS 自带，pbcopy 直接进剪贴板
```

### 2.5 App 专用密码（公证用）

`https://appleid.apple.com` 登录 → **登录与安全 / Sign-In and Security** → **App 专用密码** → **➕**
→ 名字随便（如 `shuyonote-ci`）→ 得到形如 `abcd-efgh-ijkl-mnop` 的密码 ⇒ 这就是 `APPLE_PASSWORD`。

> ⚠️ 它是**专用密码**，不是你 Apple ID 的登录密码；也不用 `@` 前的账号密码。
> 可以用 `xcrun notarytool store-credentials` 先本地验证一次，省得在 CI 里试错。

### 2.6 五项对照

| secret / 变量 | 是什么 | 从哪来 |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | `.p12` 的 base64 | 2.4 的 `base64 -i … \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 | 2.4 |
| `APPLE_ID` | Apple ID 邮箱 | 你的账号 |
| `APPLE_PASSWORD` | **App 专用密码** | 2.5 |
| `APPLE_TEAM_ID` | Team ID（10 位） | 2.1 |

> 这 5 项**只能由开发者本人提供**（证书与凭据不可由他人代生成）。

## 三、Tauri 客户端更新器配置（`src-tauri/tauri.conf.json`）

现状：`bundle.targets` 是 `["nsis"]`（仅 Windows），`bundle.macOS` 为空；mac 构建时用 `--bundles` **按平台覆盖**即可，不必改 targets：

```jsonc
{
  "plugins": {
    "updater": {
      "pubkey": "<已配好，与 Windows/Linux 共用同一把>",
      "endpoints": ["https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json"]
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],                 // 保持 Windows 默认；mac/linux 用 --bundles 覆盖
    "createUpdaterArtifacts": true,      // 必须为 true，否则没有 .app.tar.gz / .sig
    "macOS": {
      "minimumSystemVersion": "11.0",    // 可选：arm64 机器实际下限就是 11.0
      "signingIdentity": null            // 留空则由 CI 导入的证书自动选（也可填 "Developer ID Application: 名字 (TEAMID)"）
    }
  }
}
```

## 四、Mac 上打（签名 + 公证）包

```bash
cd ShuyoNote
pnpm install --no-frozen-lockfile
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/shuyonote.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/shuyonote.key.pw)"
export APPLE_ID="..." APPLE_PASSWORD="..." APPLE_TEAM_ID="..."
pnpm tauri build --bundles dmg,app
```

- 产物（三种，两种用途）：
  - `bundle/dmg/ShuyoNote_<ver>_aarch64.dmg` —— **给人下载安装**（+ `.dmg.sig`）
  - `bundle/macos/ShuyoNote.app.tar.gz` —— **更新器用的那个**（+ `.app.tar.gz.sig`）
  - `bundle/macos/ShuyoNote.app` —— 目录，不是发布产物
- **公证**：Tauri 2 在配好 `APPLE_*` 后会自动 `xcrun notarytool submit` + `stapler` 装订。
- 本机自检（**未签名**、也不需要私钥）：
  ```bash
  node node_modules/.tauri-wrap.cjs build --bundles app,dmg --config '{"bundle":{"createUpdaterArtifacts":false}}'
  ```
  ⚠️ DSH 的 `node` 是 Electron 包装（argv[0] 指向 DSH Helper），会让 Tauri CLI 的 npm shim 把
  Helper 路径当子命令 → `unrecognized subcommand '/Applications/DSH Desktop.app/…'`。
  `node_modules/.tauri-wrap.cjs` 就是修这个的（把 `process.argv` 摆正后再加载真 CLI）。

## 五、发布到 gitcode + 自动更新

```bash
GITCODE_TOKEN=<token> TAURI_SIGNING_PRIVATE_KEY=<...> \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<...> RELEASE_NOTES="ShuyoNote v1.90.3" \
node scripts/release.mjs --no-build
```

- 它会：建 release、上传 **dmg（+ .sig）与 `.app.tar.gz`（+ .sig）**、生成并上传 `latest.json`。
- **清单里 `darwin-aarch64` 指向 `ShuyoNote.app.tar.gz`**（`MANIFEST_PREFERENCE` 里 `app.tar.gz` 排在 `dmg` 之前）；
  dmg 也在 release 里，但只用于人工下载。
- mac 客户端用 `endpoints`（`/releases/download/latest/latest.json`）查更新 → 下载 `.app.tar.gz` →
  解包替换 `.app` → 用户点「下载并安装」。
- 门禁：`scripts/lib/releaseArtifacts.mjs` 在「有 dmg 却没有 `.app.tar.gz`」时**硬失败**
  （否则 mac 上表现为"能下载、装不上"）；相关测试见 `scripts/lib/releaseArtifacts.test.mjs`
  的 `macOS 更新通道` 一组（已做变异验证：把偏好改回 dmg 该组立刻变红）。

> ⚠️ **如果打的是 universal 包**（`tauri build --target universal-apple-darwin`，产物名形如
> `ShuyoNote_<版本>_universal.dmg`）：`release.mjs` 会把它**同时**写进 `darwin-aarch64` 与
> `darwin-x86_64` 两个键（2026-09-15 修）。为什么必须这样：更新器是**按平台键找条目**的，
> 只占 `darwin-x86_64` 的话，Apple Silicon 机器的清单里**根本没有** `darwin-aarch64`
> ⇒ 表现为"检查更新什么都不发生"，**不报任何错**。
> 判据在 `scripts/lib/releaseArtifacts.test.mjs`（`platformKeysFor` 与 `manifestPicks` 各有用例；
> 变异自证：把 `manifestPicks` 改回按主键归组 ⇒ 该用例红）。
> 出包方式二选一即可：要么分别出 `x64`/`aarch64` 两个 dmg（各占各的键），要么出一个 universal dmg（占两个键）。
>
> ⚠️ **注意架构覆盖**：`release.yml` 的 `macos-latest` runner 是 **arm64**，默认只出
> `..._aarch64.dmg` ⇒ 清单里只有 `darwin-aarch64` ⇒ **Intel Mac 收不到更新**（同样是静默的）。
> 要覆盖 Intel，就在同一个 job 里加一次 `--target x86_64-apple-darwin`（产出 `..._x64.dmg`，
> 与 aarch64 那份各占一个键），或直接出一个 universal dmg。**这是产品决定**（要不要支持 Intel Mac），
> 不是脚本能替你定的——所以这里只把两条路的代价写清楚，不做强制。

## 六、CI（方案 A：GitHub Actions）

### 6.1 自检（**不需要任何密钥**，已经在跑）

`.github/workflows/macos.yml`：push 到 `dev`/`main` 且命中构建输入路径时，在 `macos-latest` 上
**打一个未签名的 `.app + .dmg`**，再跑 `pnpm check:macos-bundle` 断言
identifier / 版本号 / `shuyonote` 深链 scheme / dmg 都在。

为什么要有它：签名链的密钥只在 `release.yml`，而没有密钥的地方仍能问一个关键问题——
**"干净 macOS 环境里打包这一步过不过、产物对不对"**。这一仓库已经两次吃过
「本机绿 ≠ 干净环境绿」的亏（Android 的 ranlib 与 bindgen target 都只在 Linux runner 上暴露）。
它**刻意不碰密钥、不发布、不挂 tag**。

### 6.2 签名 + 公证（已接入 release.yml）

`.github/workflows/release.yml` 的 macOS 矩阵已启用，并包含：导入公司证书 → 选 `APPLE_TEAM_ID` 身份 →
预签 `libpdfium.dylib` → Homebrew 静态 OpenSSL → `tauri build --bundles app,dmg --features sm-library` →
`check:macos-bundle` → `notarize-macos.mjs`。

```yaml
          - platform: macos-latest
            bundles: app,dmg
```

**剩余动作**：在 GitHub 配好 §2.6 的 5 个 secrets（公司证书/Apple ID/App 专用密码/Team `D53949JLS2`）
＋ 2 个 updater secrets；然后先手动跑 `macos-signed.yml` 验证，绿了再打 `v*` tag。
（缺 secrets 时那个 job 会在证书导入/签名那步显式失败；`fail-fast: false`，其它平台不受影响。）

## 七、边界 / 注意
- **自动更新只对「签名+公证」版本有效**；未签名/未公证的 mac 包会被 Gatekeeper 拦（可手动下载）。
- **更新器 macOS 是整包替换 `.app`**；用户需点「下载并安装」确认（半自动，不问强行重启）。
- **Universal（同时支持 M 系 + Intel）**：`--target universal-apple-darwin`（产物更大）；
  universal 的 dmg 会**同时占两个平台键**（`darwin-aarch64` + `darwin-x86_64`，同一 url、同一签名）；
  同一次构建里那个 `.app.tar.gz` 也跟着占两个键 ⇒ 清单里两个键都指向它 ✓。
  **不要**把它只归到一个键：另一架构的用户会"检查更新什么都不发生"，且不报错
  （判据：`platformKeysFor("…_universal.dmg")` 必须返回两个键；`scripts/lib/releaseArtifacts.test.mjs`「macOS 更新通道」一组盯着它）。
  想省体积可分开出 aarch64 / x86_64 —— 但注意**一次构建只会有一个 `.app.tar.gz`**，
  若同时出两个架构的 dmg，`resolveUpdaterArchiveKeys` 会因"架构无法判定"而**报错**（不猜）。
- Mac 本地打是一种方式；**长期建议**用 GitHub Actions（macos runner 免费）做全自动，
  Mac 主要用来真机验收。

## 八、拿到 Apple 账号后的清单（照着做）
0. **`sudo xcodebuild -license accept`**（Xcode 升级过就必须重来一次；判据见 §一那个警告框——
   `xcrun notarytool --version` 要能打印版本号）。本机 2026-10-23 已通过。
1. §2.1 找到 **Team ID**（10 位）。
2. §2.2–2.4 申请 **Developer ID Application** 证书 → 装进钥匙串 → 导出 `.p12`。
   **判断标准**：`security find-identity -v -p codesigning` 里有 1 个 `Developer ID Application`。
3. §2.5 生成 **App 专用密码**。
4. §2.6 在 GitHub 配 5 个公司 secrets（`APPLE_TEAM_ID=D53949JLS2`）。
5. `release.yml` 的 macOS 矩阵**已启用**（本机已用公司证书实测签名+公证通过）。
6. 本机先手动跑一次 §四（带 `APPLE_*`）→ 应产出**公证过**的 dmg 与 `.app.tar.gz`；
   `spctl -a -vvv ShuyoNote.app` 应显示 `accepted, source=Notarized Developer ID`。
7. 打 `v*` tag → CI 出三平台 + Android；再用 `release.mjs --no-build` 发 GitCode。
8. mac 上装一次确认 Gatekeeper 不拦，再测「检查更新」。

> **动手前两条（2026-09-15 的教训，别省）**：
> - **先 `git pull` 再干活**：v1.91.0 那次事故就是"用旧 checkout 发版"——`release.yml` 少了两步
>   Android 壳适配层注入，打出来的 APK 装上直接闪退，而 CI 全绿。旧分支/旧拷贝发版是同一类风险。
> - **打 tag 前跑 `pnpm release:preflight`**：它一条命令查六件事，其中"`origin/dev` 是否已进 `main`"
>   与"tag 是否已被占用"都是发 1.91.0 时真卡住过的地方。发布后跑 `pnpm check:release-state`。
>   取 CI 产物用 `pnpm fetch:release-artifacts --tag vX.Y.Z --stage`（分片并行 + 续传 + 校验 +
>   自动验 APK 字节）。详见 [RELEASING.md](RELEASING.md) ④⑤⑥。

## 九、公证链的自动化（2026-10-19 落地，**判据显式化**）

> 背景：§四 说 Tauri 2 在配好 `APPLE_*` 后会自己 `notarytool submit` + `stapler`。那是真的，
> 但它**不出证据**——成功时日志里看不到 `Accepted`/`stapler validate`/`spctl accepted`；
> 失败时又常常"签名全绿、dmg 照出"，用户装的时候才被 Gatekeeper 拦
> （`rejected, source=Unnotarized Developer ID`）。所以这条链改成**显式脚本**，自己出判据。

### 9.1 三件判据（缺一不算过）

| # | 判据 | 怎么读 | 缺了会怎样 |
|---|---|---|---|
| ① | `notarytool submit` 返回 **`status: Accepted`** | `--output-format json` 里的 `status` | 没 Accepted 就是没公证；`Invalid` 时要看 `notarytool log` 的 issues |
| ② | **`stapler validate` 通过** | 装订后的票据校验 | 已 Accepted 但没装订 ⇒ **离线机器仍被拦**，而 CI 全绿 |
| ③ | **`spctl --assess` 说 accepted** | `.app` 用 `--type execute`；`.dmg` 用 `--type open --context context:primary-signature` | 说明 Gatekeeper 那关没过（常见原因：ad-hoc 签名、没装订） |

脚本还会拒绝 **ad-hoc 签名**（`codesign -d --verbose=4` 里没有 `Authority=`）：那种包
`codesign --verify --deep --strict` 照样绿，但 Apple 服务器一定拒，报错读起来像网络问题。

### 9.2 本机用法

```bash
# 一次性：把凭据存进钥匙串（不要写进 shell rc 文件）
xcrun notarytool store-credentials shuyonote-notary \
  --apple-id "<APPLE_ID>" --team-id "<TEAM_ID>" --password "<App 专用密码>"

# 只打印将执行什么（密码打码；不联网、不提交）
node scripts/notarize-macos.mjs --keychain-profile shuyonote-notary --dry-run

# 真跑：公证 app 与 dmg、装订、Gatekeeper 复核
node scripts/notarize-macos.mjs --keychain-profile shuyonote-notary
```

CI 形态用环境变量：`APPLE_ID` ＋ `APPLE_PASSWORD`（**App 专用密码**）＋ `APPLE_TEAM_ID`。
退出码：`0` 三件全过 ／ `1` 公证或复核失败 ／ `2` 环境不具备（工具缺、凭据缺 —— **不算通过**）。

### 9.3 CI：`.github/workflows/macos-signed.yml`（手动档）

`workflow_dispatch`，**不是** tag 自动触发 —— 第一次跑要有人盯着读日志。它做的顺序：

1. `cargo fetch --locked`（国密补丁要打在 registry 里那份 SQLCipher 源码上）
2. **准备 Homebrew 静态 OpenSSL 前缀**（`libcrypto.a`/`libssl.a`，过滤掉 `.dylib`；2026-10-23 起不再自编 3.5.4）
3. `sm-library-build.mjs --prepare --require-static` ＋ `--print-env >> $GITHUB_ENV`
4. 取 PDFium → **预签嵌套 dylib**（§四 ②.5 的坑：Tauri 不签 `bundle.macOS.files` 带进来的库）
5. 导入 Developer ID 证书 → `tauri build --bundles app,dmg --features sm-library`
   （**只给签名身份，不给 `APPLE_*`** ⇒ Tauri 只签名，公证交给下一步显式脚本）
6. `pnpm check:macos-bundle`（产物自检）
7. `node scripts/notarize-macos.mjs`（公证 ＋ 装订 ＋ spctl 复核；staple 后 spctl/codesign 带短暂重试）
8. 汇总读数（`codesign` 的 Authority/Timestamp、`stapler validate`、`spctl`、sha256）＋ 上传 artifacts

⚠️ **第一次跑之前**：配齐 5 个 Apple secrets ＋ 2 个 updater secrets（§2.6），否则这一步**故意失败**。
⚠️ **`release.yml` 已用同一套 macOS 步骤**；`macos-signed.yml` 是手动调试档，改一处请同步另一处。

### 9.4 本机端到端（证书到手当天）

```bash
# 签名身份 —— 打包前先预签嵌套库（与 CI 同一步，别省）
codesign -f --options runtime --timestamp \
  -s "Developer ID Application: <名字> (<TEAMID>)" \
  src-tauri/vendor/pdfium/mac-univ/lib/libpdfium.dylib

APPLE_SIGNING_IDENTITY="Developer ID Application: <名字> (<TEAMID>)" \
  pnpm tauri build --bundles app,dmg --features sm-library

node scripts/notarize-macos.mjs
```

期望最后一行：`✅ 公证 Accepted ＋ 已装订 ＋ Gatekeeper accepted`。

## 相关文件
- `scripts/notarize-macos.mjs` —— 公证 ＋ 装订 ＋ Gatekeeper 复核（本文件 §九 的实现）
- `scripts/notarize-macos.test.mjs` —— 三件判据的纯函数判据（`pnpm test` 里跑）
- `.github/workflows/macos-signed.yml` —— 手动发版档（签名 + 公证）
- `scripts/check-macos-bundle.mjs` —— 产物自检（identifier / 版本 / 深链 / dmg / 签名两格）
- `scripts/lib/releaseArtifacts.mjs` —— 产物收集 / 平台键 / 清单偏好（含 macOS 的 `.app.tar.gz` 规则与门禁）
- `scripts/release.mjs` —— 发布（建 release、上传、生成 `latest.json`）
- `.github/workflows/release.yml` —— GitHub Actions 三平台（macOS 矩阵已启用；签名/公证步骤在 build job 内）
- `src-tauri/tauri.conf.json` —— updater endpoints + pubkey + bundle 配置
