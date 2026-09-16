# macOS 构建 · 签名 · 公证 · 自动更新（Mac 版）

> 目标：在 **macOS 机器**上构建**签名 + 公证**的 `.dmg` / `.app`，并用 `tauri-plugin-updater` 做**自分发自动更新**（不走 App Store）。
> 前提：一台 macOS 机器（**已有**）+ 一个**付费 Apple Developer 账号**（$99/年，**已有**）。

> ⚠️ **当前状态（2026-09-14）**：Apple 账号已可用，macOS 构建**仍差 5 个 secrets**。
> 本机自检通过：`node_modules/.tauri-wrap.cjs build --bundles app,dmg` 能出
> `ShuyoNote.app` + `ShuyoNote_1.90.2_aarch64.dmg`（未签名，`Signature=adhoc`）。
> 要启用 macOS 通道，只差：**① 造 Developer ID Application 证书 → ② 生成 App 专用密码 → ③ 在 GitHub 配 5 个 secrets → ④ 解开 release.yml 的 macOS 矩阵行**（见 §二、§六）。

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

### 6.2 签名 + 公证（等 secrets）

`.github/workflows/release.yml` 的 macOS 步骤（导入证书 + keychain）**已经写好并留在文件里**，
只差矩阵里那一行：

```yaml
          - platform: macos-latest
            bundles: dmg,app
```

**顺序**：① 先在 GitHub 配好 §2.6 的 5 个 secrets → ② 解开上面两行 → ③ 打 `v*` tag。
（反过来的话，那个 job 会在导入证书那步失败；`fail-fast: false`，其它平台不受影响，但那次 release 不含 macOS。）

## 七、边界 / 注意
- **自动更新只对「签名+公证」版本有效**；未签名/未公证的 mac 包会被 Gatekeeper 拦（可手动下载）。
- **更新器 macOS 是整包替换 `.app`**；用户需点「下载并安装」确认（半自动，不问强行重启）。
- **Universal（同时支持 M 系 + Intel）**：`--target universal-apple-darwin`（产物更大）；
  想省体积可分开出 aarch64 / x86_64 —— 但注意**一次构建只会有一个 `.app.tar.gz`**，
  若同时出两个架构的 dmg，`resolveUpdaterArchiveKeys` 会因"架构无法判定"而**报错**（不猜）。
- Mac 本地打是一种方式；**长期建议**用 GitHub Actions（macos runner 免费）做全自动，
  Mac 主要用来真机验收。

## 八、拿到 Apple 账号后的清单（照着做）
0. **`sudo xcodebuild -license accept`**（Xcode 升级过就必须重来一次；判据见 §一那个警告框——
   `xcrun notarytool --version` 要能打印版本号）。本机现在是**卡在这一步**的。
1. §2.1 找到 **Team ID**（10 位）。
2. §2.2–2.4 申请 **Developer ID Application** 证书 → 装进钥匙串 → 导出 `.p12`。
   **判断标准**：`security find-identity -v -p codesigning` 里有 1 个 `Developer ID Application`。
3. §2.5 生成 **App 专用密码**。
4. §2.6 在 GitHub 配 5 个 secrets。
5. 解开 release.yml 的 macOS 矩阵两行（§六）。
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

## 相关文件
- `scripts/lib/releaseArtifacts.mjs` —— 产物收集 / 平台键 / 清单偏好（含 macOS 的 `.app.tar.gz` 规则与门禁）
- `scripts/release.mjs` —— 发布（建 release、上传、生成 `latest.json`）
- `.github/workflows/release.yml` —— GitHub Actions 三平台（macOS 步骤已就位，矩阵待解开）
- `src-tauri/tauri.conf.json` —— updater endpoints + pubkey + bundle 配置
