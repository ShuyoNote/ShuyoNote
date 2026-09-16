# 回归测试体系（门禁 / 基线 / 结果公开）

> 一句话：**门禁清单只有一份**（`scripts/lib/gates.mjs`），本地 `pnpm verify` 与 CI 跑的是同一份；
> 每轮跑完公开**人可读的汇总**（step summary）与**机器可读的报告**（artifact）；
> 断言数下限写在 `tests/baseline.json` 里，**调低它会让 CI 红**。

## 为什么有这份文档

2026-09-10 之前，仓库里两套 workflow（`pages.yml` / `release.yml`）**一行测试都不跑**：
`smoke-web.mjs`（350 断言，事实上的 web 平台行为标准）曾因一处无守卫的 `localStorage` 访问
整套崩掉而长期无人察觉——没有自动化在跑它，谁都没看见它是红的。`ci.yml` 补上了"跑"，
但结果只活在终端与 Actions UI 里：**绿是口头的**，断言数是在涨还是在减少也没人知道。

2026-09-16 起补上后一半：清单同源、结果可核验、基线机器化。这份文档就是那套东西的总入口。

## 30 秒上手

```powershell
pnpm verify            # 默认组：contract + smoke + sync + plugin（纯 Node，约 20 秒）
pnpm verify:all        # 追加 browser 组（真实 Chromium + Web 构建产物自检）
pnpm verify:rust       # rust 组（cargo test，含插件宿主子进程集成测试）
pnpm verify:list       # 打印门禁清单（分组 + 说明），不跑任何东西
pnpm verify:baseline   # 把当前读数写回 tests/baseline.json（改了断言数量时跑）
```

`mobile` 组需要先起 web dev server（`pnpm dev:web`，:5173）：

```powershell
pnpm dev:web                                   # 另开一个终端
node scripts/test-report.mjs --group mobile    # mobile-layout + mobile-overlays
```

## 门禁总表

准确清单以 `pnpm verify:list` 为准（下表就是它的摘要）。**每条门禁都对应一次真实事故**，
理由写在注册表的 `incident` 字段里——门禁存在的代价是每次 push 的几分钟，理由必须留下来，
否则后人只会看到"一堆跑得慢的检查"。

| 组 | 门禁 | 挡什么 |
| --- | --- | --- |
| contract | `check-versions` / `check-changelog` | 版本号、CHANGELOG 与发布状态脱节 |
| contract | `check-web-commands` / `check-capabilities` | web 与桌面两侧命令契约、能力注册表漂移 |
| contract | `check-doc-links` | 文档相对链接变死链 |
| contract | `check-workflow-yaml` | workflow 里"裸标量以 `:` 结尾"⇒ 非法 YAML ⇒ 0 个 job 的红 run（2026-09-12：49 次 push 全红无人察觉） |
| contract | `check-overlay-registry` | 浮层没登记进返回栈 ⇒ 真机返回键直接退出应用（2026-09-15 第 6 个真机问题） |
| contract | `check-ps1-ascii` | 无 BOM 的 UTF-8 `.ps1` 在 PS 5.1 下报假语法错误（2026-09-11） |
| contract | `check-pdfjs-shim` | 老 WebView 上打不开 PDF：补齐层的 install 顺序最容易被"顺手整理"破坏 |
| contract | `check-ocr-assets` / `check-deep-link` / `check-plugin-hosting` | 运行时资源清单、`shuyonote://` 交付通道、插件托管 |
| smoke | `tsc` | 类型错误 |
| smoke | `vitest` | 单测回归（**730 用例**） |
| smoke | `smoke-web` | web 平台行为（**350 断言**，事实标准） |
| sync | `two-device-sync` | 两设备并发编辑的同步一致性（真实 `applyChange` + 真实 sql.js） |
| plugin | `examples-tsc` / `plugin-cli-validate` / `plugin-new-smoke` | "只看文档就能写出插件"：类型包、作者 CLI、脚手架生成的起点当场可用 |
| browser | `check-pdf-reload` | StrictMode 下 PDF 二次加载交回已 detach 的 buffer（8 断言） |
| browser | `check-panel-layout` | "文字被挤成一条竖柱"这类纯几何问题（25 断言） |
| browser | `check-web-build` | 构建产物打不开：v1.84.1 删掉 sql.js wasm / pdf worker，页面照开但 DB 初始化失败（8 断言） |
| mobile | `mobile-layout` / `mobile-overlays` | 窄屏布局与浮层三类"功能直接不可用且不报错"的坏法（43 / 979 断言） |
| rust | `rust-test` / `rust-plugins-alone` | Rust 单测 + 宿主子进程集成；插件测试必须能**单独跑**（2026-09-13：单跑必红、全量反而绿） |
| artifact | `external-index` / `external-package` | 我们打出的包与索引，应用**真**解析器 / 真校验器认不认 |
| artifact | `plugin-fragment-no-zip` | 打包依赖命令行 `zip`（Windows 上没有它，那边 `pnpm test` 红过三条） |

## 断言数基线（`tests/baseline.json`）

```json
{ "counts": { "vitest": 702, "smoke-web": 350, "mobile-overlays": 979, ... },
  "gates":  { "contract": ["check-versions", ...], "smoke": [...] } }
```

两件事被机器校验：

1. **只增不减**：上表里带读数的门禁（`vitest` / `smoke-web` / `check-pdf-reload` / `check-panel-layout` /
   `check-web-build` / `mobile-layout` / `mobile-overlays`）跑出来的用例数**低于**基线即 CI 红。
   此前"117 → 223 → … → 350 只增不减"只是计划文档里的纪律，删一条断言不会有任何东西变红。
2. **门禁集合**：`gates` 段记录每个组应有的门禁 id。少一条（被删掉 / 改了名而没同步）即 CI 红——
   那一刻没有任何测试会变红，正是最危险的一类退化。

改了断言数量就更新基线（**请在 PR 里说明为什么**）：

```powershell
node scripts/test-report.mjs --group contract,smoke,sync,plugin --update-baseline
node scripts/test-report.mjs --group browser,mobile --update-baseline   # 需要 dev server
```

> ⚠️ 小坑（实测）：新增门禁后跑 `--update-baseline` 时，这一轮里 `vitest` 会红一次
> （`701/702`）——因为自测断言"注册表里每条门禁都必须登记在基线里"，而基线是**跑完才写**的。
> 写完再跑一次就是绿的；CI 上看不到这个中间态。

## 结果公开在哪

| 位置 | 形态 | 保留 |
| --- | --- | --- |
| GitHub Actions **step summary** | 人可读表格（每条门禁的结果、断言数、耗时、失败明细、跳过的门禁） | 随 run |
| GitHub Actions **artifact** | `test-report-*.json`（机器可读，可做趋势 / 断言） | 30 天 |
| GitCode 流水线日志 | 同一张表（GitCode 没有 step summary 机制） | 随 run |
| README 徽章 | GitHub 镜像 CI 当前状态 | 实时 |
| `tests/external-suites.json` | **不在此仓库跑**的套件登记（见下） | 随仓库 |

汇总里刻意区分 **`skipped`（没跑）** 与 `passed`：缺环境变量的门禁显示为"显式跳过"并列出原因，
加 `--strict` 时按失败计。**空白不许冒充绿。**

## flake 与重试（不许静默重试）

browser / mobile 两组要真实 Chromium（+ dev server），是仓库里唯一有 flake 风险的档。
注册表里它们标了 `flaky: true`，但**只有显式 `--retry N` 时才会重试**：

```powershell
node scripts/test-report.mjs --group browser --retry 1   # 本地排查用
```

- CI **默认 0 次重试**：flake 要吵出来。一个只在重试后才绿的套件，等于把真实的稳定性问题
  变成了"看起来一直绿"——那比红危险得多。
- 重试**一定留痕**：报告里记 `attempts`，摘要里单独列一节「⚠️ 靠重试才通过的（不算干净的绿）」。
  静默重试被明确禁止。

## 发版说明里的数字：机器生成

CHANGELOG / 发版说明里"门禁全绿：… 730 用例 …"这类句子**不要人肉从终端抄**（抄错的数字
在下一次改动后就成了假话，而且没人会发现）。加 `--line` 会多打一行可直接粘贴的汇总：

```powershell
node scripts/test-report.mjs --line
# 门禁全绿：smoke 3/3/1080 断言、sync 1/1/14 断言、…；合计 1200 条断言/用例。
```

## 外部套件的回写路径

`tests/external-suites.json` 里的 `status` **不要手写**（手写的状态一定会腐烂）。服务端仓库
CI 跑完后调用回写工具，再对公开仓库开 PR：

```powershell
node scripts/external-suite-status.mjs --list
node scripts/external-suite-status.mjs --suite sync-regression --status passed \
     --evidence "服务端 CI run #42" --commit abc1234
```

`--status` 只接受 `passed` / `failed` / `unknown`——"跑了但结果不明"就写 `unknown`，不许用
`passed` 糊过去。回写会同时写入人类可读的 `status` 与机器可读的 `lastStatus` / `lastRunAt`。

## 覆盖边界（诚实清单）

- **不在本仓库跑的**（登记在 `tests/external-suites.json`，并出现在每轮汇总里）：
  `sync-regression` / `sync-collab-regression` 需要真实同步服务端，跑在**私有**服务端仓库的 CI
  （那边能直接构建二进制）；真机手动验收（Android 开加密→重启→解锁、macOS 公证与自动更新）由人执行。
  这三条的状态回写走 `scripts/external-suite-status.mjs`（见上一节）。
- **GitCode 侧只跑纯 Node 组**（`.gitcode/workflows/ci.yml`）：EulerOS runner 上没有浏览器，
  browser / mobile 组要真实 Chromium，rust 组要 webkit2gtk 一整套系统依赖——那三组留在 GitHub 侧。
  ⚠️ 该文件**尚未在 GitCode 上实跑过**（本机没有 GitCode runner）：命令与 GitHub 侧逐字一致，
  风险只在 GitCode 自己的 action 语义上。
- **happy-dom 不等于浏览器**：`vitest` 跑在 happy-dom 里，**不做布局**、不按视口重算媒体查询，
  所以"文字挤成竖柱""弹层关不上"这类只能靠 browser / mobile 组（真实 Chromium）兜。

## 新增一条门禁

1. 写脚本（纯 Node 优先；需要浏览器的放 `browser` 组）。
2. 在 `scripts/lib/gates.mjs` 注册：`id` / 分组 / 中文标签 / `cmd` / **`incident`（挡什么事故）**；
   有确定读数就加 `counters` 与 `baseline: true`。
3. 在 `scripts/test-report.test.mjs` 的 `REQUIRED_GATE_IDS` 里加上它（CI 必需门禁清单）。
4. 跑 `node scripts/test-report.mjs --group <组> --update-baseline` 更新 `tests/baseline.json`。
5. 更新本文件的表格。
6. 本地跑一遍 `pnpm verify`；CI 会自动跑同一份清单——**不要**在 `ci.yml` 里另抄一份命令。

> 自测兜底：`scripts/test-report.test.mjs` 会校验"id 不重复 / 命令引用的脚本真实存在 /
> 本地默认组不许依赖浏览器或 cargo / 标了 baseline 就必须有 counters / CI 必需门禁一条不少 /
> 外部套件登记字段完整"。
> 汇总器自己的**纯逻辑**（读数解析、基线判定、markdown 渲染、状态回写）在
> `scripts/lib/report-core.mjs`，由 `scripts/lib/report-core.test.mjs`（23 条）覆盖——
> 门禁清单和它的仪器**都**进了回归，它们同样是一种会被顺手改坏的代码。
> 那次"把 `check-plugin-hosting` 的进度数字当成 `2280/4560 断言`"的事故，其回归用例也在那里。
