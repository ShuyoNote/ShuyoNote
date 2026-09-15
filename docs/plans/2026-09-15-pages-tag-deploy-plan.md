# GitHub Pages 改为随 tag 发布 + 两个 Web 入口"构建身份"对齐（方案）

> **依据**：2026-09-15 发 v1.91.2 时的**实测**——线上两个 Web 入口**都在跑 tag 之后 9 个提交的
> 未发布代码**（含一个未发布的 `feat`），而 `pnpm check:web-deploy` **全绿**。不是推测，判据见 §二。
> **目标**：让"用户能打开的那个 Web"只可能来自**一次发布**，并让"线上不是发布产物"这件事**必然报警**。
> **范围**：`.github/workflows/pages.yml`、`scripts/write-version-json.mjs`、
> `scripts/check-web-deploy.mjs`、`scripts/check-web-build.mjs`（仅注释）、
> `.github/workflows/ci.yml`（仅注释）、`docs/RELEASING.md`、`docs/development.md`
> （+ 一条 GitHub 环境策略）。**触发方式一变，全仓 12 处"Pages 跟 `main` 走"的陈述都要同步**
> ——清单见 §五 C-3，已逐个扫过。
> **不动**任何用户可见功能，不改版本号，不涉及依赖。
> **状态**：方案，**未实施**。其中"改 `github-pages` 环境分支策略"是**安全面变化**，
> 按 `docs/RELEASING.md` §⑦ 既有约定，**需发布者明确授权**。
> **执行方式**：按 §五 顺序做，**每一步都带判据**；A 组与 C 组互不阻塞，可并行。

---

## 一、结论（先给判断）

缺陷有**两条**，各自独立，**必须一起修**——只修一条都还会漏：

1. **入口绑定的是分支，不是发布。** `pages.yml` 触发 `push: main`（`.github/workflows/pages.yml:6-9`），
   而 `main` 是开发主干——发完版立刻继续前进。于是"用户入口"与"发布"解耦：
   **任何一次推 `main` 都会改用户看到的东西**。
2. **产物里没有构建身份。** `version.json` 只有 `{"version":"1.91.2"}`
   （`scripts/write-version-json.mjs:15`）。所以"1.91.2 由 tag `709b0e9` 构建"与
   "1.91.2 由 `main f173052d` 构建"在**产物上不可区分**；`check:web-deploy` 能比的只有版本字符串，
   于是今天这种"**版本对、代码不对**"的情形它**必然通过**。

**推荐组合 = 方案 A + 方案 C**：Pages 改为**只在打 `v*` tag 时**部署（A），
并给产物加**构建身份**、把 `check:web-deploy` 从"比版本"升级成"比身份"（C）。

**一个容易被忽略的前提**：`shuyo.cn/app` 是**手动从工作区构建**的
（`docs/RELEASING.md:279`），所以**即使 A 做完**，手动入口仍然会顺带发布未发布的改动——
今天就是这么发生的（§三.3）。C 组 + §五 C-4 才是治它的一半。

---

## 二、现状盘点（全部实测，含判据）

| # | 事实 | 判据 | 实测结果 |
|---|---|---|---|
| 1 | Pages 由 Actions 构建 | `GET /repos/ShuyoNote/ShuyoNote/pages` | `build_type:"workflow"`、`https_enforced:true` ← **tag 策略因此被允许**（GitHub 只在 Actions 构建的站点上支持 tag 策略） |
| 2 | `github-pages` 环境**只允许 `main`** | `GET …/environments/github-pages/deployment-branch-policies` | `total_count:1`，唯一 `{id:59192578, name:"main", type:"branch"}` |
| 3 | 旧版 `pages/builds` API **没有记录** | `GET …/pages/builds/latest` → **404**；`?per_page=5` → **空数组** | `build_type:"workflow"` 的**正常现象**，别再当故障查 |
| 4 | Pages 最近一次部署 | `GET …/actions/workflows/pages.yml/runs` | **#95 `f173052d`** 2026-09-15T08:11:53Z `success`（累计 ≥95 次） |
| 5 | `pages.yml` 触发面 | `.github/workflows/pages.yml:6-9` | `push: branches:[main]` + `workflow_dispatch` |
| 6 | `main` 领先 tag `v1.91.2` **9 个提交** | `git log --oneline v1.91.2..HEAD` | `643b508 6669b6d e0e6687 38536f2 e622bda e8db74d 8dd6fae f173052 f40aece` |
| 7 | 其中**唯一**动 `src/` 的 | `git log --oneline v1.91.2..HEAD -- src/` | `e8db74d feat(sync): K2`，**16:01:03** |
| 8 | 两个线上入口**都含** K2 | 扫线上入口 JS 找 tag 里不存在的字面量（下附复现） | Pages ★命中 / 主站 ★命中 |
| 9 | tag 里**没有** K2 | `git grep -c "issue-device-key" v1.91.2 -- src/` → **0**；`HEAD` → **2** | 反证 #8 是"跑着未发布代码"，不是"K2 本来就在 1.91.2 里" |
| 10 | 两个入口**逐字节相同** | 逐文件 SHA-256（index.html 引用 + JS 内嵌分块名，共 26 个） | 相同 26 / 不同 **0** |
| 11 | `version.json` 只有版本号 | 线上两个入口实测 + `scripts/write-version-json.mjs:15` | `{"version":"1.91.2"}` |
| 12 | 现有门禁**发现不了** #8 | `scripts/check-web-deploy.mjs:49-55` 只比 `version === pkg.version` | 本次发版 **✓✓ 全绿** |
| 13 | `ci.yml` 已覆盖 main/dev/PR 的 Web 构建 | `.github/workflows/ci.yml:91-92`（`build:web` + Chromium 自检） | Pages 的 build job **不提供额外正确性覆盖** |
| 14 | Pages 是**给用户看的国际入口** | `README.md:30` | 所以 #8 是**用户可见**缺陷，不是内部整洁问题 |
| 15 | "只在 `main`"是**有意设计** | `docs/RELEASING.md:278`、`281-303` | 本方案要改的正是这条**已文档化的设计** |
| 16 | 仓库**已经把这个缺陷当成"约束"记下来了**（两处独立章节） | `docs/development.md:334`、`:340`、`:372-375` | "推 `main` = GitHub Pages 自动部署"；"**为什么 main 要这么严**：…落到 main 的 WIP 会被**公开部署出去**"；"**为什么 `main` 必须保持可发布**：推 `main` 就等于上线" ⇒ 团队一直在用**约定**兜这个机制缺陷 |
| 17 | 而那条约定**已经在滑** | `git log --oneline v1.91.2..HEAD` | `main` 实际领先 tag **9 个提交**，含 `feat(sync)`/`test(sync)`/`docs`，与 `docs/development.md:334-335`"只接受两类提交：版本号 bump（发版）与 hotfix"不一致 ⇒ **靠约定守不住，要靠机制** |
| 18 | 加字段**不会脏工作区** | `.gitignore:26`（`public/version.json`）、`.gitignore:13`（`dist-web`） | 两者均未跟踪 ⇒ 不影响 `release:preflight` ① |

**#8 的复现（两条命令，别用肉眼看版本号）**：

```bash
# tag 里不存在的字面量：K2(e8db74d) 才引入的 --issue-device-key / 「手动填令牌 / 设备密钥」
for base in https://shuyonote.github.io/ShuyoNote/ https://shuyo.cn/app/; do
  printf '%s → ' "$base"
  curl -s "$base" | grep -oE 'assets/[^"]+\.js' | sort -u \
    | while read -r a; do curl -s "$base$a"; done | grep -c 'issue-device-key'
done
# 实测：两个入口都 ≥1（命中）；而 tag 侧 git grep 是 0
```

> **扫描范围的诚实说明**：上面只扫 `index.html` **直接引用**的 20 个 JS（合计 9,394,843 字符）。
> 够用，是因为 `SyncPanel` 是**静态 import**（`src/App.tsx:3`、`src/components/PageTree.tsx:56`），
> 必然落在被引用的 chunk 里。懒加载分块不在其中——本方案 §五 C-2 的比对**改用部署侧全量清单**，
> 不继承这个限制。

**#10 的成因（把它讲清楚，免得下次误判）**：`shuyo.cn/app` 是**手动从工作区构建**的。
发版当天的主站部署备份戳是 `shuyo-site-app-backup-20260915-160650.tgz` = **16:06:50**，
而 K2 落地是 **16:01:03**——晚 5 分 47 秒。所以手动构建时工作区里**已经有 K2 了**，
Pages 侧的 `f173052d` 又是 `e8db74d` 的后代。两侧因此同源，**不是机制保证，是巧合**。

> ⚠️ **本方案要建立的，正是这个"巧合"变成"保证"**。今天两个入口一致，纯属两边都恰好越过了同一个提交。

---

## 三、根因（三层，逐层更根本）

### 3.1 入口绑定分支，而不是绑定发布
`pages.yml` 的触发是 `push: main`。`main` 的语义是"开发主干"，它的前进**不受发布节奏约束**。
把用户入口挂在它上面，等价于宣布"**主干即线上**"——这是 Web 产品的合法选择，但**本仓库不是**：
桌面/安卓走 tag + `latest.json` 更新通道，Web 却跟着 `main` 走，两种交付节奏不一致。

**这个缺陷的代价不只落在用户身上，还落在开发流程上**：因为"推 `main` 就等于上线"，
仓库不得不规定 `main` **只接受版本号 bump 与 hotfix**、且"**必须保持可发布**"
（`docs/development.md:334-335`、`:340`、`:372-375`）。也就是说，**一个部署机制的选择
反过来约束了整个分支模型**。而 #17 说明这条约定**已经在滑**——`main` 现在领先 tag 9 个提交。

### 3.2 产物无构建身份 ⇒ "版本对"被当成"是对的"
`version.json` 只回答"我是 1.91.2"，不回答"我**由哪个提交**构建"。
`check-web-deploy` 因此只能验"版本号相等 + 资源可达"，而这两条**在跑未发布代码时都成立**。
**#12 不是脚本写得差，是它手里根本没有能判定的信息。**

### 3.3 手动入口构建的是"工作区"，不是"某个 ref"
`pnpm build:web` 打的是当前工作区。而本仓库**多会话并发是常态**——
今天另一个会话在 16:01 落了 K2，我 16:06 构建，于是**发布动作顺带发布了未发布的特性**，
全程没有任何提示。这一层**最根本**：`git checkout` 的不是发布提交，构建就不可能是发布产物。

---

## 四、方案取舍

| 方案 | 做法 | 判据/理由 | 结论 |
|---|---|---|---|
| **A** | Pages 触发改 `v*` tag；环境策略加 `{name:"v*", type:"tag"}` | 直接消灭 3.1：未打 tag 的提交**在触发层面**就到不了 Pages；且 tag 是"发布"的既有唯一判据（桌面/安卓同源） | ✅ **推荐** |
| A′ | 保留 `main` 触发，把 Pages 明确标成"开发预览" | 一个仓库只有**一个** Pages 站点，做不了"预览站"；且 `README.md:30` 已把它当**国际入口**给用户 ⇒ 要么改 README（降级用户体验）要么改机制 | ❌ 不推荐 |
| B | push `main` 时先断言"远端已有对应 tag"，否则跳过部署 | runbook 是**先推 `main` 再打 tag**（`docs/RELEASING.md` ④）⇒ 正常发版会被自己的门禁挡掉，出现竞态 | ❌ 不推荐 |
| **C** | 产物加构建身份（`commit`）+ `check:web-deploy` 升级为身份比对 | 直接消灭 3.2/3.3；且是**唯一**能覆盖"手动入口"那一半的手段 | ✅ **推荐（与 A 并行）** |
| D | 手动入口也脚本化，构建前强制 `git checkout <tag>` | 治 3.3 的根，但会改动发版手感（工作区被切走）；**先靠 C-4 一句断言拿 80% 收益**，D 留给后续 | ⏸ 暂不做 |

**为什么 A 与 C 不能只做一条**：只做 A，手动入口照样会发布未发布代码（今天就是）；
只做 C，Pages 仍会在每次推 `main` 时改用户入口——C 只会让报警变响，不会让坏事不发生。

---

## 五、实施步骤

> 顺序有讲究：**A-1 先加 tag 白名单（与 `main` 并存）**，这样任何时候站点都还能部署，
> 不存在"改到一半发不出去"的窗口。**A-4 最后再删 `main`**。

### A-1 给 `github-pages` 环境加 tag 白名单（**需授权**，与 `main` 并存）

```bash
curl -s -X POST -H "Authorization: Bearer $GH" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/ShuyoNote/ShuyoNote/environments/github-pages/deployment-branch-policies \
  -d '{"name":"v*","type":"tag"}'
```

**期望**：HTTP `201`，返回体含 `"type":"tag"`、`"name":"v*"` 和新的 `id`。
**复验**：再 `GET …/deployment-branch-policies` 应 `total_count: 2`（`main`/`branch` + `v*`/`tag`）。

> ⚠️ tag 策略**只在 Pages 由 Actions 构建时可用**——#1 已实测 `build_type:"workflow"`，满足。

### A-2 改 `pages.yml` 触发面

**文件**：`.github/workflows/pages.yml`（Modify: `6-9`，以及文件头注释 `3-4`）

```yaml
on:
  push:
    tags: ["v*"]
  workflow_dispatch:
```

同时把第 4 行注释从"触发：推 main（含 Web 端改动）或手动"改成
"**触发：只打 `v*` tag（发布）或手动（手动时必须指定 tag ref，见 docs/RELEASING.md §⑦）**"。

**校验**：
```bash
pnpm check:workflow-yaml     # 仓库已有该门禁，改 workflow 必须过
```
**期望**：通过，无输出或 `✓`。

> **为什么保留 `workflow_dispatch`**：Pages 部署失败时需要**重放**一次，
> 而重放的对象必须是某个已发布的 tag。**但注意**：手动 dispatch 的 `ref` 默认是分支，
> 在 tag 白名单下会 **deploy 0 步失败**（判据见 A-3），所以必须
> `gh workflow run pages.yml --ref v1.91.3`。这一条要写进 runbook，否则下次必踩。

### A-3 用真实 tag 验一次（发下一版时自然发生）

```bash
gh run list --workflow pages.yml --limit 3
gh run view <run-id>          # 看 deploy job
```

**期望（关键判据）**：deploy job **起了 runner**——`runner_id != 0`、`steps` **非空**。
**反面判据**：`deploy` 秒级失败且 **`steps: []`、`runner_id: 0`** ⇒ 被环境策略挡了
（这正是 `docs/RELEASING.md:292-300` 记录的那条迷惑现象）。

### A-4 删掉 `main` 分支策略（收紧安全面）

```bash
curl -s -X DELETE -H "Authorization: Bearer $GH" \
  https://api.github.com/repos/ShuyoNote/ShuyoNote/environments/github-pages/deployment-branch-policies/59192578
```

**期望**：HTTP `204`。
**复验**：`GET …/deployment-branch-policies` 应只剩 `total_count: 1`（`v*`/`tag`）。

> 这一步是**纯收紧**：A-2 之后 `main` 触发已不存在，留着这条策略只是一个**潜在许可**
> （日后有人把触发改回分支，就会静默生效）。删掉它，让"改回分支"必须**显式再授权一次**。

### C-1 给 `version.json` 加构建身份

**文件**：`scripts/write-version-json.mjs`（Modify: `13-15`）

```js
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

// 构建身份：产物必须能回答"我是由哪个提交构建的"。
// 为什么必要：只带版本号时，"1.91.2 由 tag 构建"与"1.91.2 由 main 构建"在产物上不可区分，
// 而 check:web-deploy 能比的只有版本字符串 ⇒ 线上跑未发布代码时它必然通过（2026-09-15 实测）。
// git 不可用时（从 tarball 构建）不阻断构建，写 null，让检查侧明确报"无法判定"。
function headCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const body = JSON.stringify(
  { version: pkg.version, commit: headCommit(), builtAt: new Date().toISOString() },
  null,
  2,
) + "\n";
```

**为什么安全**（#16 已实测）：`public/version.json`（`.gitignore:26`）与 `dist-web`（`.gitignore:13`）
**都未跟踪** ⇒ 加字段**不会弄脏工作区**，不影响 `release:preflight` ① 的"已跟踪文件无未提交改动"。
**兼容性**：应用读的是 `.version`，新增字段无影响。

**校验**：
```bash
pnpm build:web
node -e "console.log(require('./dist-web/version.json'))"
```
**期望**：打印含 `version`、`commit`（40 位 sha）、`builtAt` 三个字段。

### C-2 `check:web-deploy` 从"比版本"升级为"比身份"

**文件**：`scripts/check-web-deploy.mjs`（Modify: `42-83` 的 per-target 循环）

新增三项断言，**失败文案要能直接指向病因**：

1. **线上 `commit` == 该版本 tag 指向的提交**
   ```js
   const tagCommit = execFileSync("git", ["rev-list", "-n1", `v${pkg.version}`], { encoding: "utf8" }).trim();
   ok(remote.commit === tagCommit,
      `线上构建自 tag v${pkg.version} 的提交（线上 ${short(remote.commit)} / tag ${short(tagCommit)}）` +
      (remote.commit === tagCommit ? "" : "  ← 线上跑的不是发布产物"));
   ```
2. **两个入口的 `commit` 一致**（跨入口分叉时报警——今天恰好一致是巧合，见 §二）
3. **两个入口的"部署侧资源清单"一致**：用**部署侧全量清单**比对，而不是只看 `index.html` 引用，
   以覆盖懒加载分块（§二那条"扫描范围的诚实说明"的限制到此为止）。

**边界（必须显式处理，不许静默跳过）**：
- **tag `v<version>` 不存在**（版本已 bump、还没打 tag）：打印
  `跳过身份比对：tag v<version> 不存在`，并**计入失败**，除非显式传 `--allow-untagged`。
  > 静默跳过等于没有门禁——这正是本方案要根除的毛病。
- **线上 `version.json` 没有 `commit` 字段**（旧产物）：报
  `线上产物无构建身份（旧版本），请先部署一次带身份的产物`，而不是崩在 `JSON.parse` 上。

**校验**：
```bash
node scripts/check-web-deploy.mjs            # 应当报"线上 commit ≠ tag commit"——正是今天的真实状态
node scripts/check-web-deploy.mjs --only site
```
**期望（改造后立刻可见的收益）**：在当前线上状态下，这条检查**报错**（因为线上是 `f173052d`/`e8db74d` 系
而非 tag `709b0e9`）。**这条"变红"就是验收成功的证据**——它证明门禁终于看得见了。

### C-3 同步**所有**"Pages 跟 main 走"的既有陈述（已全仓扫过，别漏）

> 这一步不能省。仓库里**有 12 处**把"推 `main` = 部署 Pages"当既成事实写着（含两处分支模型的
> **立论依据**）；只改 `pages.yml` 不改它们，下一个人读到的文档与机器行为会**互相矛盾**。
> 判据：`grep -rn "Pages\|pages\.yml" --include=*.md --include=*.mjs --include=*.yml .`

| 文件:行 | 现在写的 | 改成 |
|---|---|---|
| `docs/RELEASING.md:278` | 表格："**自动，但只在 `main`**：推 main → `pages.yml`" | "**自动，打 `v*` tag 时**：推 tag → `pages.yml`" |
| `docs/RELEASING.md:281-303` | `[!]` "Pages 的环境分支策略：未合并进 `main` 就刷不了" | 标题加 **（历史）**，注明**现已改为 `v*` tag 白名单**；**保留**"deploy 0 步 / `runner_id=0` = 被策略挡"这条判据——日后若改回分支触发，它是唯一能一眼看出的判据 |
| `docs/RELEASING.md:335-354` | "未合并进 `main` 时，这一节的『两个入口』实际只能完成一个"+ 三条出路 | 加状态更新：前提**再次变化**——Pages 已不从分支部署，这个困境**从机制上消失**；三条出路保留为历史，但注明"第 1、2 条的取舍已不再需要" |
| `docs/RELEASING.md:346-347` | "Pages 上那一份是从它被部署时的 **ref** 构建的" | 升级为"Pages = **该 tag** 的构建"（口径更强，因为 tag 不可变） |
| `docs/RELEASING.md:62` | 注释："main 同样两个远端都推（**Pages 部署在 GitHub 侧**）" | "tag 推两个远端（**Pages 由 tag 触发**，只在 GitHub 侧）" |
| `docs/development.md:334` | "推 main = **GitHub Pages 自动部署** + 可打 tag 发版" | "推 main = **可打 tag 发版**"（去掉 Pages 部署） |
| `docs/development.md:340` | "**为什么 main 要这么严**：…落到 main 的 WIP 会被**公开部署出去**" | 整段重写：该约束**已由机制解除**（未打 tag 的提交到不了 Pages），`main` 的严格性改为**自愿的工程纪律**而非部署机制的强制要求 |
| `docs/development.md:372-375` | "**为什么 `main` 必须保持可发布**：推 `main` 就等于上线" | 同上，整段重写，并指向本方案 |
| `docs/development.md:361` | 注释："三平台构建 + **Pages 部署**都是 GitHub Actions" | 保留（仍成立），补一句"Pages 由 **tag** 触发" |
| `.github/workflows/ci.yml:86-87` | 注释："而 Web 版是**每次推 main 自动部署**的（Pages）" | "而 Web 版是**打 tag 时部署**的（`pages.yml`）" |
| `scripts/check-web-build.mjs:3` | "GitHub Pages 是**每次推 main 自动部署**的" | "GitHub Pages 是**打 tag 时部署**的" |
| `scripts/check-web-deploy.mjs:4` | "GitHub Pages **每次推 main 自动部署**" | 随 C-2 一起重写该文件头（改完它就是"比身份"的脚本了，注释要跟着改口径） |

**确认无需改的（已逐个看过，别顺手改）**：

- `docs/community-integration-status.md:86-87`"Chrome 启动偶发卡住…它一红，Pages 部署就不发了"
  —— A 之后 `pages.yml` 的 build job **照样**跑 `check-web-build`（即 `launch-chrome`），**仍然成立**。
- `README.md:30`（Pages 作为国际入口）、`docs/free-site-export-guide.md`、
  `docs/plugin-recipes.md`、`plans/2026-08-27-project-website-navigation-plan.md` 里提到 "Pages"
  的地方是**把 Pages 当静态托管形态**在讲（建帮助站/放索引），与触发方式无关，**不受影响**。
- `CHANGELOG.md` 里的 Pages 字样是**历史记录**（如 `:1090` 那次"主站停在 1.84.5"的事故），
  **一律不改**。历史不许回改，这是本仓库的既有纪律。

### C-4 手动入口加一条"构建前断言"（治根因 3.3，成本一行）

**文件**：`docs/RELEASING.md`（Modify: §⑦ 步骤 1 之前）

```bash
# 构建前先确认工作区就是发布提交——本仓库多会话并发是常态（2026-09-15 就是），
# 工作区可能已被别的会话推进，那样构建出来的是"未发布代码"，且没有任何提示。
VERSION=$(node -p "require('./package.json').version")
test "$(git rev-parse HEAD)" = "$(git rev-list -n1 v$VERSION)" \
  || { echo "✗ 工作区不是 $VERSION 的发布提交，先 git checkout v$VERSION 再构建"; false; }
```

**期望**：通过（静默）。
**反例验证**（必须做一次，证明这条断言真的会挡）：在 `main`（领先 tag 的提交）上跑，
应打印 `✗ 工作区不是 1.91.2 的发布提交…` 并非零退出。

---

## 六、验收清单

| # | 判据 | 期望 |
|---|---|---|
| 1 | `GET …/deployment-branch-policies` | `total_count:1`，唯一 `{name:"v*", type:"tag"}` |
| 2 | `pages.yml` 的 `on:` | 只有 `push: tags:["v*"]` + `workflow_dispatch` |
| 3 | `pnpm check:workflow-yaml` | 通过 |
| 4 | 推一个**非 tag** 提交到 `main` | `pages.yml` **完全不触发**（Actions 里没有新 run） |
| 5 | 推一个 `v*` tag | `pages.yml` 触发，**deploy job 有 runner、steps 非空** |
| 6 | `node -e "require('./dist-web/version.json')"` | 含 `version`/`commit`/`builtAt` |
| 7 | `pnpm check:web-deploy`（当前线上状态） | **报错**：线上 `commit` ≠ tag commit ← 门禁开始有效 |
| 8 | 部署一次正确产物后 `pnpm check:web-deploy` | 全绿，且打印两个入口的 `commit` 相同 |
| 9 | C-4 断言在领先 tag 的提交上 | 非零退出 + 明确文案 |
| 10 | C-3 清单里 12 处陈述全部改完 | 判据 `grep -rn "Pages\|pages\.yml" --include=*.md --include=*.mjs --include=*.yml .` 后，不再有任何地方说"推 `main` = 部署 Pages" |
| 11 | `pnpm run build` / `pnpm check:web-build` | 无回归 |

---

## 七、边界与不做的事

- **不改 `ci.yml`**：它已在 `main`/`dev`/PR 上构建 Web 并跑真实 Chromium 自检（#13），
  Pages 的 build job 不提供额外正确性覆盖。Web 的正确性门禁留在 CI，不搬到 Pages。
- **不做 `main` 预览站**：一个仓库只有一个 Pages 站点；预览需要额外分支/域名，
  而开发看 `pnpm dev:web`、评审看 CI 的构建产物，收益不抵成本。
- **不自动化"推 tag 到两个远端"**：涉及凭据，超出本方案范围；
  但 `release:preflight` ④ 已经查"两个远端都没有该 tag"，缺口是"打完之后有没有都推上去"——
  这属于另一个方案，本文只**指出**。
- **不动环境策略的其它任何设置**，只动 `deployment-branch-policies`。
- **不改版本号、不改 CHANGELOG**：纯机制改动 + 方案文档，不是用户可见变更
  （符合仓库惯例：`docs(...)` 类提交不进发布说明）。
- **不给 `check:web-deploy` 加超过必要范围的能力**：它只做"线上是不是发布产物"，
  不承担"产物功能对不对"（那是 `check:web-build.mjs` 的 Chromium 自检）。

---

## 八、收益与代价

| | 收益 | 代价 |
|---|---|---|
| A | 未打 tag 的提交**在触发层面**到不了 Pages；Web 与桌面/安卓回到**同一发布判据**（tag）；**解除"`main` 必须保持可发布"这条被部署机制倒逼出来的分支模型约束**（`docs/development.md:334-335`、`:372-375`）——`main` 的严格性从此是**纪律**而非**机制强制** | 推 `main` 不再刷新 Pages ⇒ 想让用户看到改动**必须发版**（这是本方案**要**的行为）；手动 dispatch 必须指定 tag ref |
| C | "线上不是发布产物"从**静默**变**报警**；两个入口分叉可见；覆盖**手动入口**那一半 | `version.json` 多两个字段（向后兼容）；`check:web-deploy` 多一次 git 调用与一次全量清单比对 |
| A+C | 今天这种"版本对、代码不对"的情形**不可能再静默通过** | 需要发布者**授权一次**环境策略变更（安全面） |

**不改的代价（现状继续）**：用户从 `README.md:30` 点进 Pages，拿到的可能是**未发布、未走 CI 发布验证、
未写进 CHANGELOG** 的代码，而所有门禁都是绿的——**这个状态已经发生过一次**（#8）。

---

## 九、待发布者拍板

1. **是否授权修改 `github-pages` 环境分支策略**（A-1 加 `v*` tag、A-4 删 `main`）。
   这是**安全面变化**（改了谁能改线上 Pages），按 `docs/RELEASING.md:302-303` 的既有约定
   **必须显式授权**，不顺手做。
2. **是否接受"推 `main` 不再刷新 Pages"** —— 这是本方案的核心取舍，
   等于承认"**公开 Web 入口 = 已发布的版本**"。
3. `version.json` 的字段名用 `commit` / `builtAt` 是否合适（有没有别的消费者）。

---

## 十、遗留观察（不在本方案范围，但本次实测顺带发现的）

- **`pages/builds` API 返回 404/空是正常的**（#3）。它按 `build_type: workflow` 就不再记录，
  要查 Pages 部署史必须走 Actions runs API。`docs/RELEASING.md` 里没有这条，
  下次有人拿 `pages/builds` 查"Pages 上次什么时候部署的"会以为接口坏了。
- **"两个入口一致"今天只是巧合**（§二 #10）：机制上没有任何东西保证它们同源。
  本方案的 C-2 第 3 条断言就是把这个巧合变成保证。
