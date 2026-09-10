# 发布流程（ShuyoNote）

> 记录，含一次踩坑：**CHANGELOG 段头曾被覆盖导致版本中间断**——用脚本防再犯。
> 发布时间窗（v1.83.0，2026-09）：**GitHub Actions 负责多平台构建（Win/Linux）；GitCode 是应用内「检查更新」与下载通道**。macOS 因缺 Apple 签名/公证凭据暂未启用（见 [multi-platform-ci.md](multi-platform-ci.md)）。

## ① 更新 CHANGELOG
用脚本在顶部插入新版本段（**自动保留所有旧段头**）：
```bash
pnpm changelog 1.84.0 "版本主题"
```
然后编辑生成的 `## [1.84.0]` 段（`### 新增`/`### 修复`/`### 其它` 补条目）。

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
git push origin main && git push origin vX.Y.Z
```

## ⑤ 平台构建

### 多平台（推荐：GitHub Actions）
把仓库镜像到 GitHub，打 `v*` tag / workflow_dispatch → `.github/workflows/release.yml` 自动：
- `ubuntu-24.04` → `.deb + .AppImage`
- `windows-latest` → `.exe (nsis)`
- `macos-latest` → `.dmg/.app`（**待 Apple secrets 后启用**）

产物上传到 GitHub Release（`softprops` 未用，`release` job 用 curl+GitHub API 只挂安装包）。仓库 Secrets：`TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（必填），macOS 另需 `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`/`APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`。

### 本机（Windows 签名构建）
```bash
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw "$HOME\.tauri\shuyonote.key").Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw "$HOME\.tauri\shuyonote.key.pw").Trim()
pnpm tauri build      # 产出 setup.exe + .sig
```

## ⑥ 发布到 GitCode（更新通道）
```bash
node scripts/release.mjs --no-build   # 需 GITCODE_TOKEN + RELEASE_NOTES
```
它建 GitCode release、上传 installer/`.sig`/`latest.json`、并更新 `latest` 通道（应用内「检查更新」读的就是它）。注意 `latest.json` 的 `url` 指向 gitcode release，签名用同一签名密钥产出的 `.sig`，须与文件字节一致。
`--no-build` 前提是安装包已就绪（如 GitHub Actions 产物）；缺省会先 `pnpm tauri build`。

## ⑦ Web 版（可选，同步上线）
```bash
pnpm run build:web     # dist-web/version.json → 该版本
# 上传 dist-web 到 /var/www/shuyo-site/app/（scp）+ chmod -R 644/755
#   正确：scp -r dist-web/. root@host:/var/www/shuyo-site/app/   ← 注意 dist-web/.（斜杠点）
#   或：  scp dist-web/* dist-web/.[!.]* root@host:/var/www/shuyo-site/app/
#   错误：scp -r dist-web root@host:/var/www/shuyo-site/app/     ← 会传成 app/dist-web/，⚠️见下
```

> [!] **部署路径坑（v1.84.4 实际踩到）**：`scp -r dist-web host:/app/` 会把 **`dist-web` 整个目录**传成 `app/dist-web/`，而**不是**把内容铺进 `app/`。结果 `app/index.html` 是新的（引用新 hash 资源），但 `app/assets/` 仍是旧资源 → 启动报「失败的资源: …/assets/index-*.js 404」。**必须用 `dist-web/.`（斜杠点）**把内容铺平，或先传再 `cp -rf app/dist-web/. app/ && rm -rf app/dist-web`。**部署后务必验证**：`curl -s https://shuyo.cn/app/index.html | grep -oE 'assets/[^\"]+\.(js|css)'` 逐个 `curl` 应全 200。

> [!] **清理旧 assets 必须保留「动态加载」资源（踩坑，v1.84.1）**：官网手动部署时若删旧产物，**不能只按 `index.html`/`sw.js` 的静态资源引用过滤**——sql.js 的 wasm（`new URL('sql-wasm-….wasm', import.meta.url)` 在 `vendor-*.js` 里运行时加载）和 pdf worker（`pdf.worker.min-….mjs`）等**不在静态引用里**，误删会导致 `Error: SqliteStore not initialized`（sql-wasm fetch 404 → `SqliteStore.init()` 抛错 → catch 返回未初始化 store → 所有 DB 查询报错）。
> **正确做法**：按**本地 `dist-web` 全量清单**同步（`find . -type f` 生成本地清单，服务器按清单删多余文件），既铺平目录又保留全部动态资源。**GitHub Pages 走 CI 全新构建不受影响**；只有手动 scp 的官方站需小心。

## ⑧ 检查 CHANGELOG 连续
```bash
Select-String -Path CHANGELOG.md -Pattern '^## \[' | Select-Object -First 12
```
应看到 `X.Y.Z → X.Y.Z-1 → …` 连续，无断档。
