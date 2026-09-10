# 示例插件

可直接抄的插件，覆盖插件 API 的主要用法。**它们同时是回归测试**：CI 会用作者 CLI
校验、并用类型包做 `tsc` 类型检查，`cargo test` 还会用**与加载器同一条路径**验证它们
「真的能加载并注册出命令」——所以这些示例不会随时间烂掉。

| 示例 | 演示什么 | 用到的能力 |
|---|---|---|
| [`reading-stats/`](reading-stats/) | 最小只读插件：一项低风险权限，读当前空间的页面 | `pages.count` / `pages.list` |
| [`daily-note/`](daily-note/) | **写能力走草稿确认** + 插件私有数据（按空间隔离、随空间加密） | `pages.create`（草稿）/ `kv.get` / `kv.set` |
| [`tidy-tags/`](tidy-tags/) | 先读后写；省略 `pageId` 时作用于**当前打开的页面** | `tags.list` / `tags.add`（草稿） |
| [`md-outline/`](md-outline/) | **导入触发**（manifest `triggers`）：用户选文件 → 宿主读内容 → 插件拿到 `{ fileName, content }`；写能力照样出草稿 | `pages.create`（草稿） |
| [`reading-board/`](reading-board/) | **零代码插件**（`runtime: "declarative"`）：只有 manifest，宿主按声明查询并渲染视图；查询条件**引用用户设置**（`{ "fromSetting": "…" }`），所以零代码也能「用户可配」 | 无（没有代码） |
| [`warm-night/`](warm-night/) | **零代码主题插件**：只出一组设计变量，停用即恢复 | 无（没有代码） |

## 怎么跑起来

1. 把某个示例目录整个复制到插件目录：应用内「插件管理 → 打开插件目录」，
   粘贴到 `plugins/` 下（目录名必须与 `manifest.json` 里的 `id` 一致）；
2. 面板里点「校验」——通过即可「启用」；
3. 命令面板（`Ctrl+K`）里搜命令名执行。写能力会先给你一份**草稿**，你确认后才落库。
   声明了**导入触发**的插件会在这里多出一条「导入：用「插件名」打开 .md」：点了选文件，
   宿主把内容读出来交给插件（`md-outline` 就是这么工作的）。

开发时不必重启：面板打开期间，插件目录一有改动就会**自动重新扫描**（面板标题会显示
「已自动重新扫描 …」）。

## 在编辑器里写插件

```bash
pnpm plugin:validate examples/plugins/daily-note   # 命令行对照检查
pnpm check:examples                                # 类型检查（tsc）
```

类型补全见本目录的 [`tsconfig.json`](tsconfig.json)：脚本式插件（非模块）靠
`packages/plugin-types/globals.d.ts` 拿到 `api` 与 `register` 的全局声明。

> 命令行里的 JS 语法由 V8 检查，应用里跑的是 Boa，两者对新语法宽容度可能不同。
> **以应用内「校验」为准**（它用的是同一个 Boa 与同一个 manifest 解析）。

完整的作者文档见 [`docs/plugin-api.md`](../../docs/plugin-api.md)。
