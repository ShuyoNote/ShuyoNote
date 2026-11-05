# 文件关联：双击 `.docx` 能唤起本应用 —— 但**不抢默认**（设计 ＋ 判据载体）

> 状态：**已落地（配置 ＋ 判据层）**
> 证据：`node scripts/check-nsis-template.mjs`（判据 a/b/c/d，见 §4）／`src-tauri/tauri.conf.json` 的 `bundle.windows.nsis.installerHooks`／`src-tauri/nsis/file-assoc-hooks.nsh`
> ⚠️ **未做安装验证**：本机没有 `makensis` 且发版打包归 Lead ⇒ 本文描述的一切**只到「配置 ＋ 判据」层**，没有"装完双击真的起来了"这个读数 ✗（见 §6）。

## 1. 一句话

资源管理器的「打开方式」里多一个 **ShuyoNote**，选中它就会带着文件路径唤起本应用并建页；
而「默认打开程序」**一个字都不动** —— 双击 `.docx` 仍然是你原来的 Word/WPS ✓。

## 2. 形状（为什么是 `installerHooks`，而不是 `fileAssociations`）

`tauri.conf.json` 只加一个键：

```json
"bundle": { "windows": { "nsis": {
  "template": "nsis/installer.nsi",
  "installerHooks": "nsis/file-assoc-hooks.nsh"
} } }
```

`installerHooks` 是 Tauri 官方键（`@tauri-apps/cli` 的 `config.schema.json` 原文：*"A path to a
`.nsh` file that contains special NSIS macros to be hooked into the main installer.nsi script"*，
支持 `NSIS_HOOK_PREINSTALL` / `POSTINSTALL` / `PREUNINSTALL` / `POSTUNINSTALL`）。我们 fork 的
`nsis/installer.nsi` **本来就已经**在头部 `!include` 它、并在安装/卸载各段 `!insertmacro` 这四个
hook ⇒ ⭐ **模板一个字都不用改**，那条"与上游只许差一行"的钉子（见 §5）不受影响。

### ⛔ 为什么**不用** `bundle.fileAssociations`

`fileAssociations` 在 Windows 上交给上游 `FileAssociation.nsh` 的 `APP_ASSOCIATE`，而它逐字是：

```nsis
!macro APP_ASSOCIATE EXT FILECLASS DESCRIPTION ICON COMMANDTEXT COMMAND
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "${FILECLASS}_backup" "$R0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "${FILECLASS}"   ; ← 把自己写成默认值
```

那个文件自己的注释也承认：*"…it is only meant to associate an application with a single file and
using the **\"open\" verb as default**"*。而 `nsis/installer.nsi` 里 **`OpenWithProgids` 零命中** ——
模板里根本没有"只加进打开方式"这条路。
⇒ `fileAssociations` = **抢默认** = 违反本仓的红线（§3）⇒ **弃用** ✓
（它唯一做对的是卸载还原：`APP_UNASSOCIATE` 会把 `${FILECLASS}_backup` 写回默认值 —— 但那条路我们不走。）

## 3. 两条红线（判据 b 钉的就是它们）

1. **绝不写** `Software\Classes\.<ext>` 的**默认值（空值名）**。写它 = 把用户双击 `.docx` 时
   打开的程序改成我们 = **抢掉 Word** ✗
2. 卸载时**不删** `Software\Classes\.<ext>` 的默认值 —— 我们从头到尾没写过它；
   去删等于**破坏别人的**关联 ✗

⇒ 只写两处，且卸载精确删掉这两处：

| 写什么 | 装 | 卸 |
|---|---|---|
| `Software\Classes\<ProgID>`（自有类键：类型列显示名 ＋ `shell\open\command`） | `WriteRegStr` | `DeleteRegKey` |
| `Software\Classes\.<ext>\OpenWithProgids\<ProgID>`（**只**"可以用它打开"） | `WriteRegStr … "" ""` | `DeleteRegValue` ＋ `DeleteRegKey /ifempty` |
| `Software\Classes\.<ext>` 的默认值 | ⛔ **不写** | ⛔ **不删** |

`DeleteRegKey /ifempty` 保证**别人的** `OpenWithProgids` 条目还在时不会把整个键扫掉 ✓
落点用 `SHCTX`（跟随 `installMode=currentUser` ⇒ **HKCU**，不碰 HKLM）✓

登记的扩展名只取导入引擎**真的支持**的四个（源码行号）：`.docx`（`src/lib/extract/ooxml.ts:564`）、
`.xlsx`（`:571`）、`.pptx`（`:578`）、`.md`（`src/lib/extract/text.ts:32-33`）。
`.doc` / `.xls` / `.ppt` 三个旧格式（`legacy.ts`）这一轮**不登记**。

## 4. 判据（`node scripts/check-nsis-template.mjs`）

| # | 判据 | 挡的是什么 |
|---|---|---|
| a | `bundle.windows.nsis.installerHooks` 非空、文件存在，且登记的扩展名里**有 `.docx`**，每个扩展名都有 `OpenWithProgids` ＋ `shell\open\command` | 关联"以为配了其实没配"（旧行为下必红） |
| b | **反向**：`bundle.fileAssociations` 必须**不存在**；`.nsh`（**剥掉注释后**）**不许**出现 `WriteRegStr … "Software\Classes\.${EXT}" "" …` 这种写默认值的形态 | 抢默认程序的字段/写入悄悄回来 |
| c | 卸载段（`NSIS_HOOK_POSTUNINSTALL`）必须把我们登记的两处都清掉 | 卸载后留孤儿关联 |
| d | 我们定义的每个 `!macro NSIS_HOOK_*` 必须是 Tauri 支持的四个之一，且 `installer.nsi` 里**真的** `!insertmacro` 了它；模板 `!include` `FileAssociation.nsh` 必须早于 `!include` installerHooks 文件 | hook 名字写错 ⇒ 模板 `!ifmacrodef` **静默不插入**；`UPDATEFILEASSOC` 未定义 ⇒ 编译不过 |

判据 b 与 d 都做过**真变异**（改坏那一处 ⇒ 用例变红），读数记在
`_workspace/mutation-evidence.json` 的 `repos/ShuyoNote/scripts/check-nsis-template.mjs` 条目里 ✓

## 5. 为什么不改 `nsis/installer.nsi`

它是**故意 fork** 的上游模板（只为改默认安装目录那一行），由 `check-nsis-template.mjs` 钉成
"与上游逐字节相同、只许差那一行"（头部还记着 `upstream-sha256` 与 `cli-version`）。
⇒ 任何往安装器里加的**新**逻辑都必须走 `installerHooks` 那个 `.nsh`，**不许**动模板 ✗

## 6. ⚠️ 没做到的（如实）

- **没做安装验证**：没跑 `tauri build` / NSIS 打包（归 Lead；且本机 `tauri dev` 正在跑，
  任何 build 都会换掉正在用的 exe）⇒ **没有"装完双击 `.docx` 真的建了页"这个读数** ✗
- **`.nsh` 未在本机编译验证**：本机没有 `makensis` ✗。降风险的办法是**只用上游那两份文件里
  出现过的 NSIS 命令与 define**（`WriteRegStr` / `DeleteRegValue` / `DeleteRegKey`＋`/ifempty`
  / `SHCTX` / `UPDATEFILEASSOC`），并显式避开 `WriteRegNone`（上游 0 次命中）。
  可 grep 复核；**但这不等于编译过** ✗
- **没做真卸载读数**：卸载还原只在配置与模板层核（模板 `APP_UNASSOCIATE` 的还原逻辑 ＋ 本 hook
  的精确清理），没有"装一次再卸一次、注册表干净"的实机读数 ✗

## 7. 2026-11-05：`.md` 打开改为**内置只读阅读器**（owner 拍板）

`.md` / `.markdown` 与 `.docx` 一样通过 `--import` / 文件打开事件唤起，但前端在
`OfficeImportPanel` 的事件分流里**先截住 Markdown**（`lib/markdownFile.ts` 的 `isMarkdownPath`）：

- **打开 ≠ 导入**：直接在**主阅读区**渲染 `MarkdownFilePreview`（`App.tsx` 的 `markdownPath` 分支），
  **不建页、不写库、不把图片入库**；关闭后回到打开前的页面/视图。
- **形态**：只作为主阅读区的**内联**内容渲染（`.markdown-file-preview-page`），
  ⛔ 没有 portal、没有遮罩、不登记浮层栈 ⇒ `verify-mobile-overlays.mjs` 里原先那层
  `markdownFilePreview` 已删（它不再是浮层）。
  ⚠️ **Android 返回键**因此不再由预览接管（`useOverlayLayer` 已移除）；
  若真机上「预览态按返回键应先关预览」，需要另立一项并补判据 —— **目前没有这条读数**。
- 预览按 `.md` 所在目录读取相对图片（`api.readBinaryFile` → blob URL），
  `mdToHtml` 渲染 + `DOMPurify` 消毒；外链/data URL 原样保留。
- 右侧目录取 h1–h3（点击平滑跳转，窄屏隐藏），路径行固定高度、不参与 flex 压缩。
- 顶部有 **「设为默认」**（打开系统默认应用页并给出口径，**不静默改默认关联**）
  和 **「导入为笔记」**（显式复制；源文件不写回）。
- 本地相对图片内联为 data URL（单张 ≤2 MB、总量 ≤8 MB），不把本地绝对路径带进库里。
- 渲染器补齐了常被 Markdown 文档用到的 GFM/CommonMark 子集：setext 标题、
  任务列表（只读勾选框）、autolink；表格/围栏代码/Mermaid/引用/相对图片沿用原实现。
- 平台：
  - Windows 继续走 NSIS 的 `installerHooks`（只加「打开方式」候选，不抢默认）。
  - macOS / Linux 走 `tauri.macos.conf.json` / `tauri.linux.conf.json` 的
    `bundle.fileAssociations`（`role: Viewer`, `rank: Alternate`，也只作候选）。
  - macOS 冷/热启动的 `RunEvent::Opened` 与 Windows/Linux 的裸路径 argv
    都收敛到 `office_import` 的同一个队列/事件。
- 判据：`src/lib/markdownFile.test.ts`（路径/标题/相对资源/目录）、
  `src/lib/office/requestBridge.test.ts`（md 先分流、不进 Office）、
  `src/editor/mdToHtml.test.ts`（setext / 任务列表 / autolink）。

⚠️ 当前没有做「静默把 `.md` 默认程序改成 ShuyoNote」：那是系统级选择，只给引导，不代用户决定。
