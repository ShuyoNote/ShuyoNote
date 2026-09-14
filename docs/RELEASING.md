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
> 1. **`## [Unreleased]` 必须存在、在第一个、且是空的**——它是"下一版内容写哪儿"的落点。
>    把 `[Unreleased]` 整段开成本版本段之后（1.90.2 就是这么做的），**记得补一个空 `[Unreleased]` 回顶部**；
>    1.89.1 / 1.90.0 / 1.90.1 三次发版都留了，1.90.2 漏了（那次之后才补上）。
> 2. **段里的小标题只用这七个**：`新增` / `变更` / `修复` / `移除` / `安全` / `废弃` / `其它`，且同一段内不许重复。
>    历史上用过的 `优化 / 改进 / 重构 / 样式 / 工程 / 文档 / 测试 / 验证 / 说明 / 其他 / ### 修复（xxx）`
>    等写法已 grandfather（只对新版本生效，不改历史）。

> ⚠️ 教训：**不要**用「前一版本段头」做手动替换锚点——那会把旧段头覆盖，造成版本断档。务必用上面脚本（它只在首个版本头之前插入，原内容不动）。

## ② 同步多处版本
`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock`(shuyonote version) / `README.md`(badge) / `docs/README.md`(当前版本)。`node scripts/check-versions.mjs` 会强制一致。

## ③ 校验 + 构建
```bash
pnpm run build        # check-versions + tsc + vite build
```

## ④ 提交 + Tag
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
>   这个仓库收到 tag** 时才会跑（gitcode 上跑的是另一套 `.gitcode/workflows/build-linux.yml`，
>   只出 Linux 包）⇒ 多平台构建（含 Android 发版件）**根本不会开始**；
> - **只推 github ⇒ gitcode 上没有这个 tag**：而 gitcode 是应用内「检查更新」与下载通道（见文首）
>   ⇒ 镜像与更新通道还停在旧版本、用户收不到新版。
> 两条都不是"可有可无"：一个决定**能不能出包**，一个决定**用户能不能收到**。

## ⑤ 平台构建

### 多平台（推荐：GitHub Actions）
把仓库镜像到 GitHub，打 `v*` tag / workflow_dispatch → `.github/workflows/release.yml` 自动：
- `ubuntu-24.04` → `.deb + .AppImage`
- `windows-latest` → `.exe (nsis)`
- `macos-latest` → `.dmg/.app`（**待 Apple secrets 后启用**）

产物上传到 GitHub Release（`softprops` 未用，`release` job 用 curl+GitHub API 只挂安装包）。仓库 Secrets：`TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（必填），macOS 另需 `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`/`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`。

**⚠️ GitHub Release 里没有 `.sig`**：`release` job 显式只挑 `.exe/.dmg/.deb/.AppImage`。要发 GitCode（更新通道需要签名）就得从 **run artifacts** 取，两个 build job 上传的 `bundle-<platform>` 含完整 `bundle/` 目录（含 `.sig`，保留 7 天）：

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

### 本机（Windows 签名构建）
```bash
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw "$HOME\.tauri\shuyonote.key").Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw "$HOME\.tauri\shuyonote.key.pw").Trim()
pnpm tauri build      # 产出 setup.exe + .sig
```

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
`latest.json` 同一平台键只能留一个 url，取哪个由 `MANIFEST_PREFERENCE` **写死**（Windows 取 exe、Linux 取 deb、macOS 取 dmg、Android 取 apk），不再依赖目录遍历顺序；另一个（如 AppImage）照样挂到 release 上。

> 覆盖检查可以用 `SHUYONOTE_PREV_MANIFEST_JSON=<文件>` 注入一份"线上清单"来验（**只为测试这条门禁**，
> 正常发布别设）。为什么需要它：Android 通道上线前线上清单里**根本没有** `android-aarch64`，
> 于是没有任何真实输入能证明"线上有、本次没有 → 会红"这条检查真的会拦——不会被触发的门禁等于没有。

**发布后自检**（自动检查之外的兜底）：拉 `https://gitcode.com/shuyo-cn/ShuyoNote/releases/download/latest/latest.json`，确认 `version` 已是新版本，且各平台 `signature` 与该 release 上的同名 `.sig` **逐字符一致**。

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
它钉的是**骨架**：`[Unreleased]` 存在/唯一/在首位/为空、段头必须是 `## [X.Y.Z] - YYYY-MM-DD`
（真实日历日）、版本号从新到旧严格递减且**无重复段头**（`## [1.66.0]` 曾经出现过两段）、
代码围栏成对、无 ≥3 行连续空行、无空的 `- ` 占位条目、标题前有空行，以及**新版本**
（基线 1.90.2 之后）的小标题唯一且取自允许集合。
它**不管**文风、措辞、条目详略，也不管日期与版本号先后是否合理——那些要人判断。

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
