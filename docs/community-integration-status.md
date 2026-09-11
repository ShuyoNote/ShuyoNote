# 社区互动接入：验收记录与现状

> 2026-09-11 起。这份文件回答三个问题：**哪些已经验过、用什么东西验的、还差什么**。
> 它是"交接时不用翻聊天记录"的那一份；过程性商量在私有信箱里，不在这里。
>
> 相关：[社区互动方案](plans/2026-09-11-app-community-interactions.md)（规划）·
> [插件索引规范](plugin-index-spec.md)（分发格式）· [插件托管流程](plugin-hosting.md)（托管方怎么发）

## 一、深链（`shuyonote://`）

| 环节 | 状态 | 证据 |
|---|---|---|
| 解析（纯函数） | ✅ | `src/lib/deepLink.ts` + 19 条测试（含真机归一化出来的 `save/?url=…` 形态） |
| 分派（谁处理哪条） | ✅ | `src/lib/deepLinkDispatch.ts` + 7 条测试（`page/` 打开那一页、`save`/`import` 进对话框、`compose` 如实说没做、去重） |
| OS 层注册与唤起（Windows） | ✅ **真机** | 注册表 `HKCU\Software\Classes\shuyonote`（卸载删干净）、`ShellExecuteW` 唤起、已有实例转发同一 PID；三条原始输出在 Windows 侧 |
| 冷启动那条 URL 不丢 | ✅ | `src/lib/deepLinkBridge.ts`（三条路径收敛：`get_current` / `on_open_url` / `deep_link_take` drain）+ 9 条测试 |
| 界面那一段 | ✅ **用户截图** | 应用内出现「从社区链接存一篇笔记」对话框，预填框里是**原样 URL**（含归一化的 `/?`） |

**唯一没有真机验过的**：Linux 的协议注册（`.deb` 可 postinst、AppImage 不行）与 macOS（还没发桌面版）。

## 二、把社区内容拿回来（`save`）

| 环节 | 状态 | 证据 |
|---|---|---|
| 抓取（桌面走原生 / Web 走浏览器） | ✅ | `src-tauri/src/community.rs`（5 条测试：策略/解析/真环回 HTTP 的 401、404、非 JSON、体积上限）+ `src/lib/communityPost.ts`（16 条） |
| 请求带 `Accept: application/json` | ✅ | 同上（社区只需在**帖子页地址**上做内容协商，应用不用改） |
| 预览 → 确认 → 落库 | ✅ | `CommunitySaveDialog` 8 条渲染级测试（预览阶段不落库、取消零痕迹、只写一次） |
| 幂等（同一帖不存第二篇） | ✅ | 搜到候选后**逐字核对**来源地址；4 条测试 |
| **社区侧提供 JSON** | ⏳ **等社区** | 现在 `/post/<slug>` 只回 HTML、`/api/posts/*.json` 任何 id 都 401。要改的一条写在给社区的一页纸里（内容协商 + `Content-Type`） |

## 三、导入产物（`import`）

| 环节 | 状态 | 证据 |
|---|---|---|
| 动作与 `save` **分开** | ✅ | `LinkIntent` 带出 action；8 条 + 4 条测试（曾经把 `import` 当 `save` 执行，是静默做错事） |
| 抓文档 | ✅ | 原生命令 `fetch_community_json`（同一套策略/上限/只认 JSON） |
| 清单预览（会创建什么） | ✅ | `src/lib/communityImport.ts` + 8 条测试；确认才写，取消零痕迹 |
| 主题 | ❌ 不做 | 没有文件格式（只是 localStorage 里两个偏好）→ 界面如实说明 |
| 插件 | ➡️ 走分发 | 见下一节的索引订阅（有签名、撤回、权限清单） |

## 四、插件分发（第一方插件）

| 环节 | 状态 | 证据 |
|---|---|---|
| 发版产出片段 | ✅ | `scripts/plugin-fragment.mjs`（打包 → 签名 → 片段 + 可验证的预览索引）；`release.mjs` 配了私钥就自动做，没配就**明确跳过并说清后果** |
| 打包跨平台 | ✅ | `scripts/lib/pack-zip.mjs`（fflate，固定 mtime ⇒ 同输入同字节；Windows 上没有 `zip`） |
| 应用真解析器 / 真校验器验收 | ✅ **在 CI 里** | `external_index` / `external_package` 两个忽略测试，CI 每次 push 用一次性密钥打真包跑一遍 |
| 社区托管的索引（18 个第一方插件） | ✅ **线上验过** | 索引签名 ✓、18 条全「可安装」、抽样包字节逐字节一致、发布者签名验过且可解 |
| 托管规矩（缓存头 / 逐条字节） | ✅ | `pnpm check:plugin-hosting`——线上实测 60 通过 / 0 失败 |
| **端到端「订阅 → 安装」（线上真实索引）** | ✅ **已过** | `live_hosted_index_installs_end_to_end`（默认忽略、要联网）：拉社区索引并**验索引签名** → 挑条目 → 下载 → 验 sha256 → 验发布者签名并固定 → **装进插件根目录**（真解包 + 真 discovery + 真记账 + 默认未启用）。实测：`md-outline v1.0.0（1764 字节）· 解出 1 个命令` |
| 界面上"用鼠标点一次" | ⏳ 可选 | 面板的接线有组件测试（url/pubkey/id 传对了没、被撤回的条目点不点得动、确认框挡在前面）；真机点击只能由有 GUI 的机器做，**已请对方跑，未回**——但它补的是"控件那一下"，上面那条已经覆盖了整条安装链 |

## 五、还差什么（按方案 P0 的三条对账）

方案 P0 只有三件（[方案](plans/2026-09-11-app-community-interactions.md) §三）：帖子存进笔记、
URL scheme 导入、**应用 → 分享到社区**。对账如下：

| P0 条目 | 状态 | 卡在哪 |
|---|---|---|
| 1. 社区帖子 → 一键存进笔记 | 代码全通（解析/抓取/预览/幂等/落库） | **社区侧要给出 JSON 表示**：帖子页支持 `Accept: application/json`（一条分支），应用这边一行不用改。Web 版另需 `Access-Control-Allow-Origin`（桌面走原生、没有 CORS——别混为一谈） |
| 1 的界面验收 | 待做 | 有 GUI 的机器上跑一次「订阅 → 安装」并用帖子链接走一遍「点链接 → 预览 → 确认落库」 |
| 2. URL scheme 导入（配方/主题/模板） | ✅ 模板这一路通了（清单预览 + 确认才写） | 主题**没有文件格式**（如实说不做）；插件属于分发，走索引订阅 |
| 3. **应用 → 分享笔记到社区（摘要为主）** | ❌ **没做** | 依赖**社区发帖 API**（现在没有）；而且要**用户自己的凭据**（发帖代表他本人）——这属于"要用户拍板"的一类，不该由 agent 自行决定 |
| （附带）`compose` 起一份草稿 | — | 已裁定降到 P1（要的是"未保存的编辑器内容"，不是先落库再删） |
| （附带）托管交接 | ✅ 流程已写 | 发版后把 `plugin-index.fragment.json` 交给托管方，**先传包后传索引**（见 [plugin-hosting.md](plugin-hosting.md)） |

## 六、几条踩过的坑（都带上了门禁，别再踩）

- **`import` 被当成 `save` 执行**：动作分不清就会静默做错事（不是失败静默，是"成功得不对"）。
- **`page/` 被送进社区对话框**：那条链接是应用自己生成的，接错了动作。
- **来源地址只进链接 href**（`content_json`）而没进纯文本 ⇒ 全文检索查不到 ⇒ **幂等静默失效**。
  是渲染级测试抓出来的（纯函数测试看不见）。
- **minisign 公钥盒的算法字节是 `Ed`(0x45 0x64)、签名盒是 `ED`(0x45 0x44)**：写错时应用两种都收、
  测试全绿，只有真 minisign 会拒。所以现在**盯字节本身**（`scripts/lib/minisign.test.mjs`）。
- **Windows 上没有 `zip`**：打包一度 shell out 到它，那边 `pnpm test` 红三条（其中一条被连带打死）。
- **无 BOM 的 UTF-8 `.ps1` 会被 PowerShell 5.1 当 ANSI 读**：中文会让整个脚本解析失败 →
  `pnpm check:ps1-ascii`。
- **Chrome 启动偶发卡住**（CI 容器）→ `scripts/lib/launch-chrome.mjs`：超时 60s + 重试 3 次。
  它一红，Pages 部署就不发了，所以这不是"重跑就好"的事。
