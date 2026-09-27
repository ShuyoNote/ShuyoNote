# 同步面板在窄屏的密度问题（方案，2026-09-27）

> 状态：**待 owner 拍板**。本文只给事实与选项，**没有改任何代码**。
> 上位：[跨平台方案](2026-08-24-cross-platform-plan.md)、[多工作空间方案](2026-08-22-multi-workspace-plan.md)。
> 判据出处：`src/App.css` 窄屏 5 节（L21911 起）、`scripts/verify-mobile-layout.mjs`、`docs/TESTING.md`。

## 0. 一句话 ＋ 先说实话

一句话：**同步面板"乱"不是元素太多 —— 实测内容只有 1 张空间卡（996px），
但它被放进了一个几乎全屏的底部弹层（可见 819px），于是必须滚 177px。**

⚠️ **实话三条**：

1. **我没有在真机上看过一眼**。下面所有数字都是 **390×844 的 Chromium 实测**（Edge 内核，
   `_tmp/scratch/measure-sync-panel.mjs` 与 `measure-sync-height.mjs`，可复跑）。**"乱"的观感我无法复核**。
2. **移动端布局此前已经修过一轮**，且修得对：`.sync-popover.is-sync` 的注释记着一次真事故
   ——「同步面板高 616px、底边跑到屏外 66px、**「保存」点不到**」，根因是 `.is-sync` 特异性更高
   把宽/高压回去。**本次不是那个 bug 复发**（实测底边 = 844 = 视口高，**不越界**）。
3. **本文不碰加密相关那一块**（`.space-privacy` / `SpacePrivacySection`）。见 §4。

## 1. 勘察事实（实测，可复跑）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 面板在 390×844 下是 **390×820**，`class="sync-popover is-sync is-sheet"`，`overflow-y:auto`，**底边不越界** | 实测脚本；`App.css:22348` 那段 `.sync-popover.is-sync` |
| F2 | **可见 819px ／ 内容 996px ⇒ 必须滚 177px** | `clientHeight` / `scrollHeight` |
| F3 | **高度构成**：`.sync-profiles` **618px**（内含 `section.sync-card` **594px**）、`.sync-foot` **134px**、`.space-privacy` 86px、`.sync-head` 66px、`.sync-web-note` 54px | `measure-sync-height.mjs` 逐元素实测 |
| F4 | 内容体量其实很小：**空间卡 1 张**、冲突横幅 0、待取回 0、Web 提示 1、折叠块 2、预算行 3、历史项 0、成员 0、按钮 5 | 同上 |
| F5 | **常驻 chrome = 66（头）+ 54（Web 提示）+ 134（脚）= 254px**，其中 **Web 提示是说明文、不是操作** | `SyncPanel.tsx:858` `:870` `:1217` |
| F6 | 空间卡是**一条 ~7 字段块的长表单**：服务器 → 账号状态 → 登录/注册页签 → 邮箱+密码 → 组织空间 → 成员 → **`<details>` 高级**（附件/自动/局域网/mesh/预算）→ 历史 | `SyncPanel.tsx:961`–`1408` |
| F7 | **只有"高级"那一个折叠块**（`<details class="sync-advanced">`），其余默认全展开 | `SyncPanel.tsx:1168` |
| F8 | 窄屏规范分 5 节：**§3 小对话框→底部弹层**、**§4 大面板→全屏+内部滚动**（名单 = 设置/存储/插件管理/目录/AI/评论/插件面板） | `App.css:21971`、`App.css:22054` |
| F9 | **同步面板走 §3，不在 §4 的名单里** —— 但它的内容量级是 §4 的 | 同上 ＋ F2 |
| F10 | 手机的命中区**已经达标**：可见 5 个按钮，`<44px` 的 **0 个**（桌面反而 5 个全 `<44px`，鼠标无妨） | 实测 |
| F11 | 手机上 `.btn-sync` **共 3 个**（可见 1 个）；`App.tsx` 有**两处** `<SyncPanel/>`（主界面 `mobile-sync-slot` + 侧栏抽屉），注释称"两处入口互不影响" | `App.tsx:846`–`853`、`:852`；实测计数 |
| F12 | 验收门禁**现成**：`mobile-layout` / `mobile-overlays` / `mobile-views`，390×844 真 Chromium，**基线只增不减** | `scripts/lib/gates.mjs:335`–`339`、`tests/baseline.json` |

## 2. 问题定义（一句话）

> **容器选错了，不是内容太多了。**
> `App.css` §4 已经写明"底部弹层放不下、要待一会儿的面板一律整屏"，
> 而同步面板是**每空间一条长表单**（F6/F7）—— 它符合 §4 的描述，却排在 §3。

## 3. 四个选项（按"省多少 / 风险"排）

| # | 动作 | 省 | 风险 | 依据 |
|---|---|---|---|---|
| **A** | 空间卡在窄屏**折成一行摘要**（头像＋名字＋状态胶囊＋服务器主机），点开才展开表单 | **~500px** | 中（改 JSX ＋ CSS） | 唯一能**彻底消掉滚动**的一条 |
| **B** | `.sync-web-note` 收成一行 / 可关闭（存 localStorage） | 40–50px | 低 | F5：54px 常驻说明文 |
| **C** | `.sync-foot` 吸底（现为静态 134px，滚到底才可见） | 0，但**动作永远可达** | 低 | 与 §4「只有内容区滚动」同构 |
| **D** | 让同步面板走 **§4（全屏 + 内部滚动）** | 0（形态问题） | 低 | F8/F9；与设置/插件管理一致 |

**组合 A+B+C**：996 − 500 − 45 = **451px < 844px** ⇒ **零滚动**。

**只做 B+C+D**（不碰 JSX 结构）：滚动仍在，但常驻 chrome 变少、动作可达、形态与设置一致。

## 4. 明确**不做**的（边界，写下来免得后人"顺手补上"）

| 不碰 | 为什么 |
|---|---|
| `.space-privacy` / `SpacePrivacySection` | **加密相关**。`AGENTS.md` §12 把"动加密相关（国密 / SQLCipher / 密钥格式）"列为**必须先问** |
| `.sync-profiles.is-disabled` | 无活动空间（`activeId` 空）时的兜底渲染路径（`SyncPanel.tsx:336`–`343`）。要动先想清语义 |
| `.btn-sync` 的 3 个实例（F11） | **我只测了"可见 1 个"，没证明多渲染是问题。**要动先查清为什么是 3 个 |
| 任何"顺手把 `App.css` 那 5 节重排" | 那 5 节是**真事故驱动**的（§1 注释里逐条记着症状），重排等于把判据和事故脱钩 |

## 5. 验收判据（改完跑什么，不靠肉眼）

```bash
# 前置：先起 web dev server（mobile 组要 :5173）
pnpm dev:web

# 三条移动端门禁（390×844 真 Chromium）
node scripts/verify-mobile-layout.mjs
node scripts/verify-mobile-overlays.mjs
node scripts/verify-mobile-views.mjs

# 兜底：默认组必须全绿（改 SyncPanel.tsx 会碰 contract 组）
pnpm verify
```

**附加判据（本次新提，建议落成断言）**：

- **零滚动**：390×844 上 `.sync-popover` 的 `scrollHeight <= clientHeight`
  （现状 **996 > 819** ⇒ 若做 A+B+C，这条应当变绿）
- **常驻 chrome ≤ 150px**：`.sync-head` + `.sync-web-note` + `.sync-foot` 的高度和
  （现状 **254px**）
- **首屏可见操作**：折叠态下,"同步"主按钮与空间名必须同屏可见

> ⚠️ 这三条**目前没有门禁**。若采纳 A，建议**同时把它们写进 `verify-mobile-views.mjs`**，
> 否则"密度"又会退回成手感问题 —— 与本仓"能漂的数字不该手写在散文里"同一条口径。

## 6. 推荐

**先做 B+C+D**（低风险、不碰 JSX 结构、立刻改善常驻占用与形态），
**再单独一片做 A**（要改 `SyncPanel.tsx`，且应当附带 §5 那三条断言）。

**理由**：A 的价值最大但会改产品结构；B/C/D 是纯样式与形态调整，能在不动交互的前提下把
254px 常驻压到 ~200px 并让动作永远可达。**先把便宜的做掉，再动结构。**
