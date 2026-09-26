# AGENTS.md —— ShuyoNote 客户端仓

给 AI 编码 agent 的规矩。**人看的入门是 [`CONTRIBUTING.md`](CONTRIBUTING.md)**,
详细约定见 [`docs/development.md`](docs/development.md),
门禁总表与"每条挡什么事故"见 [`docs/TESTING.md`](docs/TESTING.md)。

本文件只写**读代码推断不出来、且踩过坑**的部分。刻意不抄任何清单正文——
抄了就会出现第二份真相源,而"两份真相源"正是本仓花了最多代价去消灭的东西。

> 本仓有多个 worktree(`ShuyoNote-crdt2` / `-gmwin` / `-pdfdefault` …)。
> worktree 之间唯一的共享记忆就是**提交进仓库的文件**——所以规矩写在这里,不写在会话里。

---

## 1. 分支与提交

```
main    ← 已发布的代码。推 main 会**自动部署 Web 版**,只接受发版与 hotfix。
dev     ← 集成分支,日常往这里合。
feat/*  ← 特性分支,从 dev 切出。
```

- **不要直接往 `main` 提交**(等于直接上线)。
- 提交信息:`type(scope): 中文摘要`,必要时用 `——` 接原因。类型与 scope 用英文,摘要用中文。

```
refactor(stores): 剩余 23 处整店订阅全部收窄，基线清空为 {}
feat(android): 应用显示名脚本化 —— 备案名 / 软著全称 / 商店上架名三处同名
merge: dev -> main（发布 1.91.21 的内容：移动端适配 + PDF 阅读器打磨）
```

## 2. 验证:先跑这一条

```bash
pnpm verify          # = node scripts/test-report.mjs
                     #   默认组:contract, smoke, sync, plugin —— 全部是纯 Node，任何机器都能跑
pnpm verify:list     # 列出门禁清单(不知道跑哪条时先跑这个)
```

**不要用 `pnpm build` 做逐次编辑的反馈回路。**它的链上串了 20+ 个检查
(资源拷贝 → versions → changelog → workflow-yaml → release-parity → overlay →
hook-order → store-subscriptions → tsc → web-commands → deep-link → nsis →
capabilities → vite build),又慢又容易被无关报错带偏。它是**发布/CI 级**命令。
按 §4 的表格挑精确的那一条。

| 命令 | 组 | 需要什么 |
|---|---|---|
| `pnpm verify` | contract, smoke, sync, plugin | 纯 Node |
| `pnpm verify:all` | + browser | 真实 Chromium |
| `pnpm verify:rust` | rust | cargo;**以 Linux(CI / WSL)为准** |
| `node scripts/test-report.mjs --group mobile` | mobile | 真实 Chromium **＋ 先起 dev server(:5173)** |
| `node scripts/test-report.mjs --only <gate-id>` | — | 只跑一条 |
| `node scripts/test-report.mjs --retry N` | — | 只对 `flaky: true` 的门禁有效 |

## 3. 门禁注册表是**单一事实来源** —— 本文件最重要的一条

**门禁清单的唯一出处是 [`scripts/lib/gates.mjs`](scripts/lib/gates.mjs)。**
本地 `pnpm verify` 与两侧 CI 都消费它,`scripts/test-report.test.mjs` 还导入它做不变量自测。

> ### ⛔ 铁律:新增门禁**必须**注册进 `scripts/lib/gates.mjs`
>
> 只把它挂在 `package.json` 的 `build` 链上,等于**在 `pnpm verify` 与 CI 上隐形**。
> 这个坑**踩过两次**,两次都是"看起来加了门禁,其实没人跑":
>
> - `mobile-views` —— 2026-09-22 补进注册表(此前只挂在 `package.json`)
> - `check-hook-order` —— 2026-09-25 补进注册表(此前只挂在 `build` 链)
>
> 注册表的注释原话:「"只挂在 build 链上"的门禁在 CI 的 verify 路径上是隐形的。」

- 每条门禁都要写 `incident` 字段:**它挡的是哪一次真实事故**。
  这不是装饰——不写下理由,后人只会看到"一堆跑得慢的检查",然后在赶工时把它删掉。
- `DEFAULT_GROUPS` 必须**只含纯 Node 门禁**(不能有 cargo / Chromium / dev server),
  否则"一键本地验收"在没装浏览器的机器上直接红,很快就没人跑了。
  这条不变量由 `scripts/test-report.test.mjs` **机器校验**,不是靠注释。
- **删门禁、改门禁 id、调低基线都会被判红。**契约由人显式决定,脚本不擅自改。

## 4. 改了哪里 → 跑哪条

| 改动区域 | 命令 |
|---|---|
| 组件里的 store 订阅(`useNotes()` 等) | `pnpm check:store-subscriptions` |
| 组件里的 hooks / 提前 return | `pnpm check:hook-order`(自测:`--self-test`) |
| 浮层 / 弹窗 / 返回栈 | `pnpm check:overlays` |
| 能力注册表 | `pnpm gen:capabilities && pnpm check:capabilities` |
| Rust 后端命令 | `pnpm check:web-commands`(并同步 `src/lib/platform/commands.ts`) |
| 派生表写入(attachment_text / chunks) | `node scripts/check-derived-writers.mjs` |
| 直接访问 content_json / content_text | `node scripts/check-doc-content-access.mjs` |
| 版本号 / CHANGELOG | `pnpm check:versions && pnpm check:changelog` |
| workflow YAML | `pnpm check:workflow-yaml` |
| `.gitcode/workflows/` | `pnpm gitcode:validate` |
| 文档相对链接 | `pnpm check:doc-links` |
| PDF worker 垫片 | `pnpm check:pdfjs-shim` |
| PowerShell 脚本 | `pnpm check:ps1-ascii` |
| 插件示例 / 作者 CLI | `pnpm plugin:validate`、`pnpm check:examples` |
| 同步一致性 | `pnpm test:sync` / `pnpm test:sync-collab` |
| 合并前兜底 | `pnpm verify`(要 Chromium 时 `pnpm verify:all`) |

不知道 `check:*` 有哪些时看 `package.json` 的 `scripts`,**但验证是否"在岗"一律看
`scripts/lib/gates.mjs`** —— 那里才是被 CI 跑到的集合。

## 5. baseline 纪律(`tests/baseline.json`)

各门禁的**断言/用例数下限**,把"只增不减"变成机器校验。

- 调低它 = 删断言 = **CI 红**。不要为了变绿去改读数。
- 更新:`pnpm verify:baseline`(本地跑完写回),或
  `node scripts/test-report.mjs --baseline-from <report.json>`(并入 CI 产物,**不跑门禁**)。
- 要让一份新读数**真的被校验**,还得在 `gates.mjs` 给该门禁补 `baseline: true` —— 由人决定。

## 6. flaky 纪律

只有标了 `flaky: true` 的门禁(browser / mobile 那几条)才能 `--retry N`,
而且**重试一定写进报告**("靠重试才通过"会单列一节)。**CI 默认 0 次重试 —— flake 要吵出来。**

## 7. 这台机器(Windows)的已知边界 —— 不要假装通过

- **rust 组本机跑不了。** `cargo test` 的测试 exe 没有应用清单,加载器绑到旧 comctl32
  ⇒ `0xC0000139`。`scripts/win-cargo-test.ps1` 注入 v6 清单后只能跑 **lib 目标**,
  不含要真宿主进程的 `plugins::` 那 34 条。**整组读数以 Linux(CI / WSL)为准** ——
  本机 `pnpm verify:rust` 红是**能力**问题,不是代码问题,基线校验不会因此产生假违规。
- **国密相关门禁**(`gm-conformance`、`check-gm-*`)在拿不到 SM 版 OpenSSL / Tongsuo 时
  **自报跳过**。跳过 ≠ 通过,不要把"跳过"读成"绿"。
- browser / mobile 组需要真实 Chromium;mobile 组还要求先起 dev server(:5173)。

## 8. 已经建立的机器判据(改代码前要知道)

这些门禁的共同点是:违规**不炸、不报错、测试全绿**,只是用户那边出问题。所以只能靠机器钉住。

- **`check-store-subscriptions`** —— 组件不许整店订阅 `const { openPage } = useNotes();`,
  要用字段级选择器或 `getState()`。判据是**订阅关系**,不是渲染耗时。**只减不增。**
- **`check-hook-order`** —— 提前 `return` 不许越过 hooks。自测里放的是两次真事故的**真实写法**,
  必须判红。两次现场都是"用户的界面直接没了"(Ctrl+K 白屏 / 加密重启抛
  `Rendered fewer hooks than expected`)。
- **`check-derived-writers`** —— 派生表(`attachment_text` / `chunks`)唯一写入者是
  TS 抽取管线(`src/lib/extract/`)。Rust 生产代码不许写(测试夹具除外,判据做区域判定)。
- **`check-doc-content-access`** —— 直接摸 `content_json` / `content_text` 的面**只减不增**,
  必须经一层(read / write / merge / derive)。
- **`check-overlay-registry`** —— 新增浮层必须登记,否则**安卓返回键直接退出应用**。
- **`check-web-commands`** —— Rust 命令必须 ⊆ `src/lib/platform/commands.ts` 的 `CommandMap`。
  新增后端命令时两处一起改。

## 9. 编码与行尾(都是真事故驱动)

- **仓库内容全部是 LF**(`.gitattributes` 的 `* text=auto eol=lf`)。
  没有它,Windows 检出会变 CRLF,于是"按源代码逐字节比对"的检查必然失败——
  **v1.84.6 的发版构建就是这样被打断的**(Linux 绿、Windows 红)。不要改这个文件。
- **不要用 shell 重写含中文的 UTF-8 文件**(`Set-Content` / `>` 重定向 / `sed -i`)——
  会乱码。用编辑工具。
- **`.ps1` 必须是纯 ASCII 或带 BOM**:无 BOM 的 UTF-8 `.ps1` 在 PS 5.1 下按 ANSI 解码
  ⇒ 报一堆假语法错误(`pnpm check:ps1-ascii` 守这条)。

## 10. CI 在哪跑(改 CI 前必读)

主站是 **GitCode**(`origin`,代码托管国内可达),**但 CI 在 GitHub 上跑**。
实测(2026-09-26):GitHub 侧 **1391 次运行**、最近全绿;GitCode 侧 3 个 workflow
虽然都注册成 `active`,**`runs` 是 0**(它自己的文件头就写着「仍未在 GitCode runner 上实跑过」)。
**别往 GitCode 那侧加 CI。**

| 侧 | 文件 | 跑什么 |
|---|---|---|
| GitCode | `.gitcode/workflows/ci.yml` | 纯 Node 组(contract / smoke / sync / plugin) |
| GitCode | `.gitcode/workflows/rust-baseline.yml` | 手动触发,只为产出 rust 组读数 |
| GitCode | `.gitcode/workflows/build-linux.yml` | 打 tag 构建 `.deb` / `.AppImage`(**备份路径**) |
| GitHub | `.github/workflows/ci.yml` | checks / mobile-layout / rust-tests |
| GitHub | `.github/workflows/release.yml` | **正式三平台发版走这里** |

- 两侧**同源**:同一句 `node scripts/test-report.mjs`,同一份 `scripts/lib/gates.mjs`。
- **不要照抄 GitHub 的写法去改 `.gitcode/` 下的文件。**GitCode 有三条平台硬约束:
  `runs-on` 只在白名单内、每个 step 必须有非空 `name`、不接受简写 action。
  **不合法时整条流水线不会被调度,而且不报错。**门禁:`pnpm gitcode:validate`。
- ⚠️ GitCode 的 `on` **仅有** `workflow_dispatch` 时,文件必须在**默认分支**才会出现在 Actions 页。
- 🔁 **GitHub 侧是镜像,而 CI 在那边跑** —— **镜像落后就等于 CI 在测旧代码。**
  本机一条命令同步全部仓(含本仓的 `dev` / `main`):
  `powershell -File C:\Users\cnzen\zhai\mirror-github.ps1`(脚本在工作区根,**不随仓库分发**)。
  2026-09-26 首跑实测:本仓 `dev` 在 GitHub 上**落后 52 笔**,而 CI 的触发分支正是 `[main, dev]`。

## 11. 发版

- **发版要同步 6 处**:`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json` /
  `README.md` 徽章 / `docs/README.md` / `CHANGELOG.md`(见 `docs/development.md` 第 5 节)。
- `check-changelog-version-parity` 会点出**是哪一笔提交**只改了 CHANGELOG 没改版本文件。
- 正式发版出包走 GitHub Actions `release.yml`;GitCode 的 `build-linux.yml` 只是备份路径。

## 12. 权限分档

**免确认直接做**:读文件 / 搜代码、单个 `check:*`、`pnpm verify`(默认组)、`tsc --noEmit`、
单文件格式化。

**必须先问**:

- `cargo clean`(会让后续门禁重新编译,几分钟)
- 改 `release/`、`src-tauri/gen/`(产物目录,不许手改)
- 改 `.gitattributes`、CI 触发分支、`.gitcode/workflows/`
- 动加密相关(国密 / SQLCipher / 密钥格式)
- 升版本号、改 `CHANGELOG.md` 已发布标题
- 删门禁、改门禁 id、调低 `tests/baseline.json`
- `git push`、合并到 `main`

## 13. 不要做什么

- ❌ 用 `pnpm build` 当日常验证(§2)。
- ❌ 新增门禁却不注册进 `scripts/lib/gates.mjs`,然后声称"加了门禁"(§3)。
- ❌ 把"跳过"当"通过",或让本机跑不了的门禁静默变绿(§7)。
- ❌ 为了让 CI 变绿去改 `tests/baseline.json` 的读数(§5)。
- ❌ 用 shell 重写含中文的文件,或改 `.gitattributes`(§9)。
- ❌ 以为 GitCode 那侧在跑 —— 实测它 **0 次运行**;CI 就在 GitHub 侧(§10)。
- ❌ 新增文档不登记进 `docs/README.md`(有 `check-doc-links` 管链接可达)。
