# 示例插件

这里的每个插件都**可以直接装来用**，同时是插件 API 的参考实现与回归测试：CI 会用作者 CLI
校验、用类型包做 `tsc` 类型检查，`cargo test` 还会用**与加载器同一条路径**验证它们
「真的能加载并注册出命令」——所以它们不会随时间烂掉。

分两类：**能用的插件**（第一批一方插件，演示「一个插件长什么样才值得装」）与**教学示例**
（把某个 API 用法讲清楚，功能本身可以很简单）。

## 能用的（一方先行）

| 插件 | 它干什么 | 用到的能力 |
|---|---|---|
| [`weekly-review/`](weekly-review/) | **周回顾**：一键把最近 N 天动过的页面汇成一篇「回顾」草稿（标题清单 + 统计）；天数/条数走**命令参数表单**，没填就退回插件设置 | `pages.list` / `pages.create`（草稿）/ 参数 / 设置 |
| [`page-to-md/`](page-to-md/) | **当前页导出 Markdown**：命令面板点「导出」，把当前打开的页面写成一份 `.md`（保存位置由你选） | `blocks.list`（省略 pageId = 当前页）/ `files.export`（用户选位置） |
| [`eye-care-theme/`](eye-care-theme/) | **护眼主题**：暖白背景 + 降蓝正文，长时间读写不那么累（零代码） | 主题 token |
| [`high-contrast-theme/`](high-contrast-theme/) | **高对比主题**：纯黑纯白，投屏 / 投影 / 视力不佳时看得清（零代码） | 主题 token |
| [`stale-triage/`](stale-triage/) | **陈旧页巡检**：找出 N 天没更新的页面，一次性地给它们打 #待整理——**一次运行产出多条草稿**，汇总成一次确认 | `pages.list` / `tags.list` / `tags.add`（草稿）
| [`orphan-pages/`](orphan-pages/) | **孤立页面巡检**：逐页查反向链接，找出没人链过去的「孤岛」，生成清单草稿 | `pages.list` / `backlinks.list` / `pages.create`（草稿）
| [`csv-table/`](csv-table/) | **CSV 转表格**：选中 `.csv` / `.tsv` → 转成 Markdown 表格放进一篇新页面（导入触发 + 引号/换行的容错解析） | 导入触发 / `pages.create`（草稿）
| [`page-status/`](page-status/) | **页面状态**：给当前页一键标状态（待办/进行中/已完成）——**有「状态」属性就写属性，没有就用同名标签兜底**，用户永远知道走的是哪条路 | `properties.list` / `properties.set`（草稿）/ `tags.add`（草稿） |
| [`search-collect/`](search-collect/) | **检索汇总**：用关键词检索本空间，把命中整理成一页清单草稿（资料收集时省事） | `pages.search` / `pages.create`（草稿） |
| [`activity-digest/`](activity-digest/) | **活动摘要**：把「同步完成」「附件导入完成」这两件**后台**事记成一条摘要——日志里能看到每一条明细，同步真有推拉时提示一次（同步是后台上传，界面上看不到它到底动没动） | 事件 `sync.completed` / `import.finished` / `log.write` / `user.notify`（免权限）/ `kv:own` |
| [`reading-board/`](reading-board/) | **阅读看板**：一张「最近更新」**浮层**表（查询条件引用用户设置）+ 一个「本月新增」**右侧常驻面板**（`placement: "rail"`）——零代码也能「用户可配」，也能常驻 | 无（声明式视图） |

## 教学示例

| 示例 | 演示什么 | 用到的能力 |
|---|---|---|
| [`attachment-report/`](attachment-report/) | **文件右键菜单**（`file.context`）：报告被右键那个附件的名字/大小/类型，以及它在所属页里排第几——演示"入参由宿主给"的入口（**没有路径**） | `files.list` |
| [`reading-stats/`](reading-stats/) | 最小只读插件：一项低风险权限，读当前空间的页面 | `pages.count` / `pages.list` |
| [`daily-note/`](daily-note/) | **写能力走草稿确认** + 插件私有数据（按空间隔离、随空间加密） | `pages.create`（草稿）/ `kv.get` / `kv.set` |
| [`tidy-tags/`](tidy-tags/) | 先读后写；省略 `pageId` 时作用于**当前打开的页面** | `tags.list` / `tags.add`（草稿） |
| [`md-outline/`](md-outline/) | **导入触发**（manifest `triggers`）：用户选文件 → 宿主读内容 → 插件拿到 `{ fileName, content }`；写能力照样出草稿 | `pages.create`（草稿） |
| [`index-export/`](index-export/) | **导出**（`api.files.export` + `kind: "export"` 触发）：命令产出内容，用户在系统保存对话框里选存到哪里；插件给不出路径，点取消就什么都没写 | `pages.list` / `files.export`（用户选位置） |
| [`warm-night/`](warm-night/) | **零代码主题插件**的最小形态：只出一组设计变量，停用即恢复 | 无（没有代码） |

## 怎么跑起来

1. 把某个示例目录整个复制到插件目录：应用内「插件管理 → 打开插件目录」，
   粘贴到 `plugins/` 下（目录名必须与 `manifest.json` 里的 `id` 一致）；
2. 面板里点「校验」——通过即可「启用」；
3. 命令面板（`Ctrl+K`）里搜命令名执行。写能力会先给你一份**草稿**，你确认后才落库。
   声明了**触发**的插件会在这里多出对应入口：`md-outline` 是「导入：用「插件名」打开 .md」
   （点了选文件，宿主把内容读出来交给插件），`index-export` 是「导出：用「插件名」保存为 .md」
   （跑完命令后弹系统保存对话框，用户点保存才写）。

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

> **事件钩子要两处都在才算数**：manifest 的 `events` 声明（用户启用前看得到）+ `main.js` 里的
> `on(...)` 注册。`reading-stats` 是 `page.opened` 的最小例子，`activity-digest` 演示两个
> **后台**事件（`sync.completed` / `import.finished`）——用户没做任何动作时插件也会被叫醒。
