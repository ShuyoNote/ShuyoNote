# 插件 API（v1.0.0）

> 本文件由 scripts/gen-capabilities.mjs 生成（源：capabilities/capabilities.json）——请勿手改。
> 本文面向**插件作者**：只要读这一份就能写出可安装、可运行的插件，不需要读源码。

## 1. 最小插件（20 行）

插件是磁盘上的一个目录，放在应用数据目录的 `plugins/<插件 id>/` 下（也可用「插件管理 → 从文件夹安装」）：

```
plugins/my-plugin/
├── manifest.json
└── main.js
```

`manifest.json`：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "description": "一句话说明",
  "apiVersion": "1.0.0",
  "main": "main.js",
  "permissions": [
    { "id": "read:pages", "reason": "为了在提示里显示本空间页面数" }
  ]
}
```

`main.js`：

```js
register({
  id: "my-plugin.hello",
  title: "打个招呼",
  description: "显示本空间页面数",
  closeOnRun: false,
  run: function () {
    api.log("开始执行");
    api.notify("本空间共 " + api.pages.count() + " 个页面");
    return "完成";
  },
});
```

要点：

- `id` 必须**等于目录名**，且只能是小写字母、数字与 `-`；
- `main` 只能是同级文件名（`main.js` 或 `./main.js`）；
- 每次执行都会**重新 eval** 插件代码并新建一个沙箱 —— 不要在顶层做耗时工作；
- 返回的字符串会显示在命令面板底部；`closeOnRun: true` 执行后关闭面板。

## 2. manifest 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 插件 id，必须等于目录名；单段 `[a-z0-9-]` |
| `name` | ✅ | 显示名 |
| `version` | 建议 | 插件自身版本 |
| `description` | 建议 | 一句话说明 |
| `apiVersion` | ✅ | 本插件针对的 API 版本（当前 `1.0.0`）；主版本不被支持时会被拒载 |
| `main` | | 入口文件，默认 `main.js` |
| `permissions` | ✅ | 见下节；**不写 = 默认零能力**（v1 之前的老插件会得到基线授权并收到警告） |

## 3. 权限

权限必须在 manifest 里**逐条声明**，安装/启用时会把「权限 + 理由」展示给用户；
运行时由宿主**逐次调用校验**——没声明的权限，调用会失败（不是被隐藏）。

```json
"permissions": [
  { "id": "read:page.current", "reason": "为当前页生成摘要" }
]
```

| 权限 id | 说明 | 风险 |
|---|---|---|
| `read:page.current` | 读取当前页正文：读取当前打开页面的 content_json | low |
| `read:pages` | 读取本空间页面统计：读取本空间的页面数量等汇总信息（不含正文） | low |
| `write:page.current` | 向当前页写入纯文本：往当前页面插入一段纯文本（不接受 HTML/Markdown，不可删改既有内容） | low |
| `read:tags` | 读取本空间标签：读取本空间的标签清单（名称与关联页面数） | low |
| `read:backlinks` | 读取反链：读取哪些页面引用了某个页面 | low |
| `read:files` | 读取附件元数据：读取页面的附件元数据（名称/类型/大小），**不含文件字节** | low |
| `kv:own` | 存储自己的数据：在插件自己的命名空间里读写键值（与其他插件、与笔记数据互不可见） | low |

## 4. 能力（`api.*`）

| 能力 | 签名 | 需要权限 | scope | 返回 | 自 |
|---|---|---|---|---|---|
| `page.current` | `api.page.current()` | `read:page.current` | `current-space` | string | 1.0.0 |
| `pages.count` | `api.pages.count()` | `read:pages` | `current-space` | number | 1.0.0 |
| `pages.list` | `api.pages.list(limit)` | `read:pages` | `current-space` | array | 1.0.0 |
| `pages.get` | `api.pages.get(id)` | `read:pages` | `current-space` | object | 1.0.0 |
| `pages.search` | `api.pages.search(q, limit)` | `read:pages` | `current-space` | array | 1.0.0 |
| `tags.list` | `api.tags.list()` | `read:tags` | `current-space` | array | 1.0.0 |
| `backlinks.list` | `api.backlinks.list(pageId)` | `read:backlinks` | `current-space` | array | 1.0.0 |
| `files.list` | `api.files.list(pageId)` | `read:files` | `current-space` | array | 1.0.0 |
| `editor.insertText` | `api.editor.insertText(text)` | `write:page.current` | `current-space` | void | 1.0.0 |
| `user.notify` | `api.notify(message)` | — | `app` | void | 1.0.0 |
| `kv.get` | `api.kv.get(key, scope)` | `kv:own` | `app` | string | 1.0.0 |
| `kv.set` | `api.kv.set(key, value, scope)` | `kv:own` | `app` | void | 1.0.0 |
| `kv.remove` | `api.kv.remove(key, scope)` | `kv:own` | `app` | void | 1.0.0 |
| `log.write` | `api.log(message, level)` | — | `app` | void | 1.0.0 |

### `page.current` — 读取当前页

- 调用：`api.page.current()`
- 权限：`read:page.current`
- scope：`current-space`
- 返回：当前页的 content_json 原始字符串（未解析；插件自行 JSON.parse）

### `pages.count` — 本空间页面总数

- 调用：`api.pages.count()`
- 权限：`read:pages`
- scope：`current-space`
- 返回：本空间未删除页面的数量

### `pages.list` — 列出本空间页面

- 调用：`api.pages.list(limit)`
- 权限：`read:pages`
- scope：`current-space`
- 返回：[{id, title, updated_at}]，按更新时间倒序；不含正文
- 参数：
  - `limit`: `number`（可选），默认 `50` —— 最多返回多少条（上限 200）

### `pages.get` — 读取指定页面

- 调用：`api.pages.get(id)`
- 权限：`read:pages`
- scope：`current-space`
- 返回：{id, title, content_text, kind}；不存在返回 null
- 参数：
  - `id`: `string` —— 页面 id

### `pages.search` — 搜索本空间页面

- 调用：`api.pages.search(q, limit)`
- 权限：`read:pages`
- scope：`current-space`
- 返回：[{id, title, snippet}]；v1 是子串匹配，不做相关度排序
- 参数：
  - `q`: `string` —— 关键词
  - `limit`: `number`（可选），默认 `20` —— 最多返回多少条（上限 100）

### `tags.list` — 列出本空间标签

- 调用：`api.tags.list()`
- 权限：`read:tags`
- scope：`current-space`
- 返回：[{id, name, page_count}]

### `backlinks.list` — 列出反链

- 调用：`api.backlinks.list(pageId)`
- 权限：`read:backlinks`
- scope：`current-space`
- 返回：[{source_page_id, source_title, kind}]
- 参数：
  - `pageId`: `string`（可选） —— 目标页面 id；省略则用当前打开的页面

### `files.list` — 列出页面附件元数据

- 调用：`api.files.list(pageId)`
- 权限：`read:files`
- scope：`current-space`
- 返回：[{id, name, mime, size}]，**不含字节**
- 参数：
  - `pageId`: `string`（可选） —— 页面 id；省略则用当前打开的页面

### `editor.insertText` — 向当前页插入纯文本

- 调用：`api.editor.insertText(text)`
- 权限：`write:page.current`
- scope：`current-space`
- 参数：
  - `text`: `string` —— 要插入的纯文本

### `user.notify` — 向用户显示一条提示

- 调用：`api.notify(message)`
- 权限：无需权限
- scope：`app`
- 返回：执行结束后随结果一起弹给用户
- 参数：
  - `message`: `string` —— 提示内容

### `kv.get` — 读插件私有数据

- 调用：`api.kv.get(key, scope)`
- 权限：`kv:own`
- scope：`app`
- 返回：存过的字符串；键不存在返回 null
- 参数：
  - `key`: `string` —— 
  - `scope`: `string`（可选），默认 `space` —— space（默认，随空间加密）或 app（应用级，明文，勿放敏感信息）

### `kv.set` — 写插件私有数据

- 调用：`api.kv.set(key, value, scope)`
- 权限：`kv:own`
- scope：`app`
- 返回：立即写入（不走草稿确认：只动插件自己的数据，不碰笔记内容）
- 参数：
  - `key`: `string` —— 
  - `value`: `string` —— 
  - `scope`: `string`（可选），默认 `space` —— space（默认）或 app

### `kv.remove` — 删插件私有数据

- 调用：`api.kv.remove(key, scope)`
- 权限：`kv:own`
- scope：`app`
- 参数：
  - `key`: `string` —— 
  - `scope`: `string`（可选），默认 `space` —— 

### `log.write` — 写作者侧日志

- 调用：`api.log(message, level)`
- 权限：无需权限
- scope：`app`
- 返回：进插件日志环形缓冲，可在插件面板查看
- 参数：
  - `message`: `string` —— 日志内容
  - `level`: `string`（可选），默认 `info` —— 日志级别

## 5. 日志与提示

- `api.log(message, level?)` —— 写日志，进插件日志环形缓冲（插件面板「日志」可查）。
  **插件运行时没有 `console`**，这是唯一的排错手段。
- `api.notify(message)` —— 给用户一句提示，执行结束后弹出。

## 6. 沙箱里有什么、没有什么

有：标准 JS 语言能力（`JSON` / `Math` / `Date` / `RegExp` / `Promise` …）与上表的 `api.*`。

**没有**（这是刻意的，也是本体系安全的唯一来源）：`fetch` / `XMLHttpRequest` / `require` /
`process` / `window` / `document` / `localStorage` / Tauri `invoke` / 任意文件读写。
这些在沙箱里都是 `undefined`，且有回归测试钉住。

## 7. 执行预算与错误

每次执行都有硬预算，超限会失败并给出可见错误，**不会拖垮应用**：

- 循环迭代：命令执行 1e6 次、插件加载 1e5 次（循环同时是「分配循环」的实际内存上限）；
- 墙钟：命令 5s、加载 3s；
- 内存：64 MiB 峰值（超出只终结该次调用）；
- 递归：256 层。

错误码：

| 错误码 | 含义 |
|---|---|
| `unknown_capability` | 调用了注册表里没有的能力 |
| `permission_denied` | 插件未在 manifest.permissions 里声明该能力所需权限 |
| `bad_args` | 能力参数不符合注册表里的 args 声明 |
| `space_locked` | 目标空间处于锁定态（E1 加密），不可读（留待 M11.7 / 方案 §3.9 使用） |
| `timeout` | 执行超出墙钟预算 |
| `loop_limit` | 执行超出循环预算 |
| `out_of_memory` | 执行超出内存预算（64 MiB） |
| `plugin_error` | 插件自身抛错 |
| `quota_exceeded` | 插件私有数据超出配额（每个 scope 256 KiB） |

## 8. 兼容与老写法

API v1 冻结的是 `api.*` 这套名字。下列老全局名**仅为兼容已装在磁盘上的插件**而保留，
新插件不要使用（它们的语义与命名并不一致，例如 `__pages()` 返回的是**数量**）：

| 老写法 | 等价能力 |
|---|---|
| `__get_current_page` | `page.current` |
| `__pages` | `pages.count` |
| `__toast` | `user.notify` |
| `__insert` | `editor.insertText` |

另外：**没写 `permissions` 的老 manifest** 会被授予 v1 基线权限（上表三项）并记录一条警告日志，
以便老插件升级后仍可用；新插件请显式声明。
