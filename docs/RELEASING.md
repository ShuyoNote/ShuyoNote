# 发布流程（ShuyoNote）

> 记录，含一次踩坑：**CHANGELOG 段头曾被覆盖导致版本中间断**——用脚本防再犯。
> 发布时间窗（v1.83.0，2026-09）：**GitHub Actions 负责多平台构建（Win/Linux）；GitCode 是应用内「检查更新」与下载通道**。macOS 因缺 Apple 签名/公证凭据暂未启用（见 [multi-platform-ci.md](multi-platform-ci.md)）。

## ① 更新 CHANGELOG
用脚本在顶部插入新版本段（**自动保留所有旧段头**）：
```bash
pnpm changelog 1.84.0 "版本主题"
```
然后编辑生成的 `## [1.84.0]` 段（`### 新增`/`### 修复`/`### 其它` 补条目）。

> **两条硬约定（`pnpm check:changelog` 会挡，见 ⑧）**：
> 1. **`## [Unreleased]` 必须存在、在第一个**——它是"下一版内容写哪儿"的落点，
>    **允许非空**（攒着还没发出去的改动正是它的用途）。把 `[Unreleased]` 整段开成本版本段之后
>    （1.90.2 就是这么做的），**记得再补一个 `[Unreleased]` 回顶部**；
>    1.89.1 / 1.90.0 / 1.90.1 三次发版都留了，1.90.2 漏了（那次之后才补上）。
>    > 这条原先写的是"**且是空的**"，是**误读** Keep a Changelog：要求它为空等于"改动做完了却
>    > 没处记账"——1.90.2 之后的移动端适配就卡在这条上。已在 `scripts/check-changelog.mjs` 放开。
> 2. **段里的小标题只用这七个**：`新增` / `变更` / `修复` / `移除` / `安全` / `废弃` / `其它`，且同一段内不许重复。
>    **`[Unreleased]` 与版本段用同一套**（它记的就是下一个版本的内容）。
>    历史上用过的 `优化 / 改进 / 重构 / 样式 / 工程 / 文档 / 测试 / 验证 / 说明 / 其他 / ### 修复（xxx）`
>    等写法已 grandfather（只对新版本生效，不改历史）。

> **一条写法约定（不是门禁，靠人/agent 自觉；2026-09-20 定）**：
> **每条 ≤6 行**，首句必须是**一句用户可见的变化**；第二句最多一个"为什么"，且只在理由非显然时写。
> **数字只写聚合数**（如 `community_publish::` 15 条）—— 门禁真正核对的只有"绑到基线套件的那些数字"，
> 其余数字写了也没人核。**超过 6 行的内容一律搬去 `docs/plans/` 的方案文档**，这里只留一行指针。
> 理由很实际：**CHANGELOG 是发布后不能改的历史，方案文档随时能改**。本轮就吃过一次 —— 方案 §7.1 有一句
> 写错了（"换一张图不改指纹"），当场改准；同样的话若写在 CHANGELOG 里就只能永久留着。
> 事故/死胡同叙事放 `docs/known-issues.md` 或方案的"口子"清单。三份分工：
> **CHANGELOG = 用户可见变化 ＋ 聚合数字**；**commit message = 为什么 ＋ 证据（含反例）**；**方案文档 = 设计与取舍**。

> ⚠️ 教训：**不要**用「前一版本段头」做手动替换锚点——那会把旧段头覆盖，造成版本断档。务必用上面脚本（它只在首个版本头之前插入，原内容不动）。

## ② 同步多处版本
`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock`(shuyonote version) / `README.md`(badge) / `docs/README.md`(当前版本)。`node scripts/check-versions.mjs` 会强制一致。

## ③ 校验 + 构建
```bash
pnpm run build        # check-versions + tsc + vite build
```

## ④ 提交 + Tag
**打 tag 之前先跑 `pnpm release:preflight`**（`scripts/release-preflight.mjs`）。它一次查六件事，
全是"人常常想当然、而机器一眼能看出来"的：

| # | 查什么 | 不成立时会发生什么 |
|---|---|---|
| ① | 在 `main` 上、已跟踪文件没有未提交改动（未跟踪文件只提醒） | 发出去的东西里有没提交的改动 |
| ② | 版本号六处互相一致（`check-versions`） | 各处版本不一致，装上去显示错的版本 |
| ③ | CHANGELOG 有 `## [<版本>]` 段、`[Unreleased]` 仍在、结构校验通过 | 发布说明空着 / 下一版没落点 |
| ④ | tag `v<版本>` 本地与**两个远端**都没有 | 复用已发布的 tag ⇒ 资产覆盖 ⇒「旧件冒充新件」 |
| ⑤ | **`origin/dev` 已是 `main` 的祖先**（runbook ④ 的硬前提） | 2026-09-15 发 1.91.0 时就卡在这：推到一半发现 dev 还有 3 个提交没进来 |
| ⑥ | `origin`（gitcode）与 `github` 都可达 | 推一半失败 |

> ⑤⑥ 需要联网：离线可用 `--skip-remote` 跳过（会明确打印跳过了什么）。
> 远端命令**先按环境跑、失败再显式绕开代理重试**，并如实报出走的哪条路——
> 这台机器的 `HTTP(S)_PROXY` 指向本地 127.0.0.1:7897，那个代理不一定开着，
> 报出来的是 `Failed to connect to 127.0.0.1 port 7897`，看着像"远端不可达"（其实要绕过代理）。

```bash
pnpm release:preflight                # 退出码非 0 就别打 tag
pnpm release:preflight --version 1.92.0   # 预演还没 bump 的版本（会提示 package.json 还是旧的）
```

```bash
git add -A
git commit -m "release: X.Y.Z(版本号 bump + CHANGELOG)"
git tag -a vX.Y.Z -m "ShuyoNote vX.Y.Z"
git push origin main && git push github main     # main 同样两个远端都推（Pages 部署在 GitHub 侧）
git push origin vX.Y.Z && git push github vX.Y.Z     # tag 必须**两个远端都推**，见下
```

> **进 `main` 的东西必须来自 `dev`**：上面这段写法假定"已经按 [development.md](development.md) §10.2
> 把 `dev` 合进了 `main`"。**合并前先确认这一点**，不要把某条特性分支直接合进 `main`——那正是
> 2026-09-14 发生过的那次偏差（`feat/android-mobile` ⇒ `31514c4`，见 development.md §10.4）。
> 两条判据都要真：`git merge-base --is-ancestor dev main`（PowerShell 里 `$LASTEXITCODE` 为 0），
> 且这次合并是**显式**写的 `git merge --no-ff dev`。任何一条为假 ⇒ **停下查清，不要发版**
> （§9.6 有对应的可勾选项）。

> **为什么 tag 必须两个远端都推**（`origin` = gitcode、`github` = GitHub，两个是**各自独立的仓库**）：
> - **只推 gitcode ⇒ 发版流程不触发**：`release.yml` 是 **GitHub Actions** 的工作流，只有 **GitHub
>   这个仓库收到 tag** 时才会跑（gitcode 上另有一套 `.gitcode/workflows/build-linux.yml`，
>   本意是只出 Linux 包；**它 2026-09-17 之前是坏的、从未跑过**，见 ④ 里的更正）
>   ⇒ 多平台构建（含 Android 发版件）**根本不会开始**；
> - **只推 github ⇒ gitcode 上没有这个 tag**：而 gitcode 是应用内「检查更新」与下载通道（见文首）
>   ⇒ 镜像与更新通道还停在旧版本、用户收不到新版。
> 两条都不是"可有可无"：一个决定**能不能出包**，一个决定**用户能不能收到**。

> **推 GitHub 推不上去时（本机实测过三次，2026-09-15）**：这台机器的 `github.com` DNS 会被污染成
> `127.0.0.1`，所以：
> 1. **首选 SSH over 443**（最稳，实测可用）：
>    ```powershell
>    git -c core.sshCommand="ssh -p 443 -o HostName=ssh.github.com -i C:/Users/cnzen/.ssh/id_ed25519_fengjt007 -o StrictHostKeyChecking=no -o BatchMode=yes" push github main
>    ```
>    （`~/.ssh/config` 里的 `Host github-fengjt` 把 `HostName` 指向了 `github.com`，所以要在这里
>    **覆盖** `HostName=ssh.github.com`；key 就是那个别名用的同一把。`ssh -p 443 git@ssh.github.com`
>    能通就说明这条路可用。）
> 2. 备选：HTTPS + 钉住 IP（IP 会变，且可能**连接被重置**）：
>    ```powershell
>    git -c http.proxy= -c https.proxy= -c http.curloptResolve=github.com:443:140.82.114.3 push https://github.com/ShuyoNote/ShuyoNote.git main
>    ```
>    可用 IP 先用 `curl.exe -s -o NUL -w "%{http_code}" --resolve github.com:443:<ip> https://github.com/` 探一下
>
> **★ 读 CI 结果也一样：`api.github.com` 直连不通，钉 IP 可通（2026-09-22 实测）** ——
> 可用 IP：`140.82.112.6` / `140.82.113.6` / `140.82.114.6`（`140.82.112.3` 已**过期**：报 `ERR_TLS_CERT_ALTNAME_INVALID`）。
> 配方（三条命令就能拿到「哪条门禁红了 ÷ 它的日志 ÷ cargo 的原话」）：
> ```bash
> IP=140.82.112.6
> # ① 这个 commit 的 ci 运行（拿 run id ＋ 结论）
> curl -sS --resolve api.github.com:443:$IP -H "Authorization: Bearer $TOKEN" \
>   "https://api.github.com/repos/ShuyoNote/ShuyoNote/actions/workflows/ci.yml/runs?branch=dev&per_page=5"
> # ② 哪个 job 红了（steps[].conclusion 里就写着是哪一步）
> curl -sS --resolve api.github.com:443:$IP -H "Authorization: Bearer $TOKEN" \
>   "https://api.github.com/repos/ShuyoNote/ShuyoNote/actions/runs/<run-id>/jobs"
> # ③ 那一步的完整日志（`-L` 跟重定向；公开仓库用 token 更稳）
> curl -sSL --resolve api.github.com:443:$IP -H "Authorization: Bearer $TOKEN" \
>   "https://api.github.com/repos/ShuyoNote/ShuyoNote/actions/jobs/<job-id>/logs" -o ci.log
> ```
> 2026-09-22 就是这么读出 `rust-sm-wired` 在 Linux 上红的**真因**的（`openssl-sys` 只看 `<prefix>/lib|lib64`，
> 而 Ubuntu 的开发文件在多架构目录 ⇒ 只给 `OPENSSL_DIR=/usr` 必炸；详见「库级国密：单一口味」那一节）。
>    （实测 `20.205.243.166` 与 `140.82.114.3` 会**轮流**不通）。
> 3. `api.github.com` **不**受影响（DNS 正常），查 CI 状态/下载 artifact 用 `curl` 直接打 API 即可。

> ⚠️ **别连着推**：`ci.yml` 有 `concurrency: cancel-in-progress: true`，每推一次就取消在跑的那一轮，
> 而 Rust job 是最长的一棒 ⇒ 推得越勤，"CI 绿"这个信号越不会出现（Android 构建同理，且它更慢）。
> 等一轮**跑完**再推下一轮；查状态时 **CI / Android (build) / Deploy Web 三个都要看**。

## ⑤ 平台构建

### 多平台（推荐：GitHub Actions）
把仓库镜像到 GitHub，打 `v*` tag / workflow_dispatch → `.github/workflows/release.yml` 自动：
- `ubuntu-24.04` → `.deb + .AppImage`
- `windows-latest` → `.exe (nsis)`
- `macos-latest` → `.dmg/.app`（**待 Apple secrets 后启用**）

> **macOS 档另有两条 PDFium 相关步骤（2026-09-19 加）**：打包前先
> `node scripts/fetch-pdfium.mjs --platform mac-univ` 现拉 `libpdfium.dylib`（二进制**不入库**），
> `src-tauri/tauri.macos.conf.json` 把它映射成包里的 **`Contents/Frameworks/libpdfium.dylib`**
> （⚠️ `bundle.macOS.files` 的方向是 **`键 = 包内目标（相对 Contents）`、`值 = 源文件`**；写反了打包会报
> `Failed to copy "Frameworks/…" to "vendor/…"`，那是它把值当成了源）
> —— 那个位置正是 Rust 侧 `pdfium_native::library_dir()` 在 macOS 上会去找的（`Contents/Resources`
> **不是**它的搜索路径，所以不能用 `bundle.resources`）。打包后用
> `pnpm check:macos-bundle` 对**产物**断言：库在不在、以及它与 `vendor/` 里那份的 **sha256 是否一致**
> （大小相同也可能是别的库）。macos.yml 里已有取库步骤；`check:macos-bundle` 在 CI 的 macOS job 里跑。
>
> ★ **签名必须早于做 dmg（2026-09-22 实测）**：本机复现 `pnpm tauri build --bundles app,dmg` 后发现
> `dmg` 里那份 `.app` 是**签名之前**的拷贝（挂载后 `codesign --verify --deep --strict` ⇒ ❌ exit=1），
> 因为**打包这一步本身不做任何签名**（产物只有工具链的 linker 签名 ⇒ 严格校验报
> `code has no resources but signature indicates they must be present`）。⇒ 有身份时**交给 Tauri 自带签名**
> （`APPLE_CERTIFICATE`/`APPLE_SIGNING_IDENTITY` 那一套，bundler 的顺序本就是 nested → app → dmg）；
> 没有身份时用 `node scripts/sign-macos-app.mjs`（默认 ad-hoc，**先 nested、后 bundle**，签完自动
> `--verify --deep --strict`），但它**不能**在 dmg 之后补签 —— 那样 dmg 里那份仍然是没签的。
> ⚠️ 三条读数口径：① **签名会改字节**（库实测 `3858ed6a…` 15,219,824 B ⇒ `e4a3a51f…` 15,274,928 B，+55,104 B）
> ⇒ "包内与 vendor 逐字节相同"只对**未签名**产物成立（`check:macos-bundle` 已分两条分支）；
> ② 内容一致性的**可证明时刻在签名之前**（脚本在那里断言），签完只能证明"签名有效"；
> ③ ad-hoc 包 `spctl -a -vv` **rejected** 是**预期**（Gatekeeper 要真实身份），别读成"签坏了"。
>
> **Windows 档另有两条 PDFium 相关步骤（2026-09-18 加）**：打包前先
> `node scripts/fetch-pdfium.mjs --platform win-x64` 现拉 `pdfium.dll`（二进制**不入库**，
> `.gitignore` 里有 `src-tauri/vendor/pdfium/`；`src-tauri/tauri.windows.conf.json` 把它映射成
> 装包根目录的 `pdfium.dll`），打包后再用 `7z l` 对**产物**断言装包里真有这个 dll。
> 细节与原因见 §"本机（Windows 签名构建）"。

> **另有 `.github/workflows/macos.yml`（不发布、不需密钥）**：命中构建输入路径时在 macOS runner 上
> 打一个**未签名**的 `.app + .dmg`，再用 `pnpm check:macos-bundle` 断言
> identifier / 版本号 / `shuyonote` 深链 scheme / dmg 都在。它的价值是让"macOS 打包"在
> **每次 push** 就被验一次，而不是等到打 tag 才发现——见 [macos-updater.md](macos-updater.md) §六。

产物上传到 GitHub Release（`softprops` 未用，`release` job 用 curl+GitHub API 只挂安装包）。仓库 Secrets：`TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（必填），macOS 另需 `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`/`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`。

**⚠️ GitHub Release 里没有 `.sig`**：`release` job 显式只挑 `.exe/.dmg/.deb/.AppImage`。要发 GitCode（更新通道需要签名）就得从 **run artifacts** 取，两个 build job 上传的 `bundle-<platform>` 含完整 `bundle/` 目录（含 `.sig`，保留 7 天）：

**一条命令（推荐）**：

```bash
pnpm fetch:release-artifacts --tag v1.91.1 --stage
# 或指定 run：pnpm fetch:release-artifacts --run 34919151353 --stage
```

`scripts/fetch-release-artifacts.mjs` 做四件事：**分片并行**下载（GitHub 单连接实测 ~40KB/s，
8 片并行才现实）、**断点续传**（中断后重跑接着下，不重下已完成的分片）、按 API 给的
`digest` **校验整包 sha256**、零依赖解包（`scripts/lib/zip.mjs`）。取到 APK 后**立刻**跑
`check-apk-contents.mjs` 验字节（v1.91.0 闪退的产物级判据）。`--stage` 会把
nsis/deb/appimage 复制进 `src-tauri/target/release/bundle/`，随后 ⑥ 的 `--no-build` 直接可用。
最后它会打印出下一步该跑的那条 `release.mjs` 命令。

> 为什么不用下面那段手工脚本：2026-09-15 发 1.91.1 时手工做踩了三个坑（GitHub 单连接太慢、
> 分片被中断后重下、拼装用的 `.ps1` 因无 BOM 的 UTF-8 中文在 PowerShell 5.1 里解析失败）。
> 手工版留着当参考/兜底：

```bash
# 需要 GitHub token（artifacts 下载要鉴权，匿名 401）+ jq；RUN 取该 tag 对应的 run id
GH=<GitHub token>; RUN=<run id>
for id in $(curl -s -H "Authorization: Bearer $GH" \
  "https://api.github.com/repos/ShuyoNote/ShuyoNote/actions/runs/$RUN/artifacts" | jq -r '.artifacts[].id'); do
  curl -sL -H "Authorization: Bearer $GH" \
    "https://api.github.com/repos/ShuyoNote/ShuyoNote/actions/artifacts/$id/zip" -o "$id.zip"
  unzip -q -o "$id.zip" -d unpacked/          # 解出来的就是 bundle/ 的内容（nsis/ deb/ appimage/）
done
cp -r unpacked/* src-tauri/target/release/bundle/   # 直接并入，随后 ⑥ 的 --no-build 即可
```
`release.mjs` 按**版本号整词匹配**挑产物（`_1.84.6_` ✓，`_1.84.60_` / `11.84.6` ✗），所以 bundle 目录里留着旧版本产物不会污染发布；同平台出现同类候选（例如上次 run 的同版本残留）会**直接报错**而不是随便挑一个，可用 `--artifacts a.exe,b.deb` 显式指定。

**⚠️ 换行符**：Windows runner 默认 `core.autocrlf=true`，若仓库未固定 `eol=lf`，文本会被检出成 CRLF；对生成物做逐字节比对的门禁（如 `check-capabilities`）会在 Windows 上必失败，而它跑在 Tauri 的 `beforeBuildCommand` 里 → 整个 Windows 构建红掉（v1.84.6 首次发布即如此，Linux 正常）。仓库已加 `.gitattributes`（`* text=auto eol=lf`）钉死 LF，门禁也比较时忽略行尾——两层都在，别退回逐字节比较。

### ★ 库级国密：**单一口味**（2026-09-22 owner 拍板 → 落进 `release.yml`）

**决定**：以后所有平台发的包，库级一律是国密那一套 —— **页加密 SM4 ＋ 页 MAC/库 KDF SM3**。
不再有「这个平台 AES、那个平台 SM4」的混合状态（那会变成"同一个文件在 A 机器能开、B 机器打不开、
且报错一模一样"的最难查形态：SQLCipher 的文件里**不写**用的是哪套算法）。

**发布链要的四个开关**（`release.yml` 已就位；少任何一个都会产出「看起来是国密、其实不是」的包）：

| # | 开关 | 为什么 |
|---|---|---|
| 1 | `OPENSSL_DIR` **显式给**，并**用 `--print-env` 翻译成三个变量** | `src-tauri/build.rs` 在 `sm-library` 上是 **fail-fast**：不给就当场失败。<br>⚠️ **不能只给 `OPENSSL_DIR`**：`openssl-sys` 只看 `<OPENSSL_DIR>/lib` 与 `lib64`，而 Ubuntu 的开发文件在**多架构目录**（`/usr/lib/x86_64-linux-gnu/`）⇒ 编译期直接炸（CI 2026-09-22 实测逐字：`OpenSSL libdir at ["/usr/lib64", "/usr/lib"] does not contain the required files…`）。⇒ 走唯一实现：`node scripts/sm-library-build.mjs --openssl-dir "$OPENSSL_DIR" --print-env >> "$GITHUB_ENV"`（它给出 `OPENSSL_DIR` ＋ `OPENSSL_LIB_DIR` ＋ `OPENSSL_INCLUDE_DIR`，两个 crate 都认；判据在 `scripts/lib/sm-library-plan.test.mjs`） |
| 2 | `node scripts/sm-library-build.mjs --prepare` | 把补丁打到「将要编译的那份 SQLCipher 源码」＋ **清两个 crate、两个 profile 的产物**（它的 build.rs 没为 `OPENSSL_DIR` 声明 `rerun-if-env-changed`，不清**不会**换后端）<br>⚠️ **`--release` 那一条不能省**：只清 dev 时，`tauri build`（release）会把旧的 CommonCrypto SQLCipher **原样复用** ⇒ 包表面全对（补丁标记 `page_cipher=sm4` 也在）而**库级根本不是国密**。这是 2026-09-22 在本机把发版链原样跑一遍时**被第 4 条断言抓住**的真实事故；修法＝两个 profile 都清（`--prepare` 已这么做，判据在 `scripts/lib/sm-library-plan.test.mjs`） |
| 3 | `pnpm tauri build … --features sm-library` | 不带它 → 应用接线那段 `#[cfg]` 被编掉，而产物标记仍写 `page_cipher=sm4`（页加密是补丁的**编译期**行为）⇒ 包看起来是国密、库级页 MAC/KDF 却还是 SHA512 |
| 4 | 产物断言（`SHUYONOTE_EXPECT_*` 三条） | 后端＝openssl、补丁 applied、**`page_cipher=sm4`** —— 只有产物能回答这三格（`cipher_settings` 回显里没有 algorithm 字段） |

**各平台的加密库来源**（"口味"必须一致，**链接方式可以不同**）：

| 平台 | 来源 | 自包含？ |
|---|---|---|
| **Windows** | vcpkg `openssl:x64-windows-static-md` | ✅ 静态（`libcrypto.lib`）；`--require-static` 会核对 |
| **Linux** | 系统 OpenSSL 3（`OPENSSL_DIR=/usr`，runner 上 ≥3.0 自带 SM3/SM4） | ⚠️ **共享**：deb 的 shlibs 声明这个依赖；老发行版上要求 OpenSSL ≥3.0（这也是这一格的已知边界） |
| **macOS** | **没有系统 OpenSSL** ⇒ 必须自己编一份（`no-shared`）并自包含 | 发版档启用时按下面配方 |

> ★ **Tongsuo 不是必需的**：我们数据面只用到 SM3/SM4/PBKDF2-HMAC-SM3，**上游 OpenSSL ≥1.1.1 就有**
> （方案里早就更正过这一点）。Tongsuo 的独有价值是 GM/T 0024 那类国密 TLS —— 不在本项目范围（§5.4）。
> macOS 那份"自己编"用 stock OpenSSL 或 Tongsuo 都可以；本机验证时用的是 Tongsuo。

**macOS 发版档（等 Apple secrets 到位再启用）的配方**：

```bash
# ① 编一份**静态**的 SM 版 OpenSSL（no-shared ⇒ 只产出 libcrypto.a）
./Configure --prefix="$PREFIX" no-shared no-tests && make -j8 && make install_sw
# ② 只留静态库（`--require-static` 会拒绝共享版前缀：产物会依赖构建机那份）
rm -f "$PREFIX"/lib/libcrypto.*.dylib "$PREFIX"/lib/libcrypto.dylib
OPENSSL_DIR="$PREFIX" node scripts/sm-library-build.mjs --prepare --require-static
# ③ 打包（必须带特性）
OPENSSL_DIR="$PREFIX" pnpm tauri build --bundles app,dmg --features sm-library
# ④ 产物断言（同 release.yml）
SHUYONOTE_EXPECT_CRYPTO_BACKEND=openssl SHUYONOTE_EXPECT_SM_PATCH=applied \
SHUYONOTE_EXPECT_PAGE_CIPHER=sm4 node scripts/check-crypto-backend.mjs
# ⑤ **签名必须早于做 dmg**，且由内到外（见上面「签名/公证」那条与 scripts/sign-macos-app.mjs）
```

**本机实测（2026-09-22，macOS，按上面配方**原样**跑完 `app,dmg`）**：
· `--prepare` 清四个产物（两个 crate × 两个 profile）→ `tauri build --features sm-library` 重编；
· `otool -L` 里**没有**任何 `libcrypto/libssl`（真静态、自包含）；
· 产物标记 `patch=72df3f9a · page_cipher=sm4 · src_sha256=741d999b7933…`；三条断言全过；
· strip 后的 release 二进制里 `strings` 仍能看到 **`HMAC-SM3` / `SM4-CBC`** ⇒ 国密 provider 确实编进去了；
· `node scripts/check-macos-bundle.mjs` ✅（未签名状态，签名按上面那条由内到外做）。

**老库怎么办（快路后果）**：国密构建**读不开** AES＋SHA512 写的老库。迁移＝在旧版里关掉该空间的
「磁盘加密」（会重写成明文 SQLite）→ 换新版 → 重新打开加密。还没有真实用户，所以现在是零迁移成本。

### ⚠️ `shuyonote://` 协议注册依赖 Windows 档保持 `nsis`

Windows 上「点社区链接 → 唤起应用」靠注册表 `HKCU\Software\Classes\shuyonote`。**这份注册与它的卸载清理都不是我们手写的**，而是：

| 环节 | 谁做的 |
|---|---|
| scheme 声明 | `tauri.conf.json > plugins > deep-link > desktop > schemes` |
| 声明 → bundler 的映射 | `tauri-cli`（`interface/rust.rs` 读 `plugins.deep-link` 填 `deep_link_protocols`） |
| 装时写注册表、卸时删 | `tauri-bundler` 的 NSIS 模板 `installer.nsi`（安装段 + 卸载段） |

所以：

- **Windows 的 `--bundles` 必须保持 `nsis`**。换成 msi 就得在 WiX 侧另配一份等价的注册与清理，否则表现为「装完点链接没反应」，而且卸载后会留下一条指向已删 exe 的键；
- 注册只写 **HKCU**（默认安装模式 `currentUser` ⇒ NSIS 的 `SHCTX` 就是 HKCU）⇒ **免 UAC、不碰 HKCR/HKLM**；
- 卸载**不是无脑删**：模板先读回 `shell\open\command`，确认它确实指向本次安装的 exe 才 `DeleteRegKey`（避免删掉别的安装/别的用户的注册）。代价是：如果那个键被改到别的路径，卸载会**有意留下**它——这是保守方向，别"顺手改成无条件删除"。

**门禁**：`node scripts/check-deep-link.mjs`（已进 `pnpm build` 与 release.yml 的构建前一步）查四件事，每件漏了都只表现为**静默失效**：scheme 声明、`single-instance` 的 `deep-link` feature、插件注册 + 接线 + 命令进 handler、事件名前后端一致。

**真机三步验证**（2026-09-11，Windows x64，v1.89.1）已做完：注册表（装后存在、卸后干净）、
浏览器式唤起（`ShellExecute` 拉起恰好一个进程）、已有实例转发（仍是同一 PID）。
原始输出留在**私有工程信箱**里（不放公开仓库）。

### 安装目录：默认 `%LOCALAPPDATA%\Programs\ShuyoNote`（fork 了一份 NSIS 模板）

**Tauri 没有"自定义默认安装目录"的配置项** —— `bundle.windows.nsis` 里只有 `installMode`
（`currentUser` / `perMachine` / `both`），默认目录写死在模板里（上游 feature request：
tauri-apps/tauri#11015）。所以只有两条路：接受 Tauri 的默认，或者 **fork 模板**。我们选了后者。

| 项 | 值 |
|---|---|
| fork 的文件 | `src-tauri/nsis/installer.nsi`（`bundle.windows.nsis.template` 指向它；相对 `src-tauri/`） |
| 上游 | `tauri-bundler <ver>` 的 `src/bundle/windows/nsis/installer.nsi`（文件头记着 sha256 与 cli-version） |
| 改了几行 | **1 行**：`StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"` → `…\Programs\${PRODUCTNAME}` |
| 结果 | 全新安装默认 `%LOCALAPPDATA%\Programs\ShuyoNote`（VS Code 那种写法）；**仍是 currentUser ⇒ 免 UAC、更新静默** |
| 老用户 | **不受影响**：模板的 `RestorePreviousInstallLocation` 会读 `HKCU\Software\shuyo\ShuyoNote` 的默认值（上次装在哪儿）并覆盖默认值 |

**⚠️ 为什么不用 `perMachine`（它才是 `Program Files`）**：`perMachine` 的注册表根是 **HKLM**
（`SetShellVarContext all`），而老用户的"上次装在哪"与卸载项都在 **HKCU** ⇒ 新安装器**看不见**旧的
per-user 安装，会把新版装到 `C:\Program Files\ShuyoNote`、把旧的 AppData 那份留在原地（两个同名卸载项、
快捷方式仍指向旧版）；而 Tauri 更新完是拿 `current_exe()` 重启的 ⇒ **又回到旧路径那个 exe**，
旧版继续跑、继续提示更新。另外 `perMachine` 是 `RequestExecutionLevel admin`：**安装**与**每次自动更新**
都会弹 UAC。owner 2026-09-21 的裁定因此是「保持 currentUser，只改默认目录」。

**⚠️ 升级 Tauri CLI 时必须重做这个 fork**：下载新版本 tauri-bundler 的上游 `installer.nsi`，重放那 1 行改动，
更新头部的 `upstream-crate` / `upstream-sha256` / `cli-version`。不做的后果**不是编译错误**，而是打出来的包
与 CLI 传入的占位符对不上（装不上，或又装回旧位置）。

**门禁**：`node scripts/check-nsis-template.mjs`（已进 `pnpm build`）。离线查三条 —— template 指向的文件存在、
那一行改动恰好 1 处且旧写法不残留、头部 `cli-version` 与 package.json 一致；**联网时**把上游模板下下来
逐行 diff，差异多于那一行就红；取不到就打印 `· 跳过（网络原因）`、**不算失败**（与 `check:release-state` 同口径）。

**真机验证（可重跑）**：`powershell -File scripts/verify-installer-default-dir.ps1 -Installer <setup.exe>`
—— 只走到「选择安装位置」页，读那个输入框里的**预填值**（跨进程 `WM_GETTEXT`，`GetWindowText` 读别的进程
的 EDIT 会得到空串），然后**取消**（绝不点安装）。它回答的正是 owner 那次截图的问题：**这个路径是产品默认，
还是本机记着的旧路径？**

> ⚠️ 本机看到 `C:\Users\<用户>\_archive\…` 这类路径**不代表产品默认错了**：那是模板按
> `HKCU\Software\shuyo\ShuyoNote` 记住的上一次安装位置（2026-09-21 owner 截图那次就是它）。
> 要复现"全新机器"的默认值：先删掉那个键的**默认项**（语言项留着无妨），再跑上面的探针。
> 探针按 PID 找向导窗口 —— `perMachine` 那种要过 UAC 的包，向导属于提权后的**新**进程，探针找不到，
> 会明确报 `ENV:` 而**不会静默通过**。

### 本机（Windows 签名构建）
```powershell
# ① OpenSSL：两条都要（缺第一条当场 panic，缺第二条链接期报 LNK1181）
$env:OPENSSL_DIR = "C:\Program Files\OpenSSL-Win64"
$env:LIB = "C:\Program Files\OpenSSL-Win64\lib\VC\x64\MD;$env:LIB"
# ② 更新器签名密钥（产出 .sig）
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw "$HOME\.tauri\shuyonote.key").Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw "$HOME\.tauri\shuyonote.key.pw").Trim()
# ③ PDFium 运行时：装包要把 pdfium.dll 放在 exe 同级（源文件不进 git；缺席则**构建脚本期**即失败）
node scripts/fetch-pdfium.mjs --check --platform win-x64   # 报「缺少」就跑一次：node scripts/fetch-pdfium.mjs --platform win-x64
pnpm tauri build --bundles nsis   # 产出 bundle/nsis/ShuyoNote_<版本>_x64-setup.exe + 同名 .sig
# ④（只在需要 MuPDF 回滚包时）默认构建**不编** MuPDF：`mupdf-rollback` 是构建期特性，
#    平时不背它（它是重量级 C 依赖）。要出一个能 `SHUYONOTE_PDF_ENGINE=mupdf` 的包就加：
#    pnpm tauri build --bundles nsis --features mupdf-rollback     # 体积/构建时间的代价随之回来
```

> **2026-09-16 本机实测（8 分钟出包，产物过了 `release.mjs` 的签名互验）**——两条 OpenSSL 的坑
> 都不是"看一眼就知道"的，写在这里省下下次的排查时间：
>
> | 现象 | 真因 | 修法 |
> |---|---|---|
> | `libsqlite3-sys` build.rs 直接 panic：`Missing environment variable OPENSSL_DIR` | 它的 build.rs **不猜默认安装路径**，只读环境变量 | 显式设 `OPENSSL_DIR` |
> | 链接期 `LINK : fatal error LNK1181: 无法打开输入文件"libcrypto.lib"` | Shining Light 的 OpenSSL-Win64 把库放在 `<dir>\lib\VC\x64\MD\`，而 `<dir>\lib\` 下**只有 VC 目录** | 把该目录加进 `LIB`（如上），或改用 CI 那种 vcpkg 的 `openssl:x64-windows-static-md` |
>
> **`where link.exe` 找不到不算问题**：rustc 自己会按注册表找到 VS 的 MSVC 工具链（本机就是这样链接成功的）。
> 真正要确认的是"**装了 VS Build Tools 的 C++ 工作负载**"——这一条由 `pnpm check:win-build-env` 判。

> **换一台（新的）Windows 机器之前先跑 `pnpm check:win-build-env`**（2026-09-16 加）。
> 它逐条问硬前置，并写明**缺了会怎样**——这几条都不会给出清楚的报错：
>
> | 前置 | 缺了的表现 |
> |---|---|
> | Node ≥ 20 / pnpm | 各种解析错（`corepack enable` 可补 pnpm） |
> | `rustc` + 目标 `x86_64-pc-windows-msvc` | 出不了桌面包（Windows 要用 MSVC 目标） |
> | VS 2022 Build Tools 的 C++ 工作负载 | 报 `link.exe not found`（**不在 PATH 上不算问题**，见上表） |
> | **`OPENSSL_DIR` + 库路径**（本机用 OpenSSL-Win64，CI 用 vcpkg） | 先 panic，再 `LNK1181`（见上表） |
> | **`vendor/pdfium/win-x64/bin/pdfium.dll`**（PDFium 运行时，2026-09-18 加） | `cargo build` / `pnpm tauri build` **当场停下**：`tauri-build` 的 `copy_resources` 报「resource path … doesn't exist」（`tauri-utils::Error::ResourcePathNotFound`，出在构建脚本期）。缺了它的后果：装包里没有 `pdfium.dll` ⇒ 用户端只有 `SHUYONOTE_PDF_ENGINE=pdfium` 时报「找不到 PDFium 动态库」（默认引擎仍是 MuPDF，暂不致命；P5 换默认后就致命）。源文件不进 git，`node scripts/fetch-pdfium.mjs --platform win-x64` 现拉 |
> | **`~/.tauri/shuyonote.key` + `.pw`** | 构建能过但**产不出 `.sig`** ⇒ 更新清单里该平台没 `signature`
>   ⇒ 用户端**整份**清单解析失败（桌面的更新一起挂）。密钥**带外**从既有机器拷，绝不入库 |
>
> 可选：`~/.minisign/shuyonote.key`（发布者私钥）——没有则发版时**明确跳过**第一方插件片段。
> Android 发版件**不要在这台机器上建**：一律从 CI 取（见 §9 开头）。
> ⚠️ 另外：**本机构建不出的平台不要硬发**——`release.mjs` 的覆盖检查会（正确地）拒绝
> "只有 Windows 的清单"，因为它会把线上已有的 `linux-x86_64` / `android-aarch64` 砍掉。

## ⑥ 发布到 GitCode（更新通道）
```bash
GITCODE_TOKEN=… RELEASE_NOTES="一句话更新说明（应用内「检查更新」显示）" \
  node scripts/release.mjs --no-build --android-apk <APK 路径> --body /tmp/body.md   # 需先备好 ⑤ 的产物
```
它建 GitCode release、上传 installer/`.sig`/APK/`latest.json`、并更新 `latest` 通道（应用内「检查更新」读的就是它）。注意 `latest.json` 的 `url` 指向 gitcode release，签名用同一签名密钥产出的 `.sig`，须与文件字节一致。
`--no-build` 前提是安装包已就绪（如 GitHub Actions 产物）；缺省会先 `pnpm tauri build`。

**`--android-apk` 是必需的（Android 发版件）**：本机 Windows 出不了 Android 包（§9 开头），所以 apk 一律从
CI 取——run artifacts 的 `android-release-apk`，或 GitHub Release 上的
`ShuyoNote_<版本>_android-arm64-release.apk`（下载方式见 ⑤）。**缺了就硬失败**：清单里少了
`android-aarch64` 时 Android 用户的更新入口会静默消失。要明确跳过只能加 `--no-android`（与
`--allow-platform-drop` 同一套哲学：逃生口必须显式）。

**apk 没有 `.sig`（这是有意的例外）**：它的签名是 `apksigner` 打在**包内**的，不是旁边的 minisign 文件。
所以 apk ①不参与「`.sig` 与字节互验」②不上传 `.sig`，清单里 `platforms["android-aarch64"].signature`
写 **`sha256:<hex>`**（发布脚本现算）。安装时的强制签名校验由 Android 系统安装器负责。
⚠️ **这个字段不能省**：`tauri-plugin-updater` 把每个平台条目解析成 `url` + `signature` **都必需**的结构，
任何一条缺 `signature` 会让**整份 latest.json** 解析失败 ⇒ **桌面的自动更新一起挂**（症状是"点检查更新
什么都不发生"）。写盘前由 `validateManifest` 硬拦（见下表）。

建议用 `--body` 传发布说明（从 `CHANGELOG.md` 对应版本段生成，`###` 降一级即可）；不传则只有一行 `ShuyoNote vX.Y.Z`，与 CHANGELOG 脱节。

### 发布前的自动拦截（都在 `scripts/release.mjs`，发布前跑 `--dry-run` 可先看一眼）

更新通道的故障几乎都是「发布时毫无征兆、用户点检查更新才炸」，所以下面的检查都是**硬失败**（列出全部问题后中止，不做任何发布）：

| 检查 | 拦住的真实事故 |
| --- | --- |
| 版本号整词匹配 | `1.84.6` 误纳 `1.84.60` 的产物 |
| 同平台同类候选 → 报错 | 上次 run 的同版本残留，被随便挑一个发出去 |
| 缺/空 `.sig` → 报错（**apk 例外**：签名在包内） | 旧实现只 warn 然后静默丢弃该产物，而 `latest.json` 留一个空签名条目 → 该平台更新静默失效 |
| **`.sig` 与安装包字节互验**（minisign 预哈希：BLAKE2b-512 + ed25519，见 `scripts/lib/`） | 安装包与 `.sig` 不是同一次构建的一对（手工从两次 run 各取一个）→ 用户更新时报校验失败 |
| **缺 Android 发版件 → 报错** | 忘了 `--android-apk` ⇒ 清单里没有 `android-aarch64` ⇒ Android 更新入口静默消失 |
| **写盘前 `validateManifest`**（每个平台条目都要有绝对 https 的 `url` 与非空 `signature`；android 必须是 `sha256:<64 hex>`） | 某个平台条目缺 `signature` ⇒ **整份 latest.json 解析失败** ⇒ 连桌面的更新通道一起挂 |
| 线上 `latest.json` 平台键覆盖检查 | 本次只构建了 Linux，就悄悄砍掉 `windows-x86_64`（或 `android-aarch64`）→ 该平台用户从此收不到更新 |
| 打印每个产物的 sha256 | 事后可与 CI 产物逐个比对（同时写 `src-tauri/target/release/release-artifacts.json`） |

逃生口（都需显式写出，且有明确风险提示）：`--artifacts` 指定产物、`--allow-platform-drop` 允许少平台、`--no-android` 本轮不带 Android、`--skip-sig-verify` 跳过签名校验。
`latest.json` 同一平台键只能留一个 url，取哪个由 `MANIFEST_PREFERENCE` **写死**（Windows 取 exe、Linux 取 deb、**macOS 取 `.app.tar.gz`**、Android 取 apk），不再依赖目录遍历顺序；另一个（如 AppImage、macOS 的 dmg）照样挂到 release 上。
> macOS 取 `.app.tar.gz` 而非 dmg 是硬要求：更新器在 macOS 上只 `GzDecoder` + tar 解包 `.app.tar.gz`，
> 指向 dmg 会"能下载、装不上"。证据与门禁（含"有 dmg 却没有 `.app.tar.gz` 就硬失败"）见
> [macos-updater.md](macos-updater.md) 开头与 `scripts/lib/releaseArtifacts.mjs` 的 `isUpdaterArchive`。

> 覆盖检查可以用 `SHUYONOTE_PREV_MANIFEST_JSON=<文件>` 注入一份"线上清单"来验（**只为测试这条门禁**，
> 正常发布别设）。为什么需要它：Android 通道上线前线上清单里**根本没有** `android-aarch64`，
> 于是没有任何真实输入能证明"线上有、本次没有 → 会红"这条检查真的会拦——不会被触发的门禁等于没有。

**发布后自检**（自动检查之外的兜底）：拉 `https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json`，确认 `version` 已是新版本，且各平台 `signature` 与该 release 上的同名 `.sig` **逐字符一致**。

上面这句现在有命令了 —— **`pnpm check:release-state`**（`scripts/check-release-state.mjs`）。
它一次核对五件事，全部是"能挡住真实事故"的：

| 检查 | 挡住的是 |
|---|---|
| 通道 `version` = `package.json` 版本 | "发了但通道没更新"（用户永远收不到） |
| 每个平台键的 `url` 是绝对 https、`signature` 非空；android 必须是 `sha256:<64 hex>` | 少一个字段 ⇒ `tauri-plugin-updater` 解析**整份清单**失败 ⇒ 桌面更新通道一起挂 |
| 每个产物 URL 真的可达（`-r 0-0` 取 1 字节，**不用 HEAD**：gitcode 对 HEAD 一律 401） | 通道指向 404 的包 |
| **通道里 android 的 `sha256` = GitHub Release 上那份 `.apk.sha256`** | "通道指向的字节根本不是我们记录过指纹的那个"（发错件/传串了） |
| 两个 Web 入口的 `version.json` = 当前版本 | "主站静默停在旧版本"（历史事故：主站 1.84.5、Pages 1.89.0） |

> 网络失败与"真的不符"**分开报**：取不到 `.sha256` 时打印 `· 跳过（网络原因）`，
> 只有真的读到指纹且不一致才红 —— 否则 GitHub 抽风会被误当成"发错包了"。
> 它**不进 `pnpm build`**（要对线上发请求，不适合构建期跑），是发版当天的手工命令。

## ⑦ Web 版（**必做**，两个入口都要）

> 为什么从"可选"改成"必做"：它从 v1.84.5 起就没人跟了——本次（v1.89.0）自检发现
> **国内主站还停在 1.84.5**，而 GitHub Pages 已经 1.89.0。没有任何东西会提醒这件事，
> 于是"线上 Web 版"和"仓库里的版本"可以静默差五个版本。现在有命令可以一眼看出来：
> `pnpm check:web-deploy`（比对两个入口的 `version.json` 与 `package.json`，并把线上
> `index.html` 引用的每个资源都取一遍）。

**第一方插件 → 索引片段（可选，配了发布者私钥就自动做）**：`release.mjs` 会在发版时调用
`scripts/plugin-fragment.mjs`，把 `examples/plugins/` 里的插件逐个**过作者 CLI → 打包 → 算 sha256/size →
签发布者签名**，产出 `plugin-index.fragment.json` 并随 release 上传（包名带版本号：资源不可覆盖重传）。
社区侧只做"合并片段 + 签索引 + 托管"——**不写条目、不碰包字节、也不持有我们的发布者私钥**。

```bash
SHUYONOTE_PUBLISHER_KEY=~/.minisign/shuyonote.key \   # 私钥**路径**（内容不进仓库、不进普通 CI 变量）
SHUYONOTE_PUBLISHER_PUB=~/.minisign/shuyonote.pub  \  # 公钥（省略则按 .key → .pub 推）
SHUYONOTE_MINISIGN=$(which minisign)               \  # 默认找 PATH 里的 minisign
  pnpm release ...                                     # 或 node scripts/release.mjs ...
```

**发版之后还有一步**：把产出的 `plugin-index.fragment.json` 交给**索引托管方**（当前是数友社区，
见 [plugin-hosting.md](plugin-hosting.md)）。托管方合并片段 → 用自己的密钥签索引 → 托管；
**上传顺序是先传包、后传索引**（顺序反了会出现"索引指向还不存在的包"，用户端表现为装不上）。
交出去之前两边各跑一遍验收：托管方跑 `pnpm check:plugin-hosting --url <索引地址>`（线上那一份），
我们这边跑 `external_index` / `external_package`（文件那一份，CI 里已经在跑）。

没配私钥 → **明确跳过并说清后果**（这一版的第一方插件不进社区索引），不做静默跳过；
要显式跳过就加 `--no-plugins`。产出之后请用应用真正的解析器验一遍（命令在 release 日志里打印）。

**Web 整包会随发布一起上传**：`pnpm build:web` 之后跑 `release.mjs` 时，它会校验
`dist-web/version.json` 与本次版本一致，再打成 `ShuyoNote_<版本>_web.zip` 作为 release 附件
（内含 `SELF-HOST.txt`：别漏掉运行时才加载的 `sql-wasm`/`pdf.worker`、`.wasm` 要以
`application/wasm` 提供）。**它不进 `latest.json`**——那套更新通道只认真实安装包；
`--no-web` 可以跳过。所以"自己托管一份 Web 版"不再需要会构建：
下载整包、解压到静态服务器即可。

**两个入口，两种部署方式：**

| 入口 | 怎么上线 | 谁负责 |
|---|---|---|
| GitHub Pages `https://shuyonote.github.io/ShuyoNote/` | **自动，但只在 `main`**：推 main → `.github/workflows/pages.yml` | CI（无需手工） |
| 国内主站 `https://shuyo.cn/app/` | **手动上传**（下面三步） | 发布者 |

> [!] **Pages 的环境分支策略：未合并进 `main` 就刷不了（v1.90.2 发版时实测，别当脚本 bug 查）**
> `github-pages` 这个**环境**配了 `branch_policy`，**只允许 `main`**。所以只要在功能分支上发版
> （本仓库常态：`feat/*` 领先 `main` 几十个提交），**"发 Web 版"这一步只能覆盖国内主站
> `shuyo.cn/app/`，Pages 会静默停在旧版本**——`check:web-deploy` 会如实报"Pages 版本 ≠ 当前版本"，
> 但很容易被当成"部署脚本坏了"。
>
> **判据（两条，都不用猜）**：
> ```bash
> # ① 环境策略里允许的分支：v1.90.2 时输出 total_count=1、唯一 name="main"
> curl -s -H "Authorization: Bearer $GH" \
>   https://api.github.com/repos/ShuyoNote/ShuyoNote/environments/github-pages/deployment-branch-policies
> # ② 从别的 ref 手动 dispatch（ref: feat/...）时，run 的 build job 会全绿，
> #    但 deploy job 秒级失败且 **steps 为空数组、runner_id=0**（没起 runner，被策略拒绝）
> curl -s -X POST -H "Authorization: Bearer $GH" \
>   https://api.github.com/repos/ShuyoNote/ShuyoNote/actions/workflows/pages.yml/dispatches \
>   -d '{"ref":"feat/xxx"}'
> ```
> ⚠️ 注意 ② 的迷惑性：**build 全绿 + deploy 一秒失败**，看起来像"部署脚本 bug"，
> 实际是 `environment: github-pages` 的 OIDC 交换被分支策略挡了（deploy 的日志 API 还会返回
> `BlobNotFound`，连日志都没有）。判据就是"**deploy 0 步 / runner_id=0**"。
>
> **放开该策略（例如把 `feat/*` 加进允许列表）需要发布者明确授权**——它是**安全面变化**
> （非 `main` 分支从此也能改线上 Pages），**不要顺手改**。三条出路的取舍见 §⑦ 末的说明。

```bash
# 1) 构建（version.json 会写成当前版本）+ 用真实 Chromium 验一遍产物
pnpm build:web
pnpm check:web-build        # 能打开、DB 能初始化、版本号对、动态资源取得到

# 2) 上传到 /var/www/shuyo-site/app/（scp）+ chmod -R 644/755
#   正确：scp -r dist-web/. root@host:/var/www/shuyo-site/app/   ← 注意 dist-web/.（斜杠点）
#   或：  scp dist-web/* dist-web/.[!.]* root@host:/var/www/shuyo-site/app/
#   错误：scp -r dist-web root@host:/var/www/shuyo-site/app/     ← 会传成 app/dist-web/，⚠️见下

# 3) 部署后自检（两个入口一起验，版本 + 资源可达）
pnpm check:web-deploy

# 4) 还想更踏实一步：用真实 Chromium 打开**线上**那一份，确认它真的能用
node scripts/check-web-build.mjs --url https://shuyo.cn/app/
node scripts/check-web-build.mjs --url https://shuyonote.github.io/ShuyoNote/
```

> [!] **子路径的坑（v1.89.0 部署时踩到）**：主站挂在 `/app/` 下，而页面里的 `/assets/…` 会被
> 解析到**域名根**。检查脚本第一次就是按根路径去取的，于是"线上资源 404"——其实是检查脚本
> 自己找错了地方。凡是自己拼资源 URL 的地方，都要用 `new URL(…, APP_URL)` 而不是绝对路径。

> [!] **部署路径坑（v1.84.4 实际踩到）**：`scp -r dist-web host:/app/` 会把 **`dist-web` 整个目录**传成 `app/dist-web/`，而**不是**把内容铺进 `app/`。结果 `app/index.html` 是新的（引用新 hash 资源），但 `app/assets/` 仍是旧资源 → 启动报「失败的资源: …/assets/index-*.js 404」。**必须用 `dist-web/.`（斜杠点）**把内容铺平，或先传再 `cp -rf app/dist-web/. app/ && rm -rf app/dist-web`。**部署后务必验证**：`curl -s https://shuyo.cn/app/index.html | grep -oE 'assets/[^\"]+\.(js|css)'` 逐个 `curl` 应全 200。

> [!] **清理旧 assets 必须保留「动态加载」资源（踩坑，v1.84.1）**：官网手动部署时若删旧产物，**不能只按 `index.html`/`sw.js` 的静态资源引用过滤**——sql.js 的 wasm（`new URL('sql-wasm-….wasm', import.meta.url)` 在 `vendor-*.js` 里运行时加载）和 pdf worker（`pdf.worker.min-….mjs`）等**不在静态引用里**，误删会导致 `Error: SqliteStore not initialized`（sql-wasm fetch 404 → `SqliteStore.init()` 抛错 → catch 返回未初始化 store → 所有 DB 查询报错）。
> **正确做法**：按**本地 `dist-web` 全量清单**同步（`find . -type f` 生成本地清单，服务器按清单删多余文件），既铺平目录又保留全部动态资源。**GitHub Pages 走 CI 全新构建不受影响**；只有手动 scp 的官方站需小心。

> [!] **清单文件必须是 LF —— 否则 `comm` 会把线上**整个目录**判成"多余"全删掉（2026-09-21 v1.91.19 实际踩到，网站空了约 3 分钟）**：
> PowerShell 5.1 的 `Set-Content -Encoding ascii`（以及 `Out-File`）写的是 **CRLF**，每行尾多一个 `\r`，
> 而服务器 `find | sort` 出来的是 LF ⇒ 两边**没有一行相等** ⇒ `comm -23` 把**全部**文件判成"服务器多余"。
> 现场读数：`本地清单 311 个文件 / 服务器原有 416 个 / 服务器多余（将删）416 个 ⇒ 同步后 0 个文件`。
> **修法**（写 LF，别用 `Set-Content`）：
> ```powershell
> $root = (Resolve-Path dist-web).Path
> $lines = Get-ChildItem dist-web -Recurse -File |
>   ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\','/') }
> [System.IO.File]::WriteAllText("$env:TEMP\web-manifest.txt", ($lines -join "`n") + "`n",
>   (New-Object System.Text.UTF8Encoding($false)))
> ```
> 另外：**先备份再动**（`tar czf /root/shuyo-site-app-backup-<ts>.tgz -C /var/www/shuyo-site app`）——
> 这次能 3 分钟内恢复就是因为备份和本地 `dist-web` 都在。**删之前先 `wc -l` 看一眼"将删多少个"**：
> 它是"全部"的时候，几乎一定是清单本身错了，不是线上多了一堆垃圾。

> [!] **为什么"看版本号"不够**：`check:web-deploy` 会把线上 `index.html` 引用的**每个资源**
> 都取一遍。版本号对、资源对不上，正是 v1.84.4 那种"页面能开、功能全废"的坏法。

**未合并进 `main` 时，这一节的"两个入口"实际只能完成一个。** `github-pages` 环境的分支策略
只允许 `main`（见上面的 [!]），所以此时三条出路是：

1. **只发国内主站**（v1.90.2 的实际选择）：主站是用户的**主入口**，刷成新版本即可；
   Pages 作为**备用**入口停在旧版本可以接受，等将来把功能分支合并进 `main` 时**自然对齐**
   （`pages.yml` 在 push `main` 时自动跑）。**这也是本仓库当前的常态选择。**
2. **推 `main`**：唯一不违反现有策略的部署方式，但它等于**合并功能分支**
   （v1.90.2 时 `feat/android-mobile` 领先 `main` **77 个提交**）——那是**产品决策**，发布者不做。
3. **放开环境分支策略**：能让 Pages 从任意 ref 部署，但**扩大安全面**（非 `main` 分支即可改
   线上 Pages）⇒ **需要发布者明确授权，不为"刷新一个备用站"顺手改**。

收尾时别忘了一句口径：**Pages 上那一份是从它被部署时的 ref 构建的**。若走第 2 条，Pages = `main`
的构建；若走第 3 条，Pages 可能**与 `main` 不一致**——报告里要写明，不要让读者以为两者同源。

> **状态更新（2026-09-14）**：上面那个前提**已经不成立**了——`feat/android-mobile` 已经合进 `main`
> （`31514c4`，见 [development.md](development.md) §10.4），`main` 与 `dev` 对齐，Pages 随之恢复正常：
> push `main` 即自动对齐两个入口，**不必再在这三条出路里做取舍**。本节原样保留，因为将来若又要在
> "未合并进 `main`"的状态下发版（长线开发期），这三条出路仍然是唯一的选择集，而第 1 条那种
> "只发国内主站、Pages 停旧版"的做法**必须写明**，不能让读者以为两个入口同源。

## ⑧ 检查 CHANGELOG 连续
```bash
Select-String -Path CHANGELOG.md -Pattern '^## \[' | Select-Object -First 12
```
应看到 `X.Y.Z → X.Y.Z-1 → …` 连续，无断档。

**机器检查**（已接进 `pnpm build`）：
```bash
pnpm check:changelog
```
它钉的是**骨架**：`[Unreleased]` **存在/唯一/在首位**（**内容允许非空**——非空时其 `###` 与版本段
同一个口径；段头不带日期）、版本段头必须是 `## [X.Y.Z] - YYYY-MM-DD`
（真实日历日）、版本号从新到旧严格递减且**无重复段头**（`## [1.66.0]` 曾经出现过两段）、
代码围栏成对、无 ≥3 行连续空行、无空的 `- ` 占位条目、标题前有空行，以及**新版本**
（基线 1.90.2 之后，**外加 `[Unreleased]`**）的小标题唯一且取自允许集合。
它**不管**文风、措辞、条目详略，也不管日期与版本号先后是否合理——那些要人判断。

> ⚠️ 这条门禁**改过一次口径**（别再照抄旧说法）：首版要求"`[Unreleased]` 必须为空"，那是对
> Keep a Changelog 的误读——`[Unreleased]` 的用途**就是攒尚未发布的改动**，要求它为空等于
> "做了改动却没处记账"（1.90.2 之后的移动端适配因此记不进去）。现在**只放开"有没有内容"**，
> 结构检查一条没少：非空时 `###` 走允许集合、段内照样查空行/围栏/空 `- ` 条目。
> 改口径时用**样本外挂在 `%TEMP%`** 的方式验过（正反 9 例：空 / 非空合规 / 非空不合规 /
> 缺段 / 不在首位，外加段内空行、空 `- ` 条目、重复小标题、连续空行四个结构回归），
> 走的就是本脚本自己的 `[目标文件]` 参数——样本**不入库**。

## ⑨ Android 发版与验证（runbook，2026-09-13/14 落地）

> 这一节回答两件事：**这次发的 Android 包对不对**，以及**怎么不踩坑地验一遍发版流程**。
> 事实来源：`.github/workflows/android.yml`、`.github/workflows/release.yml`、`CHANGELOG.md`
> 的 `[Unreleased]`、[MOBILE.md](MOBILE.md) §2.2.1 / §2.3 / §2.4.2、[SHUYONOTE_STATE.md](SHUYONOTE_STATE.md) §5。
> 本机（Windows）**构建不出** Android 包（卡在 OpenSSL 源码构建与 mupdf 的 Makefile 假设上，见
> `android.yml` 文件头第 1 条）⇒ 本机能做的只有**复核指纹**与**真机验收**，出包一律在 CI。

### 9.1 两条流水线：自检包 ≠ 发版件（最容易搞混的地方）

| | `.github/workflows/android.yml` | `.github/workflows/release.yml` 的 `android` job |
|---|---|---|
| 定位 | **自检包**（"能不能装、装上能不能用"） | **可发布件** |
| 触发 | 手动 `workflow_dispatch`；或 push 到 `dev` / `main` 且改动命中 `paths:` | **只有 push `v*` tag**（或手动 `workflow_dispatch`） |
| `VITE_TEST_HOOKS` | **job 级设 `"1"`**（必须 job 级：`tauri.conf.json` 的 `beforeBuildCommand` 让 `tauri android build` 会**再跑一遍** `pnpm build`，只挂某一步等于没挂） | **任何层级都不设**，并在构建步骤里对空值做显式断言（`❌ 发版包不允许带测试钩子`） |
| 产物 artifact | `android-apk-aarch64-signed-test-hooks`（可直接 `adb install`，**只能自检**）、`android-apk-aarch64-unsigned`（量体积用），均保留 14 天 | `android-release-apk`（保留 14 天），含 `ShuyoNote_<package.json 版本>_android-arm64-release.apk` **与其 `.sha256`**（后者是更新清单里那个 `signature` 的凭据，`release` job 会断言它在） |
| 与 Release 的关系 | 不挂 tag、不建 Release | `release` job `needs: [build, android]` ⇒ **Android 失败会阻断整个 Release**（有意的：宁可响亮失败，不发"缺平台却看起来正常"的半套） |
| 只出 APK | — | **只出 APK，不出 AAB**（AAB 是 Play 上架件，且 `apksigner` **签不了 AAB**） |

`android.yml` 会在这些路径改动时触发（按"构建输入"补齐的，2026-09-13 之前只有 workflow 文件自身与
`tauri.conf.json` 两条，于是**改了 Rust 源码推上去连一条 run 记录都没有**）：

```text
.github/workflows/android.yml
src-tauri/tauri.conf.json          # Android 工程是从它生成的（应用名/包名/minSdk/深链 intent-filter）
src-tauri/Cargo.toml  src-tauri/Cargo.lock  src-tauri/src/**
src-tauri/capabilities/**          # 权限清单进包，check-capabilities 也读它
src-tauri/icons/**                 # 图标进包
src/**  index.html  vite.config.ts  package.json  pnpm-lock.yaml
scripts/**                         # pnpm build 里串着门禁脚本，改它照样可能让这一步红
```

> 代价：这些分支上的前端提交也会跑一次（约 15 分钟的 Android 构建）。**判据是"推完去 Actions 看
> 有没有新记录"，不是"我记得它配了"**——这条判据本身就是踩出来的。

两条流水线的签名步骤**逐字一致**：base64 落 `release.jks` → `zipalign -f -p 4` →
`apksigner sign`（口令只走 `env:`，不落文件、不进命令行）→ `apksigner verify --print-certs` →
实测指纹与硬编码常量比对 → 不一致 `exit 1`；Secrets 缺失也**显式报错**，不会退化成"发个未签名包出去"。

> [!] **⚠️ 2026-09-15 实证：这两条流水线曾经"步骤不一致"，代价是 v1.91.0 装上就闪退。**
>
> `android.yml` 比 `release.yml` 的 android job **多了两步**：
> `pnpm android:mobile-shell`（把 `ShuyoFsPlugin.kt` / inset 桥 / 返回键处理注入 `gen/`）与
> `pnpm android:mobile-shell --check`。`release.yml` 少了它们 ⇒ 发版 APK 里**没有那个类**，
> 启动时 `register_android_plugin` 抛 `ClassNotFoundException` → SIGABRT，
> **用户从 1.90.2 应用内更新到 1.91.0 之后直接打不开**（报"安装了，闪退"）。
> 自检包一直是好的 ⇒ 两条流水线的 CI 全绿 ⇒ 谁也没发现。
>
> 三条判据（事后补的，都是机器可跑的）：
> 1. **步骤清单对齐** —— 已经变成门禁：`pnpm check:release-parity`
>    （`scripts/check-release-parity.mjs`，串在 `pnpm build` 里）。
>    它把两个 android job 的 `- name:` 归一化后逐一比对，**任何只出现在一边的步骤都必须
>    落在脚本里那张显式允许表里并写明理由**，否则 push 时就红；表里写了但实际不存在的条目
>    也会红（防止豁免表腐化成"看着豁免过、其实早没了"）。
>    变异自证：把 `pnpm android:mobile-shell` 那两步从 `release.yml` 删掉 ⇒ **3 条红**，
>    逐条点名缺的步骤名（等于复现 v1.91.0）。
> 2. **产物级断言**（已进 `release.yml`，命令是 `scripts/check-apk-contents.mjs`）：
>    签名后翻 APK 字节，要求 dex 里有 `ShuyoFsPlugin` / `__SHUYONOTE_INSETS__` /
>    `__SHUYONOTE_BACK__` / `installApk`，并且 ABI 恰为 arm64-v8a、含 apksigner 签名块，
>    缺一个就 `exit 1`。源码级 `--check` 只能证明"写进了 gen/"，**证明不了"进包了 + R8 没删没改名"**。
>    本地同一命令：**`pnpm check:apk <apk 文件>`**（用来验 CI artifact 或**线上那一份**）。
>    它零依赖（自己读 ZIP 中央目录 + Node 的 zlib），Windows/Linux/CI 行为一致。
>    变异自证：拿 v1.91.0 那个坏发版件跑 ⇒ **4 项红**并逐条点名缺的能力；1.91.1 的好包 ⇒ 7 项全绿。
> 3. **发版前真机装一次发版件**（不是自检包）：这次就是"发版件从没被装上过"才漏的。
>    同日对照（同一判据）：发版件 dex 命中 **0**、自检包命中 **1**。
>
> 附带一条：**已发布的 Release 资产不覆盖**（"旧件冒充新件"是明令禁止的），
> 所以修法只能是发 1.91.1；而已经装坏的用户**打不开应用**，也就用不了应用内更新 ⇒
> 这一版必须让用户手动装一次（发布页/Release 附件）。

### 9.2 发版时的判据：怎么确认"这次发的包是对的"

**① CI 侧（三道硬断言，绿了才算）**

| 判据 | 在哪 | 具体是什么 |
|---|---|---|
| 签名指纹硬比对 | 两个 workflow 的签名步骤 | `apksigner verify --print-certs` 输出里的 `certificate SHA-256 digest` → 去冒号、转小写，与常量 `6ee89e6f0f9326a40d3eac48b520c470d3fb6a7111a94fbe606510b489457a88` 逐字符比对（文档里简写为 `6ee89e6f…` / `6E:E8:…:7A:88`）；不等则 `❌ 签名指纹对不上` 并失败 |
| ABI 断言 | `release.yml` 的「断言 APK 内 ABI 恰为 arm64-v8a」 | 直接读 zip 里 `lib/` 前缀：ABI 集合必须**恰好**是 `['arm64-v8a']`；出现别的 ABI、或压根没有 `lib/`（`.so` 没进包）都失败。理由：`--target aarch64` 只是**要求**，不是**证明** |
| `APK_N == 1` 与 `.sha256` 各 1 份 | `release.yml` 的 `release` job | 按 `ShuyoNote_*_android-arm64-release.apk`（及其 `.apk.sha256`）独立数一遍，**各必须恰好 1 个**。文件名由 `android` job 拼（版本取自 `package.json`），选择器是**另一处**字符串——两处对不上时"少个包"会伪装成成功 |
| `sha256:` 与 apk 字节一致 | `release.mjs` 写清单时现算 | 清单里 `platforms["android-aarch64"].signature` = 该 apk 的 sha256；`.sha256` 附件与 `release-artifacts.json` 里的指纹可事后逐个比对 |

**② 本机独立复核（不信 CI 一次输出）**

```powershell
# apksigner 在 Android SDK 的 build-tools 下，取最新一个（与 CI 的 `ls -d "$ANDROID_SDK_ROOT"/build-tools/* | sort -V | tail -1` 同义）
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"     # 与 MOBILE.md §2.5 的写法一致
$BT = (Get-ChildItem "$env:ANDROID_HOME\build-tools" -Directory | Sort-Object Name | Select-Object -Last 1).FullName
& "$BT\apksigner.bat" verify --print-certs .\ShuyoNote_<版本>_android-arm64-release.apk
# 看 "V3.0 Signer: … certificate SHA-256 digest"，应与 6ee89e6f… 一致（CI 日志里也有同一行）
```

**③ 真机（`adb install -r` + 启动 + 反向判据）**——手段与边界见 [MOBILE.md](MOBILE.md) §2.3：

- `adb install -r <apk>`：**同一签名**才能覆盖安装；**数据不丢**的判据是 `firstInstallTime` 不变；
- 启动无 panic：`adb logcat -d -v brief`（Rust 侧 `println!` / panic 都以 `I/RustStdoutStderr` 出现）；
- **反向判据（关键）**：给**发版包**发一条测试深链，应得到「**测试钩子未启用（这是正式构建）**」。
  这条正是"包里确实不带钩子"的证明，别只看"装上了、能开"。

```powershell
adb shell am start -a android.intent.action.VIEW -d "shuyonote://test/new-page?text=release-check"
```

> 为什么反向判据是必要的：测试钩子只在带 `VITE_TEST_HOOKS=1` 的构建里生效，没有它时分派层**直接拒绝**、
> 只提示"未启用"（有单测钉着）。所以"深链有反应"与"深链没反应"在这里的含义**正好相反**——
> 对发版包来说，**没执行才是对的**。

### 9.3 签名密钥与轮换（⚠️ 指纹常量有两份）

- keystore 保管在 **`~/.shuyonote-release-keystore/`**（含 `README-必读.md`；RSA-4096 / 10000 天，
  已有一份异地备份）；**测试专用 key 与它分开**，那个只用于真机自检包，**别混用**。
- Secrets 三个（两个 workflow 用的是**同一套**）：
  `ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS`。
  缺任何一个，签名步骤会**显式报错退出**。
- **⚠️ 指纹常量目前同时硬编码在两个 workflow 文件里**（`android.yml` 与 `release.yml` 各一份 `EXPECT=`）。
  **轮换密钥时必须两处都改**，否则先跑的那条流水线会红。
  仓库里目前**没有任何机制保证两处同步**（没有共享常量，也没有门禁脚本）——所以只能靠"记得两处都改"。
  指纹本身不是秘密，可以入库。

### 9.4 临时 dry-run 的约定（要验发版流程时照这个做）

1. **打法**：读 `package.json` 的 `version` → 打 `v<版本>-rcN`。已跑过的实例：`package.json = 1.90.1`
   时用 **`v1.90.1-rc1`**。
   注意 **`-rcN` 只出现在 tag 与 Release 名上**：APK 文件名里的版本取自 `package.json`
   （`ShuyoNote_1.90.1_android-arm64-release.apk`）⇒ **dry-run 不需要改仓库里的版本号**。
2. **只推 `github` 远端**：`git push github v1.90.1-rc1`。**不要推 gitcode**——gitcode 上有**另一套**
   同样在 `v*` tag 上触发的流水线（`.gitcode/workflows/build-linux.yml`，Linux 的
   `.deb` + `.AppImage`），推过去只会白跑一轮与本轮验证无关的构建。
   > ⚠️ **更正（2026-09-17）**：那条 GitCode 流水线**在 09-17 之前是坏的、且从未跑过**——
   > GitCode 自己的校验接口判它 `valid=false`（4 条：`runs-on` 取值不在允许列表、某个 step 没有
   > `name`、某个 step 名里有 `+`、`checkout-action@0.0.1` 这种简写不被认），而
   > `/actions/artifacts` 里**0 个 artifact**（即从未产出）。已按平台约束改正并**用同一接口复验
   > `valid=true`**。所以上面那句"白跑一轮"在 09-17 之前并不成立（它压根没被调度），
   > **从下一个 tag 起才成立**。这条流水线也不在发版路径上（GitHub Actions 出包 → `release.mjs`
   > 上传到 gitcode release），它只是 GitCode 侧的一条备份构建；它需要 GitCode 仓库配
   > `TAURI_SIGNING_PRIVATE_KEY`(+`_PASSWORD`)，没配就会在签名那步失败。
3. **跑完必须删 tag 与 Release，而且先等 run 结束再删**：run 不会因为 tag 被删而停止——
   若在它跑完前就把 Release 删了，`release` job 之后还会把它建回来（等于白删一次）。
4. **删除后复核 404，`run` 记录保留**（run 记录是这次的证据，别一起清掉）。
5. **重跑同一个 tag 会硬失败（422），这是预期行为**：GitHub 上同名资产已存在 → 上传返回 422 →
   `release` job 现在用 `curl -sf` **直接红掉**（原先只写 `-s` 时 422 也退出 0，于是打出 `uploaded`
   并让计数 +1，**旧件冒充新件**）。所以**要再跑一次就换一个 rcN（rc2、rc3…）**，别复用同一个 tag。

```bash
# 起（只推 github）
git tag -a vX.Y.Z-rcN -m "ShuyoNote vX.Y.Z-rcN (dry run)"
git push github vX.Y.Z-rcN
# 收尾（**先等 run 结束**；token 需能读/写 release，取法与 ⑤ 里 GitHub API 的用法一致）
GH=<GitHub token>; TAG=vX.Y.Z-rcN
RID=$(curl -s -H "Authorization: Bearer $GH" "https://api.github.com/repos/ShuyoNote/ShuyoNote/releases/tags/$TAG" | jq -r '.id // empty')
[ -n "$RID" ] && curl -s -X DELETE -H "Authorization: Bearer $GH" "https://api.github.com/repos/ShuyoNote/ShuyoNote/releases/$RID"
git push github :refs/tags/$TAG    # 删远端 tag
git tag -d $TAG                    # 删本地 tag
```

### 9.5 已知边界 / 未做的事（如实列）

- **只出 APK，不出 AAB**：AAB 是 Play 上架才需要的，而且 `apksigner` **签不了 AAB**（那是 jarsigner 的世界）
  ⇒ 签不了的 AAB 既不能装也不能做指纹自查，纯负担；
- **Android 的应用内更新是"下载 APK"，不是"应用内装机"**（2026-09-14 上线第一版）：
  应用内「检查更新」会读同一份 `latest.json`，有新版时给一个「下载 APK」按钮，
  地址取自 `platforms["android-aarch64"].url`，点击后**交给系统浏览器/DownloadManager**，
  下载完由用户自己安装（覆盖安装要求签名一致，安装签名由 Android 系统安装器强制校验）。
  **应用内不下载、不唤起安装器**（那需要 `REQUEST_INSTALL_PACKAGES` 之类的权限与 FileProvider，
  属于后续增量；本版**没有新增任何权限、没有改 AndroidManifest**）。
  ⇒ 所以：能"发现 + 拿到包"，但"装"这一步在系统里。仍没有的：应用商店 / 增量更新 / iOS。
  清单里的 `signature` 对 Android 用 `sha256:<hex>`（apk 没有 minisign `.sig`——签名在包内），
  这条字段**不能省**，理由见 §⑥（缺了会让整份清单解析失败、桌面更新一起挂）；
  - **启动时的红点/顶部横幅：Android 上「有」**（口径 2026-09-14 核实代码后写死，别写反）。
    `useUpdateChecker()` 在 `App.tsx` 里**无条件**调用；而 `isDesktop()` 的真实语义是"**有没有 Rust 内核**"
    （见 `src/lib/platform/capabilities.ts` 顶部的边界说明），**Android 壳为真** ⇒ 它走的是桌面那一支
    `checkDesktopUpdate()`。Android 上 `tauri-plugin-updater` 没注册（`src-tauri/src/lib.rs` 里带
    `#[cfg(desktop)]`）⇒ 这一步**必然失败**，代码随即**降级**到 gitcode 发布渠道清单
    （`detectFromGitcode()` → `updates::fetch_update_manifest`，该命令在 `generate_handler!` 里
    **没有** `#[cfg(desktop)]`，全平台注册）比对版本。⇒ **线上 `latest` 渠道比已装版本新时，Android
    启动就会出现红点 + 顶部横幅**，与桌面同一套 UI。回归测试：`src/lib/useUpdateChecker.test.ts`。
  - 上面这条**不是**"Android 支持自动更新"，真正的边界在"**装**"这一步，三条都要说清：
    ① 启动红点/横幅**只是提醒**——它的 CTA 只到「关于」（`UpdateBanner` 的非 Web 分支只有「查看更新」
    一个按钮），**不直接在横幅里给下载**；
    ② APK 地址只有「关于」的 Android 分支才取（`platforms["android-aarch64"].url`），点「下载 APK」后由
    **系统浏览器/DownloadManager** 下载，装机交给系统安装器——**应用内不下载、不唤起安装器**；
    ③ 清单里**没有** `android-aarch64` 键（老清单）时退回「前往发布页」，不是什么都不给；
- **arm64-only**：只出 `arm64-v8a`，**armv7 老机装不上**（非 arm64 的 apk 也不进更新清单）；
- **自带的 Kotlin 证书校验器是打过补丁的 fork**（`scripts/vendor/rustls-platform-verifier/`）：
  上游把 PR #179（或等价修复）合并并发版后，应升级依赖、恢复脚本里的 AAR 注入方式、删掉那个目录
  （判断条件与复现步骤见该目录的 `README.md`；**升级 Rust 依赖时务必回去核对它**）；
- `src-tauri/gen` **不在版本控制里**（"可重建"）⇒ CI 每次自己 `init`，而
  `pnpm android:platform-verifier` 注入的证书校验器**必须排在 `init` 之后、`build` 之前**
  （漏了它构建照样绿，但真机上**所有 HTTPS 全挂**）；
- 本机 Windows **出不了 Android 包**（见本节开头）⇒ 出包只能在 CI。

### 9.6 发版检查清单（照着勾）

**每次正式发版：**

- [ ] **这次进 `main` 的是 `dev`，而不是某条特性分支**：`git merge-base --is-ancestor dev main` 为真
      （PowerShell 里 `$LASTEXITCODE` 为 0），且 `main` 上那次合并是显式写的 `git merge --no-ff dev`
      （见 ④ 与 [development.md](development.md) §10.3 / §10.4）。为假 ⇒ 又绕过了 `dev`，**停下查清再发**。
      注意：**`main == dev` 本身不是问题**——静止时两者对齐是正常状态，别为了"看起来 dev 在领先"造提交
- [ ] `node scripts/check-versions.mjs` 过（`package.json` 等版本号一致，见 ②）
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 已开成本版本段（见 ①）
- [ ] tag 名为 `v<版本>`，与 `package.json` 的版本一致（APK 文件名用的是 `package.json` 的版本）
- [ ] tag 已推到**两个远端**（④ 的写法即 `git push origin vX.Y.Z && git push github vX.Y.Z`；
      `release.yml` 只在 **GitHub** 上触发，gitcode 负责镜像与更新通道）⇒ 两边各查一次
      `git ls-remote origin refs/tags/vX.Y.Z` / `git ls-remote github refs/tags/vX.Y.Z`，两条 SHA 一致
- [ ] Actions 里这条 tag 的 run **4 个 job 全绿**：`build`(ubuntu-24.04) / `build`(windows-latest) / `android` / `release`
- [ ] `android` job 日志里 `✅ 指纹一致（正式密钥 shuyonote）`、`✅ ABI 恰为 arm64-v8a`
- [ ] `release` job 日志里 `APK_N == 1` 与 `.sha256` 断言通过（否则"少个包/少个指纹"会伪装成成功）
- [ ] Release 上挂着 `ShuyoNote_<版本>_android-arm64-release.apk` 与其 `.sha256`
- [ ] **本机独立复核**：`apksigner verify --print-certs <apk>` 的 SHA-256 指纹 = `6ee89e6f…`
- [ ] **本机独立复核**：`Get-FileHash <apk> -Algorithm SHA256` / `sha256sum <apk>` 的结果，与
      Release 上的 `.sha256`、以及发布后 `latest.json` 的 `platforms["android-aarch64"].signature`
      （去掉 `sha256:` 前缀）**三者一致**
- [ ] **发布时**：`node scripts/release.mjs --no-build --android-apk <APK 路径> …` —— 日志里应出现
      `latest.json 校验通过：… android-aarch64 …`；**没有** apk 会直接失败（要跳过只能写 `--no-android`）
- [ ] **真机**：`adb install -r`（同签名升级）成功，**数据未丢**（`firstInstallTime` 不变）
- [ ] **真机**：启动无 panic（`adb logcat -d -v brief` 里没有 `RustStdoutStderr` 的 panic 行）
- [ ] **反向判据**：给这个包发测试深链 → 得到「测试钩子未启用（这是正式构建）」
- [ ] **真机（应用内更新入口）**：「关于」→「检查更新」：有新版本时出现**「下载 APK」**并按预期
      打开浏览器/下载器拿到同名文件；已是最新时**不打扰**（无红点/无横幅）；离线时不崩、只提示检查失败
- [ ] **真机（启动红点）**：装一个**比线上 `latest` 渠道旧**的包（`adb install -r` 旧版本件）再冷启动
      ⇒ 应出现**红点 + 顶部横幅**（点横幅进「关于」，再走「下载 APK」）。这条钉的是 §9.5 那条
      "Android 上 in-app updater 不可用 ⇒ 降级到发布渠道清单"的路径；桌面/Web 侧预览同一条路可加
      `?updateDebug=9.9.9`
- [ ] 桌面/Web 侧照 ⑤⑥⑦ 继续（Android 只是其中一件）

**只有 dry-run（临时 tag）才多做的：**

- [ ] 用 `v<版本>-rcN`（**换一个没用过的 N**），**只推 `github` 远端**
- [ ] 验证完**先等 run 结束**，再删 Release 与 tag
- [ ] 复核删除生效（release / ref-by-tag 均 404），**`run` 记录保留**

## 发版说明里带上社区链接

每次发版的说明都会成为一个**可被搜索引擎抓取的页面**，也是社区最稳的外链来源。
发版时请在说明末尾附上社区地址：**[community.shuyo.cn](https://community.shuyo.cn)**
（例如「详细讨论与插件配方见社区」+ 链接）。
