# 移动端高保真效果图（10 屏 / 12 个 SVG · 390×844 · SVG）

> **状态：设计稿（未接线，界面尚未实现）。** 本目录只有**效果图**，⛔ 不代表功能已做；
> 需求编号沿用同目录 [`2026-10-08-mobile-requirements.md`](../2026-10-08-mobile-requirements.md)（M-P0-x / M-P1-x / M-P2-x）。
> **事实来源**：`_tmp/scratch/mobile-facts.md`（2026-10-08 实测逐字读数，A–G 七节）。
> **配色/字号/圆角**一律取本产品自己的 [`design/design-system.md`](../../../../design/design-system.md) 深色列 token，⛔ 未自创品牌色、未新增主题。
> 屏内笔记标题/正文均为**示意文案**（效果图占位），不是任何真实数据。

## 1. 索引（10 屏 / 12 个 SVG —— 09 启动页为**最终方案 A／B／C**）

| 文件 | 屏名 | 它对应的需求 | 关键点（验收时看什么） |
|---|---|---|---|
| [`01-home.svg`](./01-home.svg) | 首页 · 三个入口 | **M-P0-1**（记一条）、M-P0-3（离线可记） | 只有三个入口：快速记录（--accent 主行动）／搜索／最近笔记；⛔ 无页面树、无侧边栏 |
| [`02-capture.svg`](./02-capture.svg) | 快速记录 | **M-P0-1**、M-P0-3 | 输入区 ＋ **键盘上方的快捷工具栏**（段落/标题/列表/待办/引用/图片）＋ 主按钮「存」；草稿态写明「保存在本机」 |
| [`03-search.svg`](./03-search.svg) | 搜索 | M-P1-5（只读查阅；形态**待量**，本图给出一种形态） | 搜索框 ＋ 结果列表，每条带命中片段高亮（当前命中 vs 其他命中两档底色） |
| [`04-read.svg`](./04-read.svg) | 阅读 | M-P1-5、**M-P0-2 的未收口边界** | 标题/段落/引用/图片占位；顶部返回 ＋「在电脑上继续」，并如实标注「同步通道尚未打通」 |
| [`05-todo.svg`](./05-todo.svg) | 待办勾选 | M-P2-2（跨端一致**待 mesh**） | 清单含已完成态（勾选＋删除线）与三档优先级色标（高=红/中=橙/低=绿，取分类色 token） |
| [`06-dict.svg`](./06-dict.svg) | 划词查词 | M-P2-1（阅读时查词） | 选中一段文字（--accent-soft 高亮＋选择手柄）后浮出释义卡片；卡片注明「释义来源：本机词典」 |
| [`07-settings.svg`](./07-settings.svg) | 设置 | M-P0-6（写入走应用授权通道；此处只做入口） | 极简四项：账户/同步/外观/关于；**高级入口明确写「请在桌面端操作」**（能力开关/MCP/插件） |
| [`08-pair.svg`](./08-pair.svg) | 设备配对 · 同步 | **M-P0-2**、M-P0-5（真机验收只能人看） | 附近设备 ＋ 配对暗号**只显示指纹前 8 位**（示例值）＋ 同步状态**如实写「尚未成功搬运」** |
| [`10-about.svg`](./10-about.svg) | 关于 | **M-P0-6**（审计与透明：许可/组件来源可核）＋ 非功能合规（隐私／备案占位） | 版本 1.92.5（开发）→ 本机优先/开源 → **许可 AGPL-3.0** → **开源组件致谢 12 项** → 链接（官网/源码/**隐私政策占位**）→ 检查更新＋导出诊断信息 → **备案号：待填（占位）** |

## 2. 逐屏

### 01 首页 · 三个入口

![首页：三个入口](./01-home.svg)

### 02 快速记录（键盘上方的快捷工具栏）

![快速记录：输入区与键盘上方的快捷工具栏](./02-capture.svg)

### 03 搜索（命中片段高亮）

![搜索：结果列表与命中片段高亮](./03-search.svg)

### 04 阅读（正文排版 ＋ 在电脑上继续）

![阅读：正文排版与在电脑上继续](./04-read.svg)

### 05 待办勾选

![待办勾选：已完成态与优先级标记](./05-todo.svg)

### 06 划词查词

![划词查词：选中文字后浮出的释义卡片](./06-dict.svg)

### 07 设置（高级入口指向桌面端）

![设置：极简四项与高级入口提示](./07-settings.svg)

### 08 设备配对 · 同步

![设备配对：指纹前 8 位与如实同步状态](./08-pair.svg)

### 09 启动页（Splash）

![启动页](./09-splash.svg)

- 方案（owner 已选定）：**发光的字标** —— 双层径向光晕把视线吸到产品名上，加载指示是一条细进度条（流动高光段 ＋ 笔尖光点）。
- 给谁用：所有人，每次冷启动的第一眼（首启体验）。相关需求：非功能／首启体验；与 **M-P1-3** 的启动图（`android:splash-theme` ⇄ `check:android:splash-theme`）相关。
- 文案依据：副标题「本机优先的笔记应用」与「你的笔记在本机 · 本地 SQLite 即可用」取自 `README.md` 徽章行；版本「1.92.5（开发）」取自 `package.json.version`。

### 10 关于（版本／许可／组件／链接）

![关于：版本、许可、开源组件与链接](./10-about.svg)

## 3. 两条硬口径（本套图刻意这么画的）

1. **配对暗号只给指纹前 8 位。** `08-pair.svg` 只画 `3F 9A 0C 7E`，并标注「仅显示指纹前 8 位（示例值，非完整暗号）」「完整指纹请在两端设备上各自核对」。⛔ 全目录**不存在**暗号 / 密钥 / `mesh_pair_secret` 原文。
   依据：读数（底稿 E，`mesh_pair_secret:<room>:<self>` 值长 **0**，即当前并无可用暗号 ⇒ 故按示例值画）。
2. **同步状态如实画「尚未成功搬运」，不假装已通。** `08-pair.svg` 的同步行写明三条读数：`mesh_cursor:*` 0 条 · `last_pushed_seq = last_pulled_seq = 0` · `mesh_paired_devices` 0 行；`04-read.svg` 的「在电脑上继续」也带「同步通道尚未打通」。`07-settings.svg` 同步行同口径。
   依据：读数（底稿 E；M-P0-2 的通道口径**待 owner 裁决**，效果图不替 owner 拍板）。

## 4. 用了哪些 token（逐字取 `design/design-system.md` 深色列）

| Token | 值 | 本套图用在哪 |
|---|---|---|
| `--bg` | `#17181A` | 屏幕底色、手机外框内底 |
| `--bg-sidebar` | `#1F2023` | 键盘底（02）、分段控件底（07） |
| `--surface` | `#242529` | 卡片、输入框、弹层（02/03/06/07/08/10） |
| `--border` / `--border-strong` | `#2E3034` / `#3A3C41` | 分隔线、卡片描边、手机外框 |
| `--text` / `--text-dim` / `--text-faint` | `#E6E8EB` / `#9CA3AF` / `#6B7280` | 主文字 / 次要 / 占位 |
| `--hover` / `--hover-strong` | `#2A2B2E` / `#34353A` | 图标底、键帽、悬停态 |
| `--accent` / `--accent-soft` / `--on-accent` | `#4D8DFF` / `#22304A` / `#0B1220` | 主行动、选中、焦点环；选中项浅底；09 的产品标记与加载条、10 的产品标记/主按钮 |
| `--success` / `--warning` / `--danger` | `#2BD49B` / `#FFB04D` / `#FF6B6B` | 完成进度条；同步告警；危险（预留） |
| `--mark-bg` | `#4A3F1F` | 07 高级入口条底（与 `--warning` 同用） |
| `--highlight-bg` / `--highlight-active-bg` | 深色列 `rgba(255,200,80,.45)` / `rgba(255,150,40,.6)` | 03 命中片段：普通命中 / 当前命中（SVG 里写等价形式 `#FFC850`＋`fill-opacity=".45"`、`#FF9628`＋`.6`） |
| 分类色 | 红 `#F54A45` · 橙 `#FF8A1E` · 绿 `#00B578` | 05 优先级标记（实色描边＋同色文字，不只靠颜色——另带「高/中/低」字） |
| `--fs-caption`…`--fs-h2` | 12 / 13 / 14 / 16 / 20 / 24 | 说明 / 次要 / UI / 正文 / 屏内标题 / 页面标题 |
| `--radius-xs`…`--radius-full` | 4 / 6 / 8 / 12 / 999 | 高亮块 / 按钮输入框 / 卡片弹层 / 大卡片 / chip pill |

字体族只写系统声明：`-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif`（等宽用 `'SF Mono', …, monospace`）。
⛔ 无外部字体、无外链资源、无 `@import`、无 `<image>` 外链、无 `<foreignObject>`。

## 5. 09／10 两屏的事实来源（逐字可核，⛔ 不许凭印象）

> 09 的**三个候选（A／B／C）共用同一批事实**（下表），差别只在视觉手法；因此三份屏上的文字与数字完全相同。

| 屏内写的 | 值 | 来源（文件:行 / 命令） |
|---|---|---|
| 版本 1.92.5（开发） | `1.92.5` | `package.json` 的 `"version"`（`python3 -c "import json;print(json.load(open('package.json'))['version'])"` ⇒ `1.92.5`） |
| 最新发布 1.92.6 | `1.92.6` | `docs/RELEASING.md:258`「已发布 **v1.92.6** 的发版说明那行已改成…」；旁证 `patches/README.md:150`、`docs/TESTING.md:119` |
| 许可 AGPL-3.0 | `AGPL-3.0` | `LICENSE:1-2`（`GNU AFFERO GENERAL PUBLIC LICENSE` / `Version 3, 19 November 2007`，全 661 行）＋ `README.md:465`「以 GNU Affero General Public License v3.0（AGPL-3.0）开源，全文见仓库根 `LICENSE`」 |
| 全文见仓库根 LICENSE（661 行） | 661 | `wc -l LICENSE` ⇒ `661 LICENSE` |
| 同步服务端为独立商业组件，不适用本许可 | — | `README.md:471`（同步服务端 shuyonote-sync-server 为独立商业组件，按其商业许可分发） |
| 本机优先 / 本地 SQLite | — | `README.md:21` 徽章 `数据-本地 SQLite 即可用`；`README.md:47`「本地优先…客户端 AGPL-3.0 开源」 |
| 开源组件 12 项（Tauri 2.11 / Lexical 0.50 / React 18.3 / Mermaid 11.17 / Excalidraw 0.18 / Yjs 13.6 / KaTeX 0.18 / PDF.js 4.8 / Zustand 5.0 / Tesseract.js 7.0 / DOMPurify 3.4 / i18next 26.4） | 版本号逐项取自 `package.json` 的 `dependencies` | `@tauri-apps/api ^2.11.1` · `lexical ^0.50.0` · `react ^18.3.1` · `mermaid ^11.17.0` · `@excalidraw/excalidraw 0.18.1` · `yjs 13.6.32` · `katex 0.18.4` · `pdfjs-dist ^4.8.69` · `zustand ^5.0.15` · `tesseract.js ^7.0.0` · `dompurify 3.4.14` · `i18next ^26.4.1`（**只写名字与版本，未声称其许可证**） |
| 共 34 项 dependencies | 34 | `python3 -c "import json;d=json.load(open('package.json'));print(len(d['dependencies']), len(d['devDependencies']))"` ⇒ `34 12` |
| 官网 shuyo.cn/app | `https://shuyo.cn/app/` | `README.md:32`（国内 / 自托管主站） |
| 源码 gitcode.com/shuyo-cn/ShuyoNote | `https://gitcode.com/shuyo-cn/ShuyoNote.git` | `README.md:70`（`git clone` 那行） |
| 隐私政策 待填（占位） | — | 全仓未找到面向用户的隐私政策 URL（只有内部文档 `docs/identity-privacy-model.md`）⇒ **按占位写**，不编 URL |
| 备案号：待填（占位） | — | 无依据 ⇒ 占位（同 `README.md` 未见备案号） |

启动页（09）在需求侧无独立编号：它属**非功能／首启体验**，并与 **M-P1-3**（应用身份件校验：启动图，读数：底稿 B 的 `android:splash-theme` ⇄ `check:android-splash-theme`）相关；若评审认为对不上，就按「补图，暂无对应编号」处理，⛔ 不硬凑。

## 6. 怎么复核这套图（命令 + 期望读数）

```bash
cd docs/plans/mobile/mockups

# ① 每份 SVG 必须能被 XML 解析（12/12 输出 ok）
for f in *.svg; do printf '%s ' "$f"; python3 -c "import xml.dom.minidom,sys; xml.dom.minidom.parse(sys.argv[1]); print('ok')" "$f"; done

# ② 画布必须是 390×844（期望 12 行 viewBox="0 0 390 844"）
grep -h -o 'viewBox="[^"]*"' *.svg | sort | uniq -c

# ③ 不许有的东西（期望三组都无输出）
grep -n -E "foreignObject|<!ENTITY|<image|@import|font-face" *.svg
grep -n -E "url\(" *.svg | grep -v 'url(#'          # 只许 url(#内部渐变)，别的一条都不许
grep -n -E "https?://" *.svg | grep -v "www.w3.org/2000/svg"

# ④ 元素只许是基础图元 + 渐变（期望 ["circle","defs","ellipse","g","linearGradient","path",
#    "radialGradient","rect","stop","style","svg","text","title"]）
python3 -c "import glob,xml.dom.minidom;t=set();[t.add(n.tagName) for f in glob.glob('*.svg') for n in xml.dom.minidom.parse(f).getElementsByTagName('*')];print(sorted(t))"

# ⑤ 渐变引用必须条条有定义（期望 BROKEN REFS: []）
python3 -c "
import glob,re
for f in sorted(glob.glob('*.svg')):
    s=open(f,encoding='utf-8').read()
    d=set(re.findall(r'<(?:radial|linear)Gradient[^>]*id=\"([^\"]+)\"',s)); u=set(re.findall(r'url\(#([^)]+)\)',s))
    print(f, 'BROKEN' if u-d else 'ok')
"
```

## 7. 本目录**没有**做的事（别读成已做到）

- ⛔ 本文不是需求说明书，也不是技术方案 —— 两份在 `../2026-10-08-mobile-requirements.md` 与 `../2026-10-08-mobile-tech-plan.md`。
- ⛔ 界面**未实现**：本目录只有 SVG，未跑 `pnpm` / `cargo` / 应用；三条 `test:mobile-*` 门禁**没有**因本目录而跑过。
- ⛔ **真机验收只能由人看**（M-P0-5，读数：底稿 F）：效果图不等于手感，截图不等于真机。
- ⚠️ 移动端立项本身**待 owner 裁决**（读数：底稿 G）；本套图只画「先窄后宽」里的最小切片形态，不替 owner 拍板。
- ⚠️ 新文档是否登记进 `docs/README.md`（仓内 AGENTS.md §13 / `check-doc-links`）：本目录的交付者**未越界**去改别的目录，留给 Lead 收口时决定。
