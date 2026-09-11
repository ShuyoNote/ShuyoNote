# 20 行写第一个插件

> 目标：**只看文档、不读源码**，从零写出一个能装进应用、能跑、能发布给别人用的插件。
> 全程只需要终端与一个文本编辑器。
>
> 相关：[插件 API 参考](plugin-api.md)（能力表与错误码）· [`plugin-index.json` 规范](plugin-index-spec.md)（发布给别人）·
> [插件配方](plugin-recipes.md)（打包 / 签名 / 索引用法）· [开发者政策](plugin-policy.md)（发布前必读）

## 0. 一分钟：生成起点

```bash
pnpm plugin:new my-first-plugin       # 生成到 examples/plugins/my-first-plugin
pnpm plugin:validate examples/plugins/my-first-plugin
```

第二条命令就是**作者 CLI**：它检查 manifest、权限理由、JS 语法，并告诉你哪些地方会被应用拒载。
生成出来的插件是**零权限**的（只用了 `api.log` 与 `api.notify` 这两个免权限能力），
所以装进去就能跑——先跑通，再按需要加权限。

## 1. 目录里有什么

```
my-first-plugin/
├─ manifest.json   ← 插件身份证：id、版本、要哪些权限（用户装之前只看得到它）
├─ main.js         ← 代码
└─ README.md       ← 生成的说明（校验 / 安装 / 发布三步）
```

## 2. 看懂 manifest

```json
{
  "id": "my-first-plugin",
  "name": "My first plugin",
  "version": "1.0.0",
  "description": "一句话说清这个插件解决什么问题。",
  "apiVersion": "1.0.0",
  "main": "main.js",
  "permissions": []
}
```

- **`id`**：唯一且**不可改名**（它决定插件目录名与数据归属）。只允许小写字母/数字/短横线。
- **`permissions`**：**要什么写什么**。这里分三种写法，含义完全不同：
  - 不写这个字段 → 应用按 v1 基线授权（12 项权限**全部给**）——这是给老插件的兼容路径，**新插件别这么干**；
  - `[]` → 一项都不给（脚手架就是这个，最安全）；
  - `[{ "id": "...", "reason": "..." }]` → 只给列出的那些。**`reason` 必填**：用户要看的就是它。
- **`apiVersion`**：能力面的版本。未知 major 会被拒载（不猜兼容）。

## 3. 写第一个命令

`main.js` 里 `register({...})` 注册命令，它出现在命令面板（Ctrl+K）：

```js
register({
  id: "my-first-plugin.hello",
  title: "打个招呼",
  description: "命令面板里那一行说明。",
  closeOnRun: false,
  run: function () {
    api.notify("跑起来了");     // 弹一条提示（免权限）
    api.log("hello 被点了");    // 写进这个插件的日志（免权限）
    return "你好，我是第一个插件。";   // 返回值就是命令面板里显示的那句话
  },
});
```

三条规矩（写错会很明显，但知道能省时间）：

1. **只用 `api.*`**。运行时里没有 `window`、没有 `fetch`、没有 `require`——**这一版插件没有任何联网能力**，
   全部能力都作用于本机数据。
2. **写笔记不直接落库**：`api.pages.create(...)`、`api.blocks.append(...)` 产出的是**草稿**，
   用户确认后才写。所以你可以放心把"生成内容"这件事交给插件。
3. **顶层代码要短**。它在"加载插件"时就会跑（有超时），真正的活放到 `run` 或事件里。

## 4. 要读笔记？先声明权限

比如"列出最近改过的页面"，用到 `api.pages.list(...)`，它要 `read:pages`：

```json
"permissions": [
  { "id": "read:pages", "reason": "读取页面标题与更新时间，用来列出最近改过的页（不含正文）" }
]
```

```js
run: function () {
  var pages = api.pages.list(10);   // 位置参数，不是对象；返回 [{id,title,created_at,updated_at}]
  return pages.map(function (p) { return p.title; }).join(" / ");
}
```

改完再 `pnpm plugin:validate <目录>`：权限 id 不认识、`reason` 没写、**manifest 里写了应用不读的字段**，都会被告知。
**能力表、每个能力的参数与所需权限，看 [`plugin-api.md`](plugin-api.md)。**

## 5. 装进应用跑一遍

打开「设置 → 插件 → **打开插件管理**」，三选一：

| 方式 | 适合 |
|---|---|
| **从文件夹安装** | 自己开发时最快：选这个目录 |
| **装 zip 包** | 把目录压成 `.zip`（`zip -r my-first-plugin.zip my-first-plugin`） |
| **从索引安装（给 URL）** | 别人做的插件：填一份索引地址（见 [规范](plugin-index-spec.md)） |

装完**默认未启用**——这是有意的：先看清「权限 + 理由」，再点启用。启用后按 Ctrl+K 搜你的命令标题。

## 6. 出问题时看哪里

| 现象 | 先看 |
|---|---|
| 命令没出现 | 插件是否**已启用**；顶层 `register({...})` 有没有真的被执行到（写了提前 return、抛错、或把它放进函数里都会导致没有命令）。**注意 manifest 里没有 `commands` 字段**——命令是跑一遍顶层代码发现的；写了这个字段 CLI 会提醒你它不生效 |
| 一运行就报"权限不足" | 用了没声明的能力：加进 `permissions` 并写 `reason`，然后在插件管理里**重新确认** |
| 想知道实际发生了什么 | 插件管理里这个插件的「**日志**」（`api.log`/`api.notify` 都进那里）、「**活动**」（调用过哪些能力、有没有被拒）、「**事实**」（可查证的信息与静态扫描结果） |
| 应用里的「验证」说不行，CLI 说行 | 以**应用内验证**为准：它走的是与加载器**同一条路**（同一个 manifest 解析、同一个 Boa 引擎）。CLI 只做 V8 语法检查，两者对新语法的宽容度可能不同 |
| 改了代码没生效 | 面板打开时会自动重扫插件目录；关掉再开一次，或点禁用再启用 |

## 7. 发布给别人

```bash
zip -r my-first-plugin-1.0.0.zip my-first-plugin
shasum -a 256 my-first-plugin-1.0.0.zip     # 填进索引的 sha256
wc -c < my-first-plugin-1.0.0.zip           # 填进索引的 size
```

然后写一份 `plugin-index.json`（最小示例与字段表在 [规范](plugin-index-spec.md)），
把 zip 与索引放到任何 https 可达的地方。**发布前读一遍 [开发者政策](plugin-policy.md)**：
里面写了不许做什么、必须写什么（许可 / 权限理由 / 变更说明）、以及撤回与**换密钥**的规矩。

想先在本地把"别人来装"这条路走通：

```bash
node scripts/plugin-index-demo.mjs my-first-plugin 8787
# 把打印出来的地址填进「从索引安装（给 URL）」
```

## 8. 下一步可以看什么

- **能力全表与参数**：[`plugin-api.md`](plugin-api.md)
- **真实可跑的插件**（11 个，含零代码的声明式视图与主题）：[`plugin-recipes.md`](plugin-recipes.md) 与 `examples/plugins/`
- **零代码也能做贡献**：声明式视图（宿主渲染，你不写 JS）与主题（只写 token）——见 `plugin-api.md` 对应章节
- **事件订阅**：`manifest.events` + 顶层 `on("page.saved", function (payload) {...})`；
  订阅了事件就意味着"用户没点命令时也会跑代码"，所以 `reason` 要写清
