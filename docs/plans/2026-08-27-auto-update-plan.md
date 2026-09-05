# 「自动升级」方案（规划/建议，未实装）

> 一句话：ShuyoNote 是**本地优先 · 离线可用 · 数据在本机 · 自托管 sync-server** 的桌面应用（AGPL-3.0）。自动升级做成**「后台检测 + 用户触发的安装」的半自动模型**，**绝不静默强制重启**；检测失败（离线/无网）优雅降级。真正的成本在**签名 + 更新清单的发布管线**，前端集成不难。
> 状态：**规划，建议**。关联 [帮助系统](2026-08-27-help-system-plan.md)（入口放「关于」）、[开发指南](../development.md)（版本号规则 §5）、[发布](../RELEASING.md)（发版流程）。

---

## 1. 背景与判断

- **分布形态**：桌面 Tauri 2，产物 MSI/exe；目前**本地手工发版**（bump 版本 → `pnpm tauri build` → push 到 gitcode），无 CI 自动构建、无 hosted 更新端点。
- **产品特性**：本地优先、数据在本机、离线可用；用户在编辑/未同步时被强重启会丢上下文——这是**决定升级模型**的关键。
- **分布渠道**：gitcode 仓库（主页/发布/问题），见[项目网站导航方案](2026-08-27-project-website-navigation-plan.md)。

三个判断：
1. **更新 = 用户可感知、可拒绝的事**。新版本对本地优先工具是"可选优化"，不是"必须立刻"；强推会伤害信任。
2. **别静默自动装+重启**。宁可"下载好后退出再装"，也不要写一半自动重启。
3. **升级端点要可信**：HTTPS + 签名校验；用官方 Tauri updater，不自造机制。

**结论：半自动——后台 `check()` 拉最新版，发现新版本给用户按钮；用户点「下载并安装」才真正下载/安装；离线/失败不打扰。**

---

## 2. 目标与边界

| 项 | 决策 |
|----|------|
| 检测时机 | 启动后后台 + 「关于」手动「检查更新」 |
| 更新方式 | 用户点「下载并安装」；Windows 可「退出时安装」或确认后立即重启 |
| 打搅程度 | 发现新版本 → 柔性提示；**不**弹启动强制 Modal |
| 离线/失败 | "检查失败（离线）" 或静默，绝不报错阻塞 |
| Web 端 | updater 是桌面专属，Web 直接禁用该项 |
| 更新端点 | 单个稳定 HTTPS URL（自控域或 gitcode releases） |
| 安全 | 仅 HTTPS + 校验签名；不用用户可控 URL |
| **不做** | 静默自动装+重启、上线强制更新、第二个账号/托管、delta 之外的复杂通道 |

---

## 3. 推荐模型（半自动）与 UX 流程

```
打开「关于」/ Ctrl+K「检查更新」 → 后台 check()
   ├── 已是最新  → "已是最新 vX.Y.Z"（可静默，不弹窗）
   ├── 有新版本  → "发现新版本 vX.Y.Z"
   │                 ├── 「下载并安装」→ 下载 → 有未保存/未同步先提示 → 退出时安装 / 确认后重启
   │                 └── 「稍后」→ 关闭，不强制
   └── 网络/端点失败 → "检查失败（离线）"
```

- 入口：**「关于」对话框**（`src/components/AboutDialog.tsx`，加一个「检查更新」块）+ 命令面板命令（`help.check-update`）。
- 状态展示：About 里显示当前版本 & 最新版本对比；有新版本时按钮高亮。

---

## 4. 技术方案（官方 Tauri 2 updater）

### 4.1 依赖
- Rust：`tauri-plugin-updater = "2"`（`src-tauri/Cargo.toml`），并在 `lib.rs` 注册插件。
- JS：`@tauri-apps/plugin-updater`（`package.json` + `src/lib/platform/` 的 updater 能力）。

### 4.2 签名
- 生成私钥/公钥：`tauri signer generate -w ~/.tauri/shuyonote.key`。
  - **私钥保密**，不进 git、不进 env 明文；生成时用密码保护。
- 公钥写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。

### 4.3 打包产物 + 更新清单
- `tauri.conf.json` 开启 `bundle.createUpdaterArtifacts: true`（NSIS/MSI updater 需要），产物带 `.sig` 签名文件。
- 更新清单 `latest.json`（Tauri 官方格式），内容含版本号 + 各平台产物 URL + 签名；发布到稳定 HTTPS 地址（自控域，或 gitcode releases 直链）。

```json
{
  "version": "1.59.178",
  "notes": "…",
  "pub_date": "2026-08-27T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "…",
      "url": "https://cdn.…/ShuyoNote_1.59.178_x64-setup.exe"
    }
  }
}
```

### 4.4 前端 `checkForUpdates()`
- 走 `updater.check()` 拿是否更新 + 版本；比对后驱动 UI。
- **Web/降级安全**：仅在有 `window.__TAURI_INTERNALS__` 时启用；无则 About 里该按钮置灰/隐藏。
- 下载/安装：`downloader.downloadAndInstall()`；安装前若有未同步/未保存，先提示（尊重本地优先）。

---

## 5. 发布管线（关键前置）

把升级进**提版流程**，沿用现有版本约定（`docs/development.md` §5）：
1. bump 版本（package.json / Cargo.toml / tauri.conf.json / Cargo.lock / docs）。
2. `tauri signer` 用私钥签名。
3. `pnpm tauri build`（开 `createUpdaterArtifacts` → 产物 + `.sig`）。
4. 发布产物 + 更新清单 `latest.json` 到稳定 HTTPS 端点（gitcode releases 或自控 CDN）。
5. 更新 `docs/README.md` / CHANGELOG / SHUYONOTE_STATE。

> 说明：此步骤为**手工**，与现有"本地发版"一致；若日后要 CI 自动构建，需把签名密钥/令牌放入 CI 机密，并将构建+上架脚本化。

---

## 6. 分阶段落地

| 阶段 | 内容 | 依赖 | 可见效果 |
|------|------|------|----------|
| **1（轻，先上）** | About/命令面板加「检查更新」：`check()` 拉最新版本 → 新版本弹窗（跳发布页/给安装按钮）；旧→"已是最新"；离线→"检查失败"。Web 端禁用 | 只需一个稳定版本端点 | 先有"检测"体验，不需完整签名 |
| **2（完整）** | 接 `tauri-plugin-updater`：签名+端点+构件 `.sig`，实现**应用内下载+安装**（含更新清单发布） | 一次真实签名发布 | 真正自动升级 |
| **3（可选）** | NSIS 差分增量、beta/stable 通道、企业自托管更新地址可配 | — | 进阶，非当前 |

---

## 7. 文件/配置改动清单（阶段 2 落地参考）

| 文件 | 改动 |
|------|------|
| `src-tauri/Cargo.toml` | `tauri-plugin-updater = "2"` |
| `src-tauri/src/lib.rs` | 注册 updater 插件 |
| `src-tauri/tauri.conf.json` | `plugins.updater.pubkey`、`bundle.createUpdaterArtifacts`、`endpoints` |
| `package.json` | `@tauri-apps/plugin-updater` |
| `src/lib/platform/types.ts` | `UpdaterDriver`（check/downloadAndInstall，web 端 no-op） |
| `src/lib/platform/tauri.ts` | 实现 updater 驱动 |
| `src/lib/platform/web.ts` | updater 降级（返回 disabled） |
| `src/components/AboutDialog.tsx` | 「检查更新」块 + 状态/按钮 |
| `src/plugins/registry.ts` | `help.check-update` 命令 |
| `scripts/smoke-web.mjs` | 断言 updater 驱动在 web 端降级不崩 |
| `docs/development.md` | 发布/签名/更新清单提版流程 |

---

## 8. 验收标准（阶段 2）

- About/命令面板能 `check()`；有新版本→正确按钮/跳转；旧→"已是最新"；断网→"检查失败"，UI 不崩。
- 用户点「下载并安装」→ 下载进度 → 有未保存/未同步先提示 → Windows 退出时安装 / 确认后重启。
- 签名校验失败/端点不可达 → 拒绝安装并提示，不静默执行。
- Web 端「检查更新」隐藏/禁用，不报错。
- `npx tsc --noEmit` / `node scripts/smoke-web.mjs`（全绿不减少）/ `pnpm build` / `cargo check`。

---

## 9. 边界与诚实标注

- **端到端验证需一次真实签名发布**：本机 Windows 可测 MSI+updater 路径，但纯开发环境无法白测"真实更新"（需要发布签名产物 + 托管清单）。
- **不做**：静默强制重启、强制在线、多通道复杂化、第二个账号/托管体系。
- **本地优先红线**：升级不得丢失/阻塞未保存或未同步数据；检测失败绝不降级/报错。
- **安全红线**：仅 HTTPS + 签名校验；更新地址为项目自控，不接受用户输入 URL。

---

> 关联：帮助系统（M25，入口放「关于」）、[项目网站导航方案](2026-08-27-project-website-navigation-plan.md)（发布页链接）、[开发指南](../development.md)（版本与提版约定）、AGPL-3.0（与 updater 无冲突，仅替换二进制）。
