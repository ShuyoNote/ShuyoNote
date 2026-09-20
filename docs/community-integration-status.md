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

**发布产物级的证据（v1.90.0 的安装包本体）**：

- **Linux**：`ShuyoNote_1.90.0_amd64.deb` 里 `/usr/share/applications/ShuyoNote.desktop` 含
  `MimeType=x-scheme-handler/shuyonote` ✓（解 deb + 读文本即可核对）——这条现在是**发布流程里的门禁**
  （`release.yml` 的 Linux 档：解包 → 找 .desktop → 必须含这一行）；
- **Windows**：注册表串在 NSIS 的**压缩脚本块**里，`grep` 安装包读不到（要 7-Zip 解 NSIS 才行），
  所以那一档靠源码级四查（`scripts/check-deep-link.mjs`）+ **真机三步验证**；本项目没有在 macOS 上
  直接读 Windows 安装包内注册表串的手段，这一点如实记着。
- **macOS**：桌面版仍未发布（Apple 证书刚到位、secrets 待配），但**协议注册已在系统层验过**
  （2026-09-15，未签名的本机构建）：产物 `ShuyoNote.app/Contents/Info.plist` 里有
  `CFBundleURLTypes → CFBundleURLSchemes = shuyonote`，`lsregister -dump` 对该 bundle 报
  `claimed schemes: shuyonote:` ⇒ macOS 会把 `shuyonote://` 路由到本应用。
  这条现有门禁守着：`pnpm check:macos-bundle`（`.github/workflows/macos.yml` 每次 push 跑）。
  **仍未验**的是"应用内部真的收到了这个 URL"——那要等签名版装上后点一次链接触发，如实记着。

## 二、把社区内容拿回来（`save`）

| 环节 | 状态 | 证据 |
|---|---|---|
| 抓取（桌面走原生 / Web 走浏览器） | ✅ | `src-tauri/src/community.rs`（5 条测试：策略/解析/真环回 HTTP 的 401、404、非 JSON、体积上限）+ `src/lib/communityPost.ts`（16 条） |
| 请求带 `Accept: application/json` | ✅ | 同上（社区只需在**帖子页地址**上做内容协商，应用不用改） |
| 预览 → 确认 → 落库 | ✅ | `CommunitySaveDialog` 8 条渲染级测试（预览阶段不落库、取消零痕迹、只写一次） |
| 幂等（同一帖不存第二篇） | ✅ | 搜到候选后**逐字核对**来源地址；4 条测试 |
| **社区侧提供 JSON** | ✅ **已通（2026-09-20）** | 社区 `0.71.24` 起 `GET /post/{slug}` 支持内容协商：带 `Accept: application/json` 返回**落库的原始 Markdown**（`body_markdown`）＋ `Vary: Accept`，机器取数不计浏览；`0.71.25` 修掉上线实测抓到的 `url` 被拼成相对路径（应用会按白名单拒掉）。线上实测 18/18，应用侧另有一条**活判据** `community::tests::live_community_json_is_accepted_by_this_parser`（`#[ignore]`）拿真站点喂自己的解析器。Web 版另需 `Access-Control-Allow-Origin`（社区仓库没有 CORS 先例，**仍未做**，要 owner 拍板） |

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
| 1. 社区帖子 → 一键存进笔记 | ✅ **代码与社区侧都通了（2026-09-20）** | 社区 `0.71.24` 起帖子页做内容协商（`Accept: application/json` → 原始 Markdown）、`0.71.25` 修 `url` 相对路径、`0.71.26` 给 JSON 加 `Access-Control-Allow-Origin: *`（Web 版需要）。应用侧一条**活判据** `community::tests::live_community_json_is_accepted_by_this_parser` 拿真站点喂自己的解析器；线上实测 22 条全绿 |
| 1 的界面验收 | 待做 | 有 GUI 的机器上跑一次「订阅 → 安装」并用帖子链接走一遍「点链接 → 预览 → 确认落库」 |
| 2. URL scheme 导入（配方/主题/模板） | ✅ 模板这一路通了（清单预览 + 确认才写） | 主题**没有文件格式**（如实说不做）；插件属于分发，走索引订阅 |
| 3. **应用 → 分享笔记到社区**（**整篇正文 ＋ 发布前清单**，owner 2026-09-20 拍板） | ⏳ **只剩"回写发布元数据"一件** | ① **社区侧依赖已解除**（`shuyo-community@0.71.20`：`POST /api/posts` ＋ `Idempotency-Key` ＋ `source` 标记 ＋ 设备码应用令牌 ⇒ **不存用户密码**）；② **凭据那半条换了更好的答案**：原写的"要用户自己的凭据"由设备码授权满足（用户网页确认一次，客户端只拿一把 180 天、可撤销、只能发帖的令牌）；③ 已落（分支 `feat/publish-to-community`）：后端通道（`c3d9f5af`）、对话框＋入口＋I7 清单＋跨仓活判据（`7bb7c9c3`）、**本地图片先传社区**（`57bd6d64`）；⏳ 剩下：把发布元数据写回（落点见方案 §7.2，建议新开一张旁表）。口径与不变式见 [2026-09-20 方案](plans/2026-09-20-shuyonote-publish-to-community-plan.md) |
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
