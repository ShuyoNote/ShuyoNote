# 发布流程（ShuyoNote）

> 记录，含一次踩坑：**CHANGELOG 段头曾被覆盖导致版本中间断**——用脚本防再犯。

## ① 更新 CHANGELOG
用脚本在顶部插入新版本段（**自动保留所有旧段头**）：
```bash
pnpm changelog 1.82.8 "同步完善 + 修复"
```
然后编辑生成的 `## [1.82.8]` 段（`### Added`/`### Changed` 补条目）。

> ⚠️ 教训：**不要**用「前一版本段头」做手动替换锚点——那会把旧段头覆盖，造成版本断档。务必用上面脚本（它只在首个版本头之前插入，原内容不动）。

## ② 同步三处版本
`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock`(shuyonote version) / `README.md`(badge) / `docs/README.md`(当前版本)。

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

## ⑤ 签名构建（桌面）
```bash
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw "$HOME\.tauri\shuyonote.key").Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw "$HOME\.tauri\shuyonote.key.pw").Trim()
pnpm tauri build      # 产出 setup.exe + .sig
```

## ⑥ 发布 gitcode
```bash
node scripts/release.mjs --no-build   # 需 GITCODE_TOKEN + RELEASE_NOTES
```

## ⑦ Web 版（可选，同步上线）
```bash
pnpm run build:web     # dist-web/version.json → 该版本
# 上传 dist-web/* 到 /var/www/shuyo-site/app/（scp）+ chmod -R 644/755
```

## ⑧ 检查 CHANGELOG 连续
```bash
Select-String -Path CHANGELOG.md -Pattern '^## \[' | Select-Object -First 12
```
应看到 `X.Y.Z → X.Y.Z-1 → …` 连续，无断档。
