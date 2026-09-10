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

- `id` 必须**等于目录名**；可用字符：字母、数字、`_`、`.`、`-`（推荐只用小写字母、数字与 `-`）；
- `main` 只能是同级文件名（`main.js` 或 `./main.js`）；
- 每次执行都会**重新 eval** 插件代码并新建一个沙箱 —— 不要在顶层做耗时工作；
- 返回的字符串会显示在命令面板底部；`closeOnRun: true` 执行后关闭面板。

写完之后怎么跑起来、怎么排错：见 [§9 开发循环](#9-开发循环写--校验--看日志)。

## 2. manifest 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 插件 id，必须等于目录名；单段，可用 `A-Za-z0-9_.-`（推荐 `[a-z0-9-]`） |
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
| `write:pages` | 新建页面 / 追加内容：新建页面或向页面追加内容；**写入前会先给你看草稿并等你确认**（不直接落库） | medium |
| `read:properties` | 读取属性定义：读取本空间的属性定义（名称/类型/id），供插件找到要写的属性 | low |
| `write:properties` | 设置页面属性：给页面设置属性值；**写入前会先给你看草稿并等你确认** | medium |
| `write:tags` | 给页面加标签：给页面加标签；**写入前会先给你看草稿并等你确认** | medium |

## 4. 能力（`api.*`）

| 能力 | 签名 | 需要权限 | scope | 写入中介 | 返回 | 自 |
|---|---|---|---|---|---|---|
| `page.current` | `api.page.current()` | `read:page.current` | `current-space` | — | string | 1.0.0 |
| `pages.count` | `api.pages.count()` | `read:pages` | `current-space` | — | number | 1.0.0 |
| `pages.list` | `api.pages.list(limit)` | `read:pages` | `current-space` | — | array | 1.0.0 |
| `pages.get` | `api.pages.get(id)` | `read:pages` | `current-space` | — | object | 1.0.0 |
| `pages.search` | `api.pages.search(q, limit)` | `read:pages` | `current-space` | — | array | 1.0.0 |
| `tags.list` | `api.tags.list()` | `read:tags` | `current-space` | — | array | 1.0.0 |
| `blocks.list` | `api.blocks.list(pageId, limit)` | `read:pages` | `current-space` | — | array | 1.0.0 |
| `backlinks.list` | `api.backlinks.list(pageId)` | `read:backlinks` | `current-space` | — | array | 1.0.0 |
| `files.list` | `api.files.list(pageId)` | `read:files` | `current-space` | — | array | 1.0.0 |
| `editor.insertText` | `api.editor.insertText(text)` | `write:page.current` | `current-space` | 即时 | void | 1.0.0 |
| `pages.create` | `api.pages.create(title, content, parentId)` | `write:pages` | `current-space` | **草稿确认** | object | 1.0.0 |
| `blocks.append` | `api.blocks.append(text, pageId)` | `write:pages` | `current-space` | **草稿确认** | object | 1.0.0 |
| `user.notify` | `api.notify(message)` | — | `app` | — | void | 1.0.0 |
| `kv.get` | `api.kv.get(key, scope)` | `kv:own` | `app` | — | string | 1.0.0 |
| `kv.set` | `api.kv.set(key, value, scope)` | `kv:own` | `app` | 即时 | void | 1.0.0 |
| `kv.remove` | `api.kv.remove(key, scope)` | `kv:own` | `app` | 即时 | void | 1.0.0 |
| `settings.get` | `api.settings.get(key)` | `kv:own` | `app` | — | string | 1.0.0 |
| `properties.list` | `api.properties.list()` | `read:properties` | `current-space` | — | array | 1.0.0 |
| `properties.set` | `api.properties.set(attrId, value, pageId)` | `write:properties` | `current-space` | **草稿确认** | object | 1.0.0 |
| `tags.add` | `api.tags.add(name, pageId)` | `write:tags` | `current-space` | **草稿确认** | object | 1.0.0 |
| `log.write` | `api.log(message, level)` | — | `app` | — | void | 1.0.0 |

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
  - `limit`: `number`（可选），默认 `8` —— 最多返回多少条（上限 100）

### `tags.list` — 列出本空间标签

- 调用：`api.tags.list()`
- 权限：`read:tags`
- scope：`current-space`
- 返回：[{id, name, page_count}]

### `blocks.list` — 列出页面块

- 调用：`api.blocks.list(pageId, limit)`
- 权限：`read:pages`
- scope：`current-space`
- 返回：[{blockId, text}]
- 参数：
  - `pageId`: `string` —— 页面 id
  - `limit`: `number`（可选），默认 `100` —— 最多返回多少块

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
- 写入中介：**即时生效** —— 只作用于当前页的纯文本插入 / 只动插件自己的数据，不碰既有内容
- 参数：
  - `text`: `string` —— 要插入的纯文本

### `pages.create` — 新建页面（草稿确认）

- 调用：`api.pages.create(title, content, parentId)`
- 权限：`write:pages`
- scope：`current-space`
- 写入中介：**草稿确认（落库前需用户点确认）** —— 会新建笔记内容，属于对用户数据的实质写入 → 必须先给用户看草稿并等他确认，不直接落库
- 返回：{drafted: true, summary}——**不代表已创建**，用户确认后才落库
- 参数：
  - `title`: `string` —— 
  - `content`: `string`（可选） —— 正文纯文本（按空行分段）
  - `parentId`: `string`（可选） —— 父页面 id；省略=顶层

### `blocks.append` — 向页面追加内容（草稿确认）

- 调用：`api.blocks.append(text, pageId)`
- 权限：`write:pages`
- scope：`current-space`
- 写入中介：**草稿确认（落库前需用户点确认）** —— 会改动既有页面内容 → 必须先给用户看草稿并等他确认；落库时按当时的页面重读后再追加，不覆盖并发编辑
- 返回：{drafted: true, summary}——**不代表已写入**
- 参数：
  - `text`: `string` —— 要追加的纯文本（按空行分段）
  - `pageId`: `string`（可选） —— 目标页面 id；省略=当前页

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
- 写入中介：**即时生效** —— 只作用于当前页的纯文本插入 / 只动插件自己的数据，不碰既有内容
- 返回：立即写入（不走草稿确认：只动插件自己的数据，不碰笔记内容）
- 参数：
  - `key`: `string` —— 
  - `value`: `string` —— 
  - `scope`: `string`（可选），默认 `space` —— space（默认）或 app

### `kv.remove` — 删插件私有数据

- 调用：`api.kv.remove(key, scope)`
- 权限：`kv:own`
- scope：`app`
- 写入中介：**即时生效** —— 只作用于当前页的纯文本插入 / 只动插件自己的数据，不碰既有内容
- 参数：
  - `key`: `string` —— 
  - `scope`: `string`（可选），默认 `space` —— 

### `settings.get` — 读用户设置

- 调用：`api.settings.get(key)`
- 权限：`kv:own`
- scope：`app`
- 返回：用户在插件管理里为这项设置的值；没设过返回 null（此时用你自己的默认值）
- 参数：
  - `key`: `string` —— manifest.settings 里声明的 key

### `properties.list` — 列出属性定义

- 调用：`api.properties.list()`
- 权限：`read:properties`
- scope：`current-space`
- 返回：[{id, name, type}]——插件据此找到要写的属性 id

### `properties.set` — 设置页面属性（草稿确认）

- 调用：`api.properties.set(attrId, value, pageId)`
- 权限：`write:properties`
- scope：`current-space`
- 写入中介：**草稿确认（落库前需用户点确认）** —— 改动既有页面的属性 → 必须先给用户看草稿并等他确认
- 返回：{drafted: true, summary}——**不代表已写入**
- 参数：
  - `attrId`: `string` —— 属性定义 id（由 api.properties.list() 得到）
  - `value`: `string` —— 
  - `pageId`: `string`（可选） —— 目标页面 id；省略=当前页

### `tags.add` — 给页面加标签（草稿确认）

- 调用：`api.tags.add(name, pageId)`
- 权限：`write:tags`
- scope：`current-space`
- 写入中介：**草稿确认（落库前需用户点确认）** —— 改动既有页面的标签 → 必须先给用户看草稿并等他确认
- 返回：{drafted: true, summary}——**不代表已写入**
- 参数：
  - `name`: `string` —— 标签名（不存在则新建）
  - `pageId`: `string`（可选） —— 目标页面 id；省略=当前页

### `log.write` — 写作者侧日志

- 调用：`api.log(message, level)`
- 权限：无需权限
- scope：`app`
- 返回：进插件日志环形缓冲，可在插件面板查看
- 参数：
  - `message`: `string` —— 日志内容
  - `level`: `string`（可选），默认 `info` —— 日志级别

## 4.5 命令参数（宿主渲染表单）

命令可以声明参数：宿主会**照着声明**渲染一个表单，用户填完才执行（`run(args)` 收到整理好的对象）。
声明什么就渲染什么，所以不存在「表单和实现对不上」这回事。

```js
register({
  id: "my-plugin.todo",
  title: "写一条待办",
  params: [
    { name: "text",    label: "内容", type: "string", required: true },
    { name: "minutes", label: "预计分钟", type: "number", default: 25 },
    { name: "urgent",  label: "标记紧急", type: "boolean" },
    { name: "bucket",  label: "归到", type: "select", options: ["今天", "本周"] }
  ],
  run: function (args) {
    return api.blocks.append(args.text + "（预计 " + args.minutes + " 分钟）");
  }
});
```

规则（都可预期，不会悄悄替你做主）：

- **必填留空 → 表单拒绝提交**（不会传空串下去，空串往往是有效值）；
- **非必填留空 → 不传这个键**，插件里 `args.x === undefined` 即可按「没给」处理；
- `number` 会转成数字，填了非数字会提示；`0` 是有效值；
- `boolean` **总是传布尔值**（没勾就是 `false`）；
- 类型写错（拼错的 `type`）按 `string` 处理——宁可给个文本框，也不让命令从面板里消失。

两个诚实的边界：**参数值不做静态类型推导**（它来自运行期表单，`args` 是 `Record<string, any>`，
按自己的声明收窄即可）；**参数不构成安全边界**（它只会流进插件自己的 JS），真正碰数据的是 `api.*`，

以及体积上限：
那一步宿主逐次校验权限与参数。

## 4.6 事件钩子（manifest 声明 + `on(...)`）

事件让插件在**用户没点命令**时也能跑（例如「保存后自动加今天的日期标签」）。
它要**两处**都写，缺一不可——这是有意的：manifest 是给用户看的授权面，
JS 里没注册就什么都不会发生，而 JS 里注册了但 manifest 没声明则收不到事件。

```json
"events": [
  { "on": "page.saved", "reason": "每次保存后把今天的日期标签补上" }
]
```

```js
on("page.saved", function (payload) {
  api.tags.add(todayTag());   // 省略 pageId 时作用于当前页；写操作仍然走草稿确认
});
```

| 事件 | 触发时机 | 宿主是否已发 |
|---|---|---|
| `app.started` | 应用启动：应用启动完成、插件已加载后触发一次 | ✅ 已在发 |
| `space.switched` | 切换空间：切换到另一个空间后触发（payload: spaceId） | ✅ 已在发 |
| `page.opened` | 打开页面：打开一个页面后触发（payload: pageId） | ✅ 已在发 |
| `page.saved` | 页面已保存：页面内容或标题保存后触发（payload: pageId, title） | ✅ 已在发 |
| `page.deleted` | 页面已删除：页面被删除后触发（payload: pageId） | ✅ 已在发 |
| `import.finished` | 导入完成：一次导入结束后触发（payload: count） | ⏳ 还没接 |
| `sync.completed` | 同步完成：一次同步结束后触发（payload: pushed, pulled） | ⏳ 还没接 |

几条必须知道的规则：

- **只有启用中的插件会收到事件**；
- **写操作仍然要用户确认**：事件里产出的草稿会汇总成一次确认（不会静默写入笔记）；
- **事件里的 `insert` 会被忽略**（没有人正在等你插入文本，凭空出现文字更糟）；
- **没声明 `events` 的老插件不会收到任何事件**（与权限的基线授权不同：在后台运行代码更不能默认给）；
- 事件处理器有**更短的墙钟预算**（保存路径上不该有慢活），超时会记进插件日志。

## 4.7 触发面（命令出现在哪里）

命令默认出现在命令面板（`Ctrl+K`）。想让它出现在别处，用 `menus` 声明：

```js
register({ id: "my-plugin.today", title: "插入今天的日期", menus: ["slash"], run: function () { ... } });
```

| 入口 | 说明 | 宿主是否已实现 |
|---|---|---|
| `slash` | 编辑器「/」菜单：在编辑器里输入 / 就能选到；适合「写到一半要跑一下」的命令 | ✅ 已实现 |
| `page.context` | 页面右键菜单：在页面列表里右键（宿主还没接这个入口） | ⏳ 还没做 |
| `file.context` | 附件右键菜单：在附件/文件上右键（宿主还没接这个入口） | ⏳ 还没做 |
| `editor.toolbar` | 编辑器工具栏：编辑器顶部工具栏按钮（宿主还没接这个入口） | ⏳ 还没做 |

几条规则：

- **类型包里只有已实现的入口**（`PluginMenuName`）——写上去没有的类型会直接编译报错，
  校验器也会提醒你哪些值当前还没有宿主入口（不会静默丢掉你写的声明）；
- 从 `/` 菜单触发的命令，如果它声明了参数，宿主会转交到命令面板让你填参数（同一套表单，不重复实现）；
- 写能力在任何入口都走草稿确认——触发方式不影响这条。

## 4.8 插件设置（用户填、你只读）

需要用户配置的东西（文件夹、条数、开关）声明在 manifest 里，宿主会在「插件管理 → 设置」
渲染成表单。**写只发生在那里**：插件侧 `api.settings.get` 是只读的（对 `setting:` 命名空间
的写入会被后端拒绝）——这样用户看到的配置始终等于他亲手设的那个。

```json
"settings": [
  { "key": "recentCount", "label": "显示条数", "type": "number", "default": 5 },
  { "key": "folder", "label": "归档到", "type": "string", "description": "留空＝当前空间根目录" },
  { "key": "verbose", "label": "详细日志", "type": "boolean", "default": false },
  { "key": "mode", "label": "排序", "type": "select", "options": ["最近更新", "标题"] }
]
```

```js
var n = Number(api.settings.get("recentCount") || 5);   // 没设过返回 null
var pages = api.pages.list(n);
```

几条规则：

- **值由宿主校验**：`number` 一定是数字、`boolean` 一定是 true/false、`select` 一定在候选项里——
  所以插件不必防御「用户填了乱七八糟的东西」；
- **没设过返回 `null`**（不是空串）：据此退回你自己的默认值；
- **没声明的 key 会报错**（而不是返回 null）：key 名字写错是最常见的低级错误，静默返回 null 会让你查很久；
- **scope 由声明决定，不由你选**：`"scope": "space"`（默认）随空间 SQLCipher 加密，
  `"scope": "app"` 落 meta.db（**明文**，别放 token 这类东西）；
- 用户在设置里填的值存在插件自己的数据区（`plugin_data`），与 `api.kv` 同一张表、不同命名空间。

## 4.9 零代码插件（`runtime` = `declarative`）

不需要写 JS 也能做插件：把 `runtime` 设成 `declarative`，只声明**视图**，宿主负责查询与渲染。
整个插件就是一个 manifest.json——**没有代码，所以也没有可执行的东西**，这类插件的信任成本最低。

```json
{
  "id": "reading-board", "name": "阅读统计", "version": "1.0.0",
  "runtime": "declarative", "apiVersion": "1.0.0",
  "views": [ {
    "id": "recent", "title": "最近更新", "summary": true,
    "query": { "kind": "any", "updatedWithinDays": 30, "sort": "updated_desc", "limit": 20 },
    "columns": ["title", "kind", "updated_at", "days_since_update"]
  } ]
}
```

`query` 可用字段：`kind`（`any` / `page` / `database`）、`titleContains`、`updatedWithinDays`、`sort`（`updated_desc` / `created_desc` / `title_asc` / `title_desc`）、`limit`（1–500）。

`columns` 可用列（宿主渲染什么，你只能从这里选）：

| 列 | 说明 |
|---|---|
| `title` | 标题 |
| `kind` | 类型 |
| `updated_at` | 更新时间 |
| `created_at` | 创建时间 |
| `days_since_update` | 距上次更新（天） |
| `title_length` | 标题长度 |

几条要知道的：

- **声明式插件不申请权限、收不到事件、读不了设置**（它没有代码）——写了这些字段会被提醒而不是默默生效；
- 视图出现在命令面板里（搜「插件视图：…」），点开就是一张表，点某一行会打开那一页；
- 列名 / 排序 / kind 写错**不会让视图打不开**，只是那一项按默认处理，校验器会告诉你哪个值不认识；
- 想要用户可配置、想要条件逻辑，就写 `logic` 档（有 `main.js`）——两者的能力不同，不要混着声明。

## 4.10 主题插件（只出一组 token）

主题插件也是**零代码**的：只声明一组设计变量，宿主把它们应用到界面上（停用即恢复）。

```json
"theme": { "name": "暖色夜晚", "tokens": {
  "--bg": "#1b1714", "--text": "#efe6dd", "--accent": "#e0956a"
} }
```

可覆盖的变量（**只含外观**；布局度量刻意不在内——让插件改列宽页宽会砸掉版面）：

| 变量 | 类型 | 说明 |
|---|---|---|
| `--bg` | color | 主背景 |
| `--bg-sidebar` | color | 侧栏背景 |
| `--text` | color | 正文色 |
| `--text-dim` | color | 次要文字 |
| `--text-faint` | color | 更浅的文字 |
| `--border` | color | 边框 |
| `--border-strong` | color | 较重的边框 |
| `--hover` | color | 悬停底色 |
| `--hover-strong` | color | 较重的悬停底色 |
| `--card-bg` | color | 卡片背景 |
| `--code-bg` | color | 行内代码背景 |
| `--codeblock-bg` | color | 代码块背景 |
| `--accent` | color | 强调色 |
| `--accent-strong` | color | 强调色（深） |
| `--accent-soft` | color | 强调色（浅） |
| `--danger` | color | 危险色 |
| `--cat-red` | color | 分类色·红 |
| `--cat-orange` | color | 分类色·橙 |
| `--cat-yellow` | color | 分类色·黄 |
| `--cat-green` | color | 分类色·绿 |
| `--cat-blue` | color | 分类色·蓝 |
| `--cat-purple` | color | 分类色·紫 |
| `--radius` | length | 圆角 |
| `--radius-sm` | length | 小圆角 |

几条规则：

- **值里不允许出现 `url(` / `@` / 分号 / 花括号等**：这些变量会被写进页面样式，
  一个 `url(` 就足以让它对外发请求（本项目「绝不跟踪」的承诺不允许这种口子）；
- 同一个变量**只会有一个插件生效**：多个主题插件同时启用时按插件 id 排序取第一个，
  插件面板会明确提示冲突（而不是「看谁最后加载」这种不确定行为）；
- 停用插件即恢复你的主题（值只在启用期间应用，不写进任何配置文件）；
- 白名单外的变量改了没用，校验器会告诉你哪些名字不认识。

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

## 9. 开发循环：写 → 校验 → 看日志

插件目录就是你的工程目录，没有编译步骤（宿主直接读 `main.js`）。改完文件后：

1. **应用内自动重扫**：插件面板打开时，插件目录一变就会自动重新加载（面板标题会显示
   「已自动重新扫描 …」）——命令面板里的命令、行为、日志随即是新的，不用重启应用。
2. **点「校验」**：列出这个插件**全部**问题（不是只报第一个）：manifest 字段、权限与理由、
   JS 语法（用宿主同一个 Boa 引擎解析）、能不能注册出命令。校验通过 = 应用能装能跑。
3. **看「日志」与「活动」**：`api.log(...)` 的输出去「日志」；插件调用过哪些能力、
   有没有被权限拦下，去「活动」（被拒的调用同样留痕）。

在仓库里开发（或接 CI）时，命令行也有一份**对照检查**：

```bash
pnpm plugin:validate <插件目录>          # 校验 manifest / 权限与理由 / API 版本 / JS 语法
pnpm check:examples                      # 用类型包对示例插件做 tsc 类型检查
```

> JS 语法在命令行由 V8 检查，而应用里跑的是 Boa——两者对新语法的宽容度可能不同。
> **最终以应用内「校验」为准**（它走的是与加载器完全同一条路径）。

编辑器里想要补全与类型检查，把类型包加进 tsconfig（脚本式插件用 `globals.d.ts`）：

```json
{
  "compilerOptions": {
    "allowJs": true, "checkJs": true, "noEmit": true, "strict": true,
    "paths": { "@shuyonote/plugin-types": ["<仓库>/packages/plugin-types/index.d.ts"] }
  },
  "files": ["<仓库>/packages/plugin-types/globals.d.ts"],
  "include": ["main.js"]
}
```

仓库里 `examples/plugins/` 有三个可直接抄的示例（只读、写草稿、插件私有数据各一），
它们同时被 CI 用作者 CLI 与类型检查钉住——所以示例永远是可用的。
