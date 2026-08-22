# 插件（Plugin）功能实现方案

> 目标：把 ShuyoNote 现在的「硬编码命令注册表」升级为**可安装的插件系统**——插件从本地目录加载、受**受限 API** 与**沙盒**约束、可启停/卸载/持久化。首期做 **L1（磁盘加载的命令插件 + 白名单 API）**，UI 型插件（L2）与市场（L3）延后。

## 1. 背景与竞品对照

| 竞品 | 插件能力 | 关键点 |
|------|----------|--------|
| Obsidian | Community plugins | 社区插件市场、插件加载器、核心 API（文件/编辑器/视图）、`manifest.json` + `main.js` |
| Logseq | 插件系统 | 类 Obsidian，`package.json` + 命令/UI 插件 |
| Notion | 无插件（API 集成） | 生态走 API，非客户端插件 |
| ShuyoNote 现状 | 命令注册表 | `src/plugins/registry.ts`：内置插件硬编码 `{id,name,commands[]}`；命令在命令面板展示；`enabled` 开关存在但**存内存、重启即失**；**无磁盘扫描/安装/加载** |

**结论**：插件是「可扩展性」的大头。ShuyoNote 已有「命令 + 启停」的最小雏形，缺的是**从磁盘加载**与**安全约束**。首期聚焦「命令插件」，把「插件从代码里解放出来」做通。

## 2. 现状盘点（代码已核实）

| 位置 | 现状 | 问题 |
|------|------|------|
| `src/plugins/registry.ts` | `Plugin{id,name,commands[]}`；`PluginCommand{id,title,description?,closeOnRun?,run(ctx)}`；`CommandContext{pages,currentId}` | 命令是纯函数、返回结果字符串；插件**硬编码**在文件里 |
| `usePluginState.enabled` | zustand，`enabled[id]` | **不持久化**，重启即恢复默认开启 |
| `registerPlugin` | 内存 `registry.push` | 只支持启动时代码注册，不能运行时安装/卸载 |
| 命令面板 | `getEnabledPlugins()` 过滤后分组展示 | 唯一插件出口 |

## 3. 核心概念：能力分层

| 层级 | 能力 | 说明 | 现状 |
|------|------|------|------|
| **L0 命令** | 注册命令进面板，执行返回信息 | 已有 | ✅ |
| **L1 命令插件** | 从本地插件目录扫描 `manifest` 加载命令，可启停/卸载 | **本期目标** | ❌ |
| **L2 UI 插件** | 贡献侧栏/工具栏/自定义块/数据库视图/设置面板/主题 CSS | 需沙盒 WebView 承载 | ❌ 延后 |
| **L3 市场** | 插件商店、更新、签名、信任评分 | 平台级 | ❌ 延后 |

> 本期只做 **L1**：安装式「命令插件 + 白名单 API」。安全面最小、价值最大。

## 4. 安全 / 沙盒选型（决定一切）

插件代码会执行，**最大风险是读写文件、任意后端命令、网络、改应用状态**。可选：

| 方案 | 做法 | 取舍 |
|------|------|------|
| **A. 受限运行时 + 白名单 API**（推荐） | 用 Rust 侧 **QuickJS / Boa** 执行 `main.js`，只暴露 `api` 白名单对象；无 DOM、无任意 fs、无网络 | 安全、无 UI；适合 L1 命令插件 |
| B. 沙盒 WebView/iframe | UI 插件在隔离 WebView 跑，`postMessage` 桥接白名单 API | 能贡献 UI，但复杂、桥接成本高 |
| C. 直接注入 renderer（Obsidian 式） | 插件跑在应用 renderer，访问插件 API | 简单，但**等同信任插件**，安全弱；ShuyoNote 本地优先不宜默认 |

> **本期采用 A**：命令插件在受限 JS 运行时内执行，只拿到 `api` 白名单对象。L2 再做方案 B。

## 5. 插件形态（L1）

### 5.1 目录结构
```
%APPDATA%/ShuyoNote/plugins/<plugin-id>/
├── manifest.json
└── main.js
```

### 5.2 `manifest.json`（白名单字段，防路径注入）
```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "description": "…",
  "author": "…",
  "main": "main.js",
  "apiVersion": "1"
}
```
> 校验：`id` 必须等于目录名、`main` 为相对安全路径、禁用危险字段。

### 5.3 `main.js` 契约
```js
// 导出 register(ctx) → 返回 { commands: [...] }
module.exports.register = (api) => {
  return {
    commands: [
      {
        id: "my-plugin.say",
        title: "你好",
        description: "…",
        closeOnRun: false,
        run: async (ctx) => "你好，ShuyoNote！",
      },
    ],
  };
};
```

### 5.4 命令 API（白名单，仅这些）
`ctx.pages` / `ctx.currentId`（同现有 `CommandContext`）
`api.getCurrentPage()` / `api.listPages()` / `api.search(q)` / `api.listTags()`
`api.insertBlock(text?)` / `api.toast(msg)` / `api.getSetting/setSetting(key, val)`
> 明确**不给**：`fetch`、任意 `fs`、`navigator`、`require('fs')`、`window`、`document`、全量后端 `invoke`。

## 6. 后端实现（Rust）

| 模块 | 职责 |
|------|------|
| `src-tauri/src/plugin_loader.rs` | 扫描插件目录、解析 `manifest.json`、校验安全字段 |
| `src-tauri/src/plugin_runtime.rs` | 内嵌 **Rquickjs/QuickJS（或 Boa）** 运行时，执行 `main.js`，注入受限 `api` 对象 |
| `src-tauri/src/commands.rs` | `list_plugins` / `install_plugin(path)` / `uninstall_plugin(id)` / `toggle_plugin` / `set_plugin_enabled` |
| 迁移 | 插件启用状态持久化（**本地 DB / app_settings**，替代内存） |

> 安全：运行时阻断 `require`/`eval` 全局、剥离 `window`/`document`，仅注入 `api` 白名单；插件 `run` 返回 JSON 字符串，由 Rust 回传前端。

## 7. 前端设计

### 7.1 命令注册表升级
- `registerPlugin` 支持从「磁盘加载的插件」并入；内置插件也统一走 manifest 机制。
- 命令面板：插件命令按**插件名分组**展示（已具备），禁用即隐藏。

### 7.2 插件管理面板
- 「插件管理」入口（侧栏 / 命令面板）：列表（名称/版本/作者/启用开关/卸载）、从文件夹导入、打开插件目录。
- 启用状态读写持久化（`set_plugin_enabled`），重启不丢。

### 7.3 加载与刷新
- 启动时 `plugin_loader` 扫描并加载到注册表；`toggle_plugin` 即时生效（命令面板重新过滤）。

## 8. 生命周期与持久化
- **启用/禁用**：持久化到 DB（`app_settings` 键值或 `plugin_state` 表）；默认启用。
- **安装**：`install_plugin(path)` 复制目录到插件目录 → 扫描加载。
- **卸载**：`uninstall_plugin(id)` 删除目录 + 清注册表 + 关靠它。
- **版本/更新**：L1 只做「检测 manifest.version 不符提示」，不做自动更新。

## 9. 实施顺序（里程碑）

- **M1（插件底座）**：插件目录扫描 + manifest 解析校验 + **QuickJS/Boa 受限运行时 + 白名单 API** + 命令并入注册表 + `enabled` 持久化。验收：从插件目录装一个「命令插件」，命令出现在面板、可启停、重启仍生效（不再内存丢失）。
- **M2（管理 + 生命周期）**：插件管理面板（列表/导入/卸载/打开目录）+ `activate/deactivate` + 版本提示。验收：能安装/卸载/启停/导出插件。
- **M3（可选 L2）**：UI 型插件（沙盒 WebView + postMessage 桥），贡献侧栏/工具栏/设置面板。
- **M4（可选 L3）**：插件市场 / 签名 / 信任评分。

## 10. 测试与验收标准

- [ ] 插件目录放一个带 `manifest.json` + `main.js` 的命令插件，启动后被加载并在命令面板显示。
- [ ] 插件命令执行正常返回结果；命令面板按插件分组、可启停。
- [ ] **启用状态持久化**：重启后仍保持之前启停（修复当前内存丢失）。
- [ ] 插件无法访问 `fetch`/任意 fs/`window`/`document`/全量 `invoke`（安全回归）。
- [ ] 不安全 manifest（路径越界、`main` 异常）被拒载并给出提示。
- [ ] 卸载插件后命令消失、不残留；内置插件不可卸载（或标记 built_in）。
- [ ] `toggle_plugin` 即时生效（命令面板重新过滤）。
- [ ] 多空间下插件为应用级，不随空间切换影响。

## 11. 风险与取舍

- **安全是门槛**：必须用受限运行时 + 白名单 API，别让插件直接进 renderer。这是「本地优先」应用的红线。
- **别一上来做 L3 市场**：先 L1 跑通，再谈签名/评分/商店。
- **QuickJS/Boa 选型**：QuickJS 成熟、内存可控；Boa 纯 Rust 无 C 依赖。需评估体积与构建成本，选一即可。
- **命令是插件最小稳定面**：先把「从磁盘加载命令 + 持久化状态」做扎实，UI 插件（L2）需要额外沙盒桥，复杂度陡增，放后面。
- **内置插件同一机制**：别让内置插件走特权旁路，统一走 manifest + API，保证行为一致。

## 12. 结论

插件是 ShuyoNote「可扩展性」的长期抓手。首期做 **L1（磁盘加载的命令插件 + 受限 API + 持久化启停）**，把安全（受限运行时 + 白名单）作为硬门槛；UI 插件（L2）与市场（L3）作为后续可选扩展，避免过早铺开跨平台/市场的复杂度。
