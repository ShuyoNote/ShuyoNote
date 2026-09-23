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

<!-- facts:begin -->
门禁 44 条（contract 20 / smoke 3 / sync 1 / plugin 3 / browser 3 / mobile 3 / rust 8 / artifact 3）· 能力 25 条 · 命令 Rust 241 / web 243 / CommandMap 244
<!-- facts:end -->

> ⚠️ 上面这一段**由 `scripts/check-doc-facts.mjs` 门禁核对**：改了注册表／能力／命令面就要同步改它，否则红；
> 同一条门禁还要求**每条门禁的名字都出现在本表里**（新门禁不许只进代码、不进文档）。
> 表里的"断言数"会随测试增减，**数字以 `tests/baseline.json` 与每次运行的读数为准**，别照着这里的旧数字对账。

| 组 | 门禁 | 挡什么 |
| --- | --- | --- |
| contract | `check-versions` / `check-changelog` | 版本号、CHANGELOG 与发布状态脱节 |
| contract | `check-changelog-numbers` | 发版说明里的断言数被手抄漂移：**最新一段**里"套件名 + 数字"一对一绑定时必须等于基线（历史段落不碰；多套件/多数字/带 `历史`·`豁免` 的行跳过——宁可不判，也不误报） |
| contract | `check-web-commands` / `check-capabilities` | web 与桌面两侧命令契约、能力注册表漂移 |
| contract | `check-doc-links` | 文档相对链接变死链 |
| contract | `check-doc-facts` | 文档里的**机器事实**（门禁条数／能力条数／命令数）与代码脱节：这类数字靠人抄，抄错不报错，只会让照文档做的人做到一半发现文档是旧的。它还要求**每条门禁都在本表里有名字**（上线当天抓到 7 条漏写） |
| contract | `check-workflow-yaml` | workflow 里"裸标量以 `:` 结尾"⇒ 非法 YAML ⇒ 0 个 job 的红 run（2026-09-12：49 次 push 全红无人察觉） |
| contract | `check-gitcode-workflow-rules` | `.gitcode/workflows/*.yml` 的三条**平台**约束（runs-on 白名单 / 每个 step 必须有合法 `name` / action 用 `actions/xxx@vN`）——不合法时整条流水线不会被调度；规则由 GitCode 校验接口实测得出 |
| contract | `check-overlay-registry` | 浮层没登记进返回栈 ⇒ 真机返回键直接退出应用（2026-09-15 第 6 个真机问题） |
| contract | `check-ps1-ascii` | 无 BOM 的 UTF-8 `.ps1` 在 PS 5.1 下报假语法错误（2026-09-11） |
| contract | `check-pdfjs-shim` | 老 WebView 上打不开 PDF：补齐层的 install 顺序最容易被"顺手整理"破坏 |
| contract | `check-ocr-assets` / `check-deep-link` / `check-plugin-hosting` | 运行时资源清单、`shuyonote://` 交付通道、插件托管 |
| contract | `check-sys-deps` | 构建期依赖**登记**与本机工具链：新依赖进来而映射没更新（未登记的 `*-sys` 即红）；同日两类真事故——发布机清掉 `libssl-dev`、本机 Xcode 27 装完许可未接受（`notarytool` 一条探针即可发现）。工具链探针**两张表**：macOS（`xcode-select`/SDK/`notarytool`/`codesign`/`clang`）与 **Windows（2026-09-20 补）**——硬判据 `vswhere-msvc`（VC 工具链）/`windows-sdk`/`webview2`（运行时：没它装完打不开），`kind: "info"` 的 `makensis`/`signtool` **只报不判**（tauri 自己取 NSIS、签名只在发版要） |
| contract | `check-changelog-version-parity` | 已发布标题与版本文件**同改**：只把 CHANGELOG 的标题往前挪、忘了 bump 版本号（或反过来）⇒ 用户看到的"新版本"里没有这次改动 |
| contract | `check-nsis-template` | NSIS 安装器模板＝fork 的一行改动 ＋ CLI 版本核对：模板被上游改写后**装出来的东西**与声明不符 |
| contract | `check-derived-writers` | 派生表的**唯一写入者**：Rust 生产代码不许写派生表（唯一写入口在 TS 侧平台层）——两处写就是两份语义 |
| contract | `check-doc-content-access` | 「文档内容」的直接访问**只减不增**：换 CRDT 时要改的就是这批位置（当前 562 处，基线在 `scripts/doc-content-access-baseline.json`）；新文件直接引用或超基线即红 |
| mobile | `mobile-views` | 主区整视图 ＋ 属性表 ＋ 小控件 ＋ **PDF 阅读器真 DOM**：窄屏下"整块视图不能用"这类坏法，布局门禁照不到 |
| rust | `gm-conformance` | 国密对拍：这条线**同时保两份 SM4 实现**（应用层 RustCrypto / 库级 Tongsuo）⇒ 漂移的后果是"跨设备读不出对方的数据"，而它没有任何编译期信号 |
| rust | `rust-no-sm-crypto` | **回滚通道**：`--no-default-features`（不编国密）仍要能编译 ＋ 全量单测通过 —— 它是"一行可逆"那个承诺的实现，没人编就会腐烂 |
| rust | `check-sys-deps-linux` | 上面那条的 **deb 实查**版：硬判据只能来自 `ci.yml` 的 `Linux system deps` 步，逐条按 `dpkg` 实查（表里凭空要求 CI 不装的包 ⇒ 门禁自己就是假话）。挂在 rust 组是因为**只有**这个 job 装了 Tauri 那套系统包 |
| smoke | `tsc` | 类型错误 |
| smoke | `vitest` | 单测回归（**885 用例**） |
| smoke | `smoke-web` | web 平台行为（**350 断言**，事实标准） |
| sync | `two-device-sync` | 两设备并发编辑的同步一致性（真实 `applyChange` + 真实 sql.js） |
| plugin | `examples-tsc` / `plugin-cli-validate` / `plugin-new-smoke` | "只看文档就能写出插件"：类型包、作者 CLI、脚手架生成的起点当场可用 |
| browser | `check-pdf-reload` | StrictMode 下 PDF 二次加载交回已 detach 的 buffer（8 断言） |
| browser | `check-panel-layout` | "文字被挤成一条竖柱"这类纯几何问题（40 断言） |
| browser | `check-web-build` | 构建产物打不开：v1.84.1 删掉 sql.js wasm / pdf worker，页面照开但 DB 初始化失败（8 断言） |
| mobile | `mobile-layout` / `mobile-overlays` | 窄屏布局与浮层三类"功能直接不可用且不报错"的坏法（43 / 979 断言） |
| rust | `rust-test` / `rust-plugins-alone` | Rust 单测 + 宿主子进程集成；插件测试必须能**单独跑**（2026-09-13：单跑必红、全量反而绿） |
| rust | `rust-sm-wired` | ★ **库级国密接线构建**：打补丁 ＋ `--features sm-library` 下跑全量单测。理由＝应用接线（`apply_gm_page_settings`）整段在 `#[cfg(feature = "sm-library")]` 后面，而**其余 rust 门禁全跑默认特性** ⇒ 那条路本来没有任何门禁碰过（2026-09-22：我在本机把发版链原样跑一遍，才发现「只清 dev profile ⇒ release 旧 SQLCipher 被复用 ⇒ 包表面全对而库级不是国密」）。无 SM 版 OpenSSL 前缀时**自报跳过**（Linux 自动用 `/usr`；macOS 需给 `OPENSSL_DIR`）。它跑完会**还原补丁并重建默认特性**，不留混态。<br>⚠️ **win32 上显式 `--skip plugins::`**（2026-09-22 AMD 在 Windows 上第一次真跑逼出来的）：那 34 条要**真宿主进程**，Windows 本机跑不了 ⇒ 实测 **455 passed / 34 failed / 18 ignored，34 条全在 `plugins::`，国密各组失败 0 条**。取舍：**显式 skip（自报排除了什么）而不是"允许失败 34 条"** —— 数字豁免会在插件测试增减时悄悄改变含义；**只在 win32 skip，模式精确到 `plugins::`**（判据对两个平台做整数组相等断言，放宽模式当场红）；**其余集合仍要求 `failed === 0`**。那一组的权威读数归 CI/WSL2 的 `rust-plugins-alone` 与 Windows 的 `win-cargo-test.ps1`。<br>★ **win32 上是"未实查"而不是红**（2026-09-22 AMD 把这条路走到底的结论）：Windows 上 `cargo test` 生成测试 exe **不带应用清单** ⇒ **两层、互相独立、都要补**——① `0xC0000135` 缺 DLL（PATH 层，门禁已用 `testPathFor` 把 `<前缀>\bin` 并到最前）；② `0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND` **缺 v6 清单**（`Microsoft.Windows.Common-Controls`），只有 `win-cargo-test.ps1` 会注入清单。四组读数：裸 `cargo test`（无 PATH 修复）`0xC0000135` → 跑器注入清单但无 PATH **仍** `0xC0000135` → 跑器＋PATH **跑起来**（455/34/18，34 全 `plugins::`）→ 裸 `cargo test`＋PATH 修复 `0xC0000139`。⇒ 门禁认出这类**装载期**失败后**自报未实查并 exit 0**（附独立读数与下一步），与 macOS 缺静态前缀、`check-crypto-backend` 的"旧产物⇒未实查"同一条纪律；★ **win32 自产读数已走通（2026-09-23）**：跑器加了 `-PrintExePath`（构建＋注入 v6 清单＋打印副本路径）与 `-Skip <patterns>`（展开成原生 `--skip`，避免 `-ExtraArgs` 静默错绑），门禁据此**自己跑那个副本**（`--skip plugins::`）并**自己解析 `test result:` 自判**（`winRunnerPrintArgs` / `manifestCopyPath` / `winSelfRunArgs` / `runPowerShellSafe`，各有判据；`manifestCopyPath` 取**最后**一条带前缀的行 —— 跑器作为子进程时它的进度行也会落到 stdout）。win32 实测：全量 **508 passed / 0 failed / 18 ignored**，`-Skip plugins::` **385 passed / 124 filtered out / exit 0**（门禁自己的下限仍是 380 passed ＋ 0 failed）。⇒ 这条门禁在 win32 上**不再只能自报未实查**；只有跑器那条路走不通（脚本缺失 / 执行策略挡下）才退回未实查，且退回时会把原因打出来|
| rust | `gm-registry-clean` | ★ **补丁残留在全机共享 registry 上**（AMD 2026-09-22 落地；方案 §五 里唯一归属他的那一行）。`sm-library-build.mjs` **刻意不自动还原**（自动还原会造出「源码是 AES、产物是 SM4」的**新**静默态）⇒ "跑过一次国密构建、忘了 `--revert`"会把这台机器留在**看不见的状态**里：**macOS 上后续默认构建红 12＋7 条，而现场长得像加密库坏了**；Linux/Windows 上不红，但后续默认构建被**静默**改成写 SM4 页。三档判定：原版 / 本次就是 `sm-library` 构建 ⇒ `ok`；带补丁 ∧ 非 darwin ⇒ **`notice`（不判红，但说清会被静默改页加密）**；带补丁 ∧ darwin 默认构建 ⇒ **`block`（exit 1 ＋ 给出 `--revert` 那一行）**；**读不出来**（没跑过 cargo / 拿不到 `Cargo.lock`）⇒ `notice`（与 `check-crypto-backend` 的「旧产物 ⇒ 未实查」同口径）。⚠️ **macOS 上刚跑完国密构建还没 `--revert` 时它会红 —— 这是刻意的**（判据替你记住那件事）。它**只读**（连调 3 次 CLI，源码 SM3 命中恒为 50）；13 条判据 ＋ 变异 2 条 |
| artifact | `external-index` / `external-package` | 我们打出的包与索引，应用**真**解析器 / 真校验器认不认 |
| artifact | `plugin-fragment-no-zip` | 打包依赖命令行 `zip`（Windows 上没有它，那边 `pnpm test` 红过三条） |

## 断言数基线（`tests/baseline.json`）

```json
{ "counts": { "vitest": 702, "smoke-web": 350, "mobile-overlays": 979, ... },
  "gates":  { "contract": ["check-versions", ...], "smoke": [...] } }
```

两件事被机器校验：

1. **只增不减**：上表里带读数的门禁（`vitest` / `smoke-web` / `check-pdf-reload` / `check-panel-layout` /
   `check-web-build` / `mobile-layout` / `mobile-overlays` / `rust-test` / `rust-plugins-alone`）跑出来的用例数**低于**基线即 CI 红。
   此前"117 → 223 → … → 350 只增不减"只是计划文档里的纪律，删一条断言不会有任何东西变红。
2. **门禁集合**：`gates` 段记录每个组应有的门禁 id。少一条（被删掉 / 改了名而没同步）即 CI 红——
   那一刻没有任何测试会变红，正是最危险的一类退化。

改了断言数量就更新基线（**请在 PR 里说明为什么**）：

```powershell
node scripts/test-report.mjs --group contract,smoke,sync,plugin --update-baseline
node scripts/test-report.mjs --group browser,mobile --update-baseline   # 需要 dev server
```

> 两条方向都要能解释（Windows 侧 2026-09-16 补的口径）：
> **降**要说明删了什么（那是硬约束，会红）；**升**也要说明多的是什么——
> 例如 rust 从 298 涨到 310 是"集成测试目标这次终于跑到了"（`cargo test` 默认 fail-fast，
> lib 一红后面就不跑），而不是凭空多出 12 条用例。基线只比较**状态为 passed** 的门禁。

> ⚠️ 小坑（实测）：新增门禁后跑 `--update-baseline` 时，这一轮里 `vitest` 会红一次
> （`701/702`）——因为自测断言"注册表里每条门禁都必须登记在基线里"，而基线是**跑完才写**的。
> 写完再跑一次就是绿的；CI 上看不到这个中间态。

### 下界**太旧**：只提示，不判红（2026-09-19）

"只增不减"只管**下降**。可下界也可能低到没有意义 —— 实测过：`vitest` 记着 **746**，而当前读数是 **1303**
（= 删掉 500 条测试也照样绿）。所以补了一条**体检**（`report-core.mjs::staleBaselineNotices`）：

| 情形 | 判据 | 后果 |
|---|---|---|
| 读数**下降** | `baselineViolations` | **红**（硬约束） |
| 下界 **< 当前 80%** | `staleBaselineNotices` | 只打 `! 基线提示：…`（同时进 `--json` 的 `baselineNotices` 与 markdown 摘要） |

**为什么"太旧"不能也判红**（macOS 侧 2026-09-19 的理由，我同意）：读数上涨是**正常事**，
判红就等于逼人每加一批测试都改基线，最后大家会习惯性 `--update-baseline`，**护栏反而失效**。
后果不同 ⇒ 处置不同。

### 写判据的纪律：变异证明不是形式（2026-09-19 的两条实测）

1. **"空输出"≠"零命中"**。我用 `cargo check … | grep -E "^(warning|error)"` 数警告，
   而那段挂在 `&&` 链里、输出被吃掉 ⇒ **空输出被我读成了"零警告"**，直到 macOS 侧独立数出 8 条。
   ⇒ 数任何东西都要**打印计数**（`warning 行数: 0` 才算数），别只看"有没有输出"。
2. **变异证明要能替你改对判据**（比"3/3 全抓"更值钱）。同一天里它抓到我一条**摆设判据**：
   基线太旧提示里 `expected >= actual` 那行显式排除，在默认阈值 80% 下**永远走不到**
   （读数下降时比值 >100%，早被比例判断挡住）⇒ 那条断言怎么改都绿。把判据改成 `thresholdPct: 250`
   真正走到那个分支之后，变异才被抓住。
   ⇒ 结论：**变异证明的价值不在"全抓"，而在"它能发现哪条判据其实没在守东西"。**
3. **退出码要在"正确的位置"看**（2026-09-20，三台机器各栽一次 —— 这是同一条坑的三次现身）：
   - **后台/管道**：`cmd > log 2>&1; echo "exit=$?"` 写在**管道后面** ⇒ 拿到的是 `tail`/`grep` 的退出码，
     不是 `cmd` 的；
   - **被吞掉的失败**：`cargo clean -p X >/dev/null 2>&1` 漏了 `--manifest-path` ⇒ 在仓库根跑、`exit=101`，
     而我把输出丢进 `/dev/null` ⇒ 后面"构建"根本没重编，**两轮 A/B 的数字全是装饰**
     （AMD 这轮实测：v1 与 v2 给出逐条相同的结果就是这么来的）；
   - **管道截断**：`cmd | Select-Object -First N` 会让上游拿到 `SIGPIPE` ⇒ 命令是成功的、退出码却是 1。
   ⇒ 纪律：**要判成败就单独跑一次、把退出码取在命令本身上**（`cmd > log 2>&1; echo $?`），
   再让**日志**去做筛选；筛选的输出**永远不能**当成败依据。
   ⚠️ **更正（2026-09-20，macOS 侧指出）**：本条初稿把"macOS 侧那条假红"当成"管道取错退出码"的例子 ——
   **归因错了**。那条假红的根因是**命令行漏了声明**（只给了 `SHUYONOTE_EXPECT_SM_PATCH`，
  忘了 macOS 平台默认后端是 commoncrypto）⇒ **门禁报的是对的**；"`$?` 取在管道后"是**另一件事**
   （它也真实存在，但没造成那条假红）。⇒ 教训加一条：**归因也要有判据** ——
   "现象出现过"不等于"这个现象是它的原因"，别把同一段时间里的两件事写成因果。
4. **"合完再 rebase" = 把 merge 丢掉**（2026-09-20，AMD 实测自伤一次）：合了别人的分支（`git merge --no-ff`）
   之后，若之后按平时习惯跑 `git pull --rebase` / `git rebase`，**rebase 默认丢弃 merge 提交** ⇒
   那次合并**静默消失**，而推送照样成功、看不出任何异常。
   ⇒ 纪律：**一旦产生过 merge 提交，之后的同步必须用 fetch+merge**；并且**推之前复核**
   `git merge-base --is-ancestor <对方的 tip> HEAD`（一行、可判真假）——这条正是把"我以为合了"变成"确实合了"的那一步。


## 结果公开在哪

| 位置 | 形态 | 保留 |
| --- | --- | --- |
| GitHub Actions **step summary** | 人可读表格（每条门禁的结果、断言数、耗时、失败明细、跳过的门禁） | 随 run |
| GitHub Actions **artifact** | `test-report-*.json`（机器可读，可做趋势 / 断言） | 30 天 |
| GitCode 流水线日志 | 同一张表（GitCode 没有 step summary 机制） | 随 run |
| README 徽章 | GitHub 镜像 CI 当前状态 | 实时 |
| `pnpm release:preflight` | 第 ⑦ 项直接读最近一份报告：**红了就不让打 tag**，并打印上面那行汇总 | 每次发版 |
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

CHANGELOG / 发版说明里"门禁全绿：… 732 用例 …"这类句子**不要人肉从终端抄**（抄错的数字
在下一次改动后就成了假话，而且没人会发现）。加 `--line` 会多打一行可直接粘贴的汇总：

```powershell
node scripts/test-report.mjs --line
# 门禁全绿：smoke 3/3/1089 断言、sync 1/1/14 断言、…；合计 1209 条断言/用例。
```

而且这句话**现在会被机器核对**：`check-changelog-numbers`（contract 组）只看 CHANGELOG 的
**最新一段**——当某一行把某个套件名与一个数字绑在一起时，那个数字必须等于基线；
历史段落一律不碰，含 `历史` / `此前` / `曾` / `豁免` 的行跳过，一行里出现多个套件或多个数字
也跳过（说不清对应谁就不判）。**宁可不判，也不误报**——会误报的门禁很快就会被绕过，等于没有。

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

## 把 CI 的读数并进基线（`--baseline-from`）

有些门禁本机跑不了（最典型：**rust 全量组**里有 34 条 `plugins::` 用例要起真宿主进程；Windows 本机
可以用 `scripts\win-cargo-test.ps1` 跑 **lib 目标**，但全量仍属 Linux，见下文"已知边界"）。CI 跑出来的
JSON 报告可以直接并入基线，不用手抄数字、也不用人工算术：

```powershell
# 1) 让 Linux 侧跑一次 rust 组并留下报告
#    · GitCode：手动运行 .gitcode/workflows/rust-baseline.yml → 下载 rust-report.json
#    · GitHub：ci.yml 的 rust-tests job 已经跑 --group rust，从 artifact 里取 test-report-rust.json
# 2) 并入（只写 tests/baseline.json 的读数值，不跑任何门禁）
node scripts/test-report.mjs --baseline-from rust-report.json
```

输出会逐条告诉你两件事：读数从多少变成多少；
以及**它是否受基线契约保护**——`baseline.json` 的 `counts` 是"读数值"，注册表的
`baseline: true` 才是"契约（缺失即违规）"。脚本**不擅自**改契约，要生效就在
`scripts/lib/gates.mjs` 给对应门禁补上 `baseline: true`。若报告里的门禁 `status` 不是 `passed`，
并入时会显式提醒"读数已并入，但请人工确认它可信"。

## 覆盖边界（诚实清单）

- **不在本仓库跑的**（登记在 `tests/external-suites.json`，并出现在每轮汇总里）：
  `sync-regression` / `sync-collab-regression` 需要真实同步服务端，跑在**私有**服务端仓库的 CI
  （那边能直接构建二进制）；真机手动验收（Android 开加密→重启→解锁、macOS 公证与自动更新）由人执行。
  这三条的状态回写走 `scripts/external-suite-status.mjs`（见上一节）。
- **GitCode 侧只跑纯 Node 组**（`.gitcode/workflows/ci.yml`）：EulerOS runner 上没有浏览器，
  browser / mobile 组要真实 Chromium，rust 组要 webkit2gtk 一整套系统依赖——那三组留在 GitHub 侧。
  该文件与 `rust-baseline.yml` 已通过 **GitCode 自己的校验接口**（`valid=true`，2026-09-16）：

  ```
  POST https://api.gitcode.com/api/v8/repos/:owner/:repo/actions/workflows/validate?access_token=<token>
  body: {"base64_content": "<yml 的 base64>"}        →  {valid, diagnostics[]}
  ```
  仓库里带了这个接口的封装：`pnpm gitcode:validate`（读 `GITCODE_TOKEN`；**不进 CI**——它要 token + 外网，
  而门禁必须是离线可跑的）。改过 `.gitcode/workflows/*.yml` 后建议两条都跑：离线门禁 + 这个权威校验。
  三条平台约束（GitHub 侧没有，照抄 GitHub 写法会踩；已固化成 `check-gitcode-workflow-rules` 门禁）：
  `runs-on` 单串只接受 `default / ubuntu-latest / euler-latest / ubuntu-24 / ubuntu-22`（仓库原有的
  `euleros-2.10.1` **不在**白名单）；每个 step 必须有合法 `name`（字符集受限，全角逗号与加号都不行）；
  action 只能用 `actions/xxx@vN`（`checkout-action@0.0.1` 这类简写校验器报"不存在"）。
  ⚠️ 剩下的边界只是**运行时**：本机没有 GitCode runner，所以"真跑一次"仍待首次合并到默认分支后确认。
- **happy-dom 不等于浏览器**：`vitest` 跑在 happy-dom 里，**不做布局**、不按视口重算媒体查询，
  所以"文字挤成竖柱""弹层关不上"这类只能靠 browser / mobile 组（真实 Chromium）兜。
- ⚠️ **Windows 上 `cargo test` 的红有三种形态 —— 看到红的第一件事是「认形态」**（2026-09-20 补齐）：
  三种形态的现场、结论、修法完全不同；把它们混成一句"Windows 上跑不了 rust 测试"会让下一个人白查一轮。

  | 形态 | 现场 | 结论 | 怎么办 |
  |---|---|---|---|
  | ① **加载期就死** | 进程直接以 `0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND` 退出，**连 `running N tests` 都没有** | 测试 exe 缺应用清单 | `powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1`（见下一条） |
  | ② **`plugins::` 整片红** | 跑了，但 36 条**全是** `plugins::tests::*`，现场写"找不到宿主二进制" | 宿主二进制不在 | 先 `cargo build --bin shuyonote`，或跑**全量** `cargo test`（它会先构建应用二进制）（见下文那条） |
  | ③ **正常** | lib 目标跑起来；与代码无关的只有环境项（例如本机没有 PDFium 库 ⇒ 那条**响亮跳过**） | 可以当读数用 | 读数记 `passed + failed`（**不计 ignored**） |

  ⚠️ 区分 ① 与 ② 的**唯一判据**是"有没有输出 `running N tests`"：① 没有那行。
  （2026-09-20 补：用 ① 的绕法在本机跑通了 `pdfium_native` 的 **7 条**——其中 4 条属于"随包字体"那条线，
  全部在 Windows 上跑、**没上 WSL** ⇒ 这条路是**可用**的，不是"只好躲到 Linux"。）
- **Windows 本机跑 rust 组：要过一道 manifest 关**（2026-09-16 撞上，2026-09-19 定位）：症状是
  `cargo test` 的测试二进制在**加载期**就以 `0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND` 退出，而
  app（`shuyonote.exe`）能正常跑、且它的导入符号是测试二进制的**超集**。已逐条排除：缺 DLL（含
  把 CRT/OpenSSL 副本放到 `target\debug` 和 PATH 前）、CRT 版本、PATH、OpenSSL 版本、pdfium、
  以及沙箱本身（离开本 harness、用日程任务跑同样失败）——**不是**环境缺件。
  根因：cargo 生成的测试 exe **没有应用清单**，加载器因此把 `comctl32` 绑到旧的 v5，而测试 exe 的
  静态导入里有**只有 v6 才导出**的入口点。
  修法（一条命令，仓库里不改任何被跟踪的东西）：
  `powershell -ExecutionPolicy Bypass -File scripts\win-cargo-test.ps1`
  （过滤单组加 `-Filter storage::tests::`，透传参数加 `-ExtraArgs --nocapture`，只构建不跑加 `-NoRun`；
  需要 Windows SDK 的 `mt.exe`，`OPENSSL_DIR` 未设时脚本会先提示。）
  脚本做四件事：`cargo test --no-run --lib` → 把测试 exe 复制成**同目录、带时间戳的唯一名**副本 →
  `mt.exe -manifest <v6> -outputresource:<copy>;1` 注入 → 跑副本并把**它的退出码原样转发**。
  注入后用字节扫描确认清单**真的落进了副本**——否则会拿旧 exe 读出一个假绿。
  脚本注释里记了三个坑：PS 5.1 会把 cargo 的原生 stderr 当**终止**错误（要先放宽
  `$ErrorActionPreference`）；**复用"已经执行过"的副本路径**会让 `mt.exe` 报
  `c101008d`（所以每次换新名字）；刚写出来的 60+ MB 副本还会被杀软短暂占住（重试 3 次）。
  ⚠️ 这条路只覆盖 **lib 测试目标**：`rust-plugins-alone` 那 34 条要起**真宿主进程**，所以权威执行地
  仍然是 **Linux**：CI，或**本机 WSL2**（Ubuntu 24.04 + `build-essential` +
  `libwebkit2gtk-4.1-dev` + `libssl-dev` + `libclang-dev` + rustup，源码从 `/mnt/c` 读、
  `CARGO_TARGET_DIR` 放到 ext4 避开 9p 慢盘）。两条 rust 门禁的读数**已用这条路实测并进基线**
  （`rust-test 310` / `rust-plugins-alone 114`，取自 `dev@dc7fa13b`）。
  ⚠️ 顺序不是可选的：`rust-plugins-alone`（`--lib plugins::`）里有 34 条用例要起**真宿主进程**，
  宿主二进制不存在时会以"找不到宿主二进制"整片红——所以**全量 `cargo test` 必须先跑**
  （`ci.yml` 的 rust-tests job 与 reporter 的 rust 组都是这个顺序）。
  ⚠️ 读数是 `passed + failed` 之和（不计 `ignored`），且 **`cargo test` 默认 fail-fast**：
  前一个测试目标失败时，后面的目标（`main.rs` / `tests/plugin_host.rs` / doc-tests）**不会跑**，
  于是同样一棵树"红的时候读数会显得更少"（实测：lib 失败 → 298；lib 通过 → 298 + 集成 12 = 310）。
  这是 cargo 的预期行为，不是回归——所以基线校验只比较**状态为 passed** 的门禁。
- **artifact 组**需要先打一个真包（`scripts/plugin-fragment.mjs --ephemeral-key`）并设置
  `SHUYONOTE_*` 环境变量；缺变量时**显式跳过**（`--strict` 下按失败计），不会冒充通过。
- **看到 `plugins::` 大批红，先确认宿主二进制在不在**（2026-09-19：macOS 侧交底、AMD 复现）：
  干净 worktree / 没编过应用二进制的树里跑 `cargo test --lib` ⇒ `307 passed / 36 failed / 5 ignored`，
  36 条**全是** `plugins::tests::*`，现场写的是"找不到宿主二进制 `…/target/debug/shuyonote`：请用
  `cargo test`（会先构建应用二进制），不要用 `cargo test --lib`"。先 `cargo build --bin shuyonote`
  再跑 `--lib` ⇒ `341 passed / 2 failed`（那 2 条是 PDFium 环境项，与代码无关）。
  ⚠️ **不要**把这条写成"worktree 一定假红"——AMD 的 `ShuyoNote-bm25` worktree 跑整支是 **343/0/5**，
  因为那棵树里 `target/debug/` 已经有宿主二进制了。**判据是"宿主二进制在不在"，不是"是不是 worktree"**
  （macOS 侧最初的措辞就是被这个读数证伪的）。
- **`cargo` 不在 `PATH` 上，看起来像"夹具坏了"**（macOS 侧 `development.md` 第 7 条，2026-09-19 镜像到本文）：
  rustup 装在 `~/.cargo/bin`，某些环境（非登录 shell、CI 的裸 exec）不把它带进 `PATH` ⇒ 脚本以
  `gm-conformance: ❌ 夹具编不过 / spawnSync cargo ENOENT` 的形式失败，读起来完全像夹具本身有问题。
  `scripts/gm-version-selfcheck.mjs` 里加了兜底：`PATH` 上没有、rustup 默认位置有时补上，并打一行 `!`
  —— **不静默改环境**（改了就会让"我这台能跑"变成不可复现的读数）。
- **共享检出的 `node_modules` 可能是"半装"状态**（2026-09-20，本机 Windows 实测；与上文"有人重装的那几分钟"是**两种**形态）：
  症状是 `vitest` / `pnpm build` **全挂**，而报错长得像"代码坏了"：
  `Error: Cannot find package '…/.pnpm/vitest@4.1.11…/node_modules/tinyexec/index.js'`、
  `Cannot find module '…/@esbuild/win32-x64/esbuild.exe'` —— 即 `.pnpm` 里少了传递依赖的实体；
  更坑的是 `npx tsc` 那种入口此时会**静默从 registry 装一个同名假包**（见本文上面那条）。
  **修法（34 秒、离线、只动自己那棵树）**：把自己的 `node_modules` 从 **junction** 换成真实目录，
  再用**本地 pnpm store** 重装：
  ```powershell
  cmd /c "rmdir node_modules"        # ⚠️ 只删 junction 本身；不要 Remove-Item -Recurse（会删到别人那棵树）
  pnpm install --frozen-lockfile --offline
  ```
  判定修好了：`node node_modules/vitest/vitest.mjs --version` 有输出、`node node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild --version` 有版本。
  **收益是实打实的**：修好后本机第一次跑出 `vitest 17/17`，并当场抓到"跑 git 的用例缺显式 timeout ⇒
  Windows 上 5s 默认超时偶发红"这个 flake（`scripts/check-changelog-version-parity.test.mjs` 已修）。
- **`import.meta.dirname` 在旧 Node 上是 `undefined`**（2026-09-19，WSL 的 Node 18 实测）：
  `resolve(import.meta.dirname, "..")` 直接抛
  `ERR_INVALID_ARG_TYPE: The "paths[0]" argument must be of type string` —— 报错文本一个字都没提 Node 版本，
  读起来像"路径写错了"。它要 Node ≥ 20.11，而本仓要能在 CI/旧 Node 上跑 ⇒ 统一写
  `dirname(fileURLToPath(import.meta.url))`（`scripts/sm-library-build.mjs` 的注释里也记了这条）。
- **别在判据里写死平台字面量**（2026-09-20，本机 Windows 实测）：`join("/opt/tongsuo", "bin", "openssl")`
  在 Windows 上产出 `\opt\tongsuo\bin\openssl`（当前盘根），在 macOS/Linux 上才是 `/opt/tongsuo/bin/openssl`
  ⇒ 把**期望值**写成 POSIX 字面量的判据**只在 Windows 红**（现场：`scripts/gm-version-selfcheck.test.mjs`
  一条，`vitest` 整组红：`1 failed | 1359 passed`）。**修法**：期望值用**同一个 `join`** 现算
  （跟着那个 `base` 走，别再抄一份字面量）。同族三条（本条 ＋ 上面两条）都是**本平台自测绿、换一台就红**。
- ✅ **安卓包现在能在 Windows 本机出了（2026-09-21 打通，实测产出 59.5 MB 的 unsigned universal APK）**。
  这一节原先记的是"本机出不了"，三条拦路石逐条变成了可执行的步骤：
  1. **`openssl-src` 要 `perl`**：**不用装完整 perl**。Git for Windows 自带的那份只缺几个**纯 Perl** 模块
     （`Locale::Maketext`/`::Simple`、`ExtUtils::MakeMaker`、`Pod::Usage`/`Pod::Simple`/`Pod::Text`/`Pod::Man`/
     `Pod::Escapes`、`ExtUtils::Install`/`::Manifest`、`Text::Template`、`File::Which`），而 **CPAN 本机可达**：
     ```powershell
     powershell -ExecutionPolicy Bypass -File scripts\setup-local-perl.ps1
     # ⇒ 把上面那些抓进 ~/.local-perl5/lib；构建时设 $env:PERL5LIB 指向它
     ```
     ⚠️ 两条"标准做法"在本机都是**死路**（都要从 github.com 取 MSI，本机不通）：
     `winget install StrawberryPerl.StrawberryPerl` ⇒ `InternetOpenUrl() failed 0x80072efd`；
     `choco install strawberryperl -y` ⇒ 同源、`exited 404`（`activeperl` 那条 choco 自己也标了 "likely broken"）。
     也**不要**指望 git 的 perl 裸用：它连 `Locale::Maketext` 都没有 ⇒ `IPC::Cmd` → `Params::Check` 整条起不来
     （cmd / PowerShell / Git Bash 三种壳同一条）。
  2. **OpenSSL 的 `make` 把 NDK 路径的反斜杠吃掉**（`/usr/bin/sh` 是 msys sh）：
     `C:\…\ndk\29…\bin\clang.exe` → `C:UserscnzenAppData…binclang.exe` ⇒ `Error 127`。
     解法：**把工具链路径用正斜杠喂给构建**（cargo 风格的环境变量也得喂，因为 tauri/cc 会把带反斜杠的
     `TARGET_CC` 塞进去）：`CC_aarch64_linux_android` / `AR_…` / `RANLIB_…` / `TARGET_CC` / `TARGET_AR` /
     `TARGET_RANLIB` = `…/bin/clang.exe`、`…/bin/llvm-ar.exe`、`…/bin/llvm-ranlib.exe`（**正斜杠**），
     并且保证 `C:\Program Files\Git\usr\bin`（`sh.exe`）在 PATH 上 —— openssl 的 Makefile 要 sh。
  3. **Gradle 那条 `node tauri …`**：`tauri android init` 会把"用哪个可执行文件 + 什么参数"烘进生成的
     `gen/android/buildSrc/…/BuildTask.kt`。本机那份是 `executable = "node"` + `args = ["tauri", …]`
     ⇒ node 把 `tauri` 当模块名找 ⇒ `Cannot find module '…\src-tauri\tauri'`，
     `Execution failed for task ':app:rustBuildArm64Release'`。修法：
     ```powershell
     node scripts/patch-android-buildtask.mjs      # 改成显式 `node <node_modules/@tauri-apps/cli/tauri.js> …`
     ```
     （CI 的 Android job 没这个问题 ⇒ **这条只在本机补，不进 CI**。）

  **完整配方**（`init` 会把 `gen/` 重新生成 ⇒ 之后**这几步都要重跑**）：
  ```powershell
  $ndk = "$env:LOCALAPPDATA\Android\Sdk\ndk\29.0.13846066\toolchains\llvm\prebuilt\windows-x86_64\bin".Replace('\','/')
  $env:PERL5LIB = "$env:USERPROFILE\.local-perl5\lib"
  $env:PATH = "$env:PATH;C:\Program Files\Git\usr\bin"
  foreach ($v in 'CC','AR','RANLIB') { Set-Item "env:${v}_aarch64_linux_android" "$ndk/$(if ($v -eq 'CC') {'clang'} elseif ($v -eq 'AR') {'llvm-ar'} else {'llvm-ranlib'}).exe" }
  $env:TARGET_CC = "$ndk/clang.exe"; $env:TARGET_AR = "$ndk/llvm-ar.exe"; $env:TARGET_RANLIB = "$ndk/llvm-ranlib.exe"
  $env:CFLAGS_aarch64_linux_android = "--target=aarch64-linux-android24"

  node_modules\.bin\tauri.CMD android init --ci
  node scripts/android-platform-verifier.mjs
  node scripts/android-mobile-shell.mjs
  node scripts/android-app-icon.mjs
  node scripts/stage-android-pdfium.mjs
  node scripts/patch-android-buildtask.mjs
  node_modules\.bin\tauri.CMD android build --target aarch64 --apk --ci   # ⇒ gen/android/app/build/outputs/apk/**/release/*-unsigned.apk
  ```
  出包后按 ⑨ 的签名步骤用**正式密钥**签（`zipalign -f -p 4` → `apksigner sign --ks … --ks-key-alias shuyonote`
  → `apksigner verify --print-certs` 指纹应为 `6ee89e6f…7a88`），装到手机时注意：
  **本机构建的 versionCode 取自 `dev` 的版本号，通常低于已发布版 ⇒ `adb install -r -d`**（`-d` 允许降级；
  同签名不会丢数据）。首次全新构建约 35–40 分钟（OpenSSL 在 Windows 上编得慢），之后有缓存约 6–8 分钟。
  ⇒ 本仓的**发版**安卓包仍然由 **CI 的 ubuntu runner**（`android.yml` 的 `runs-on: ubuntu-latest`）产出；
  本机这条路是"要快速看真机效果 / 没网时自测"用的。
   ⚠️ 但**打包与验收那几小步在 Windows 上是可以跑的**（离线、零依赖）：`pnpm android:stage-pdfium`（把库放进 `jniLibs/`）、
     `pnpm android:app-icon`（把品牌图标铺进 `res/`；不铺的话 APK 桌面图标是 Tauri 默认图，
     见 `scripts/android-app-icon.mjs` 的模块头；**改图标本身**走 `node scripts/build-android-icons.mjs`，
     源是 `design/logo/android-*.svg` ＋ `android-icon.json`，见 `design/logo/README.md`）与 `pnpm check:android-bundle`（APK 当 zip 列条目，断言
     `lib/<abi>/libpdfium.so` 在包内且与 vendor 同 sha256）——
     2026-09-20 用 Downloads 里那份 `ShuyoNote_1.90.2_android-arm64-release.apk` 跑过：**包里没有库**（963 个条目，exit 1），
     这正是 P4 安卓格那条缺口的真产物读数。
     **同一天晚些时候**：那条通路在 CI 上**第一次走到头**（run `35504661582` 全绿，含第 19 步产物自检）——
     修掉的是下面这两条坑（平台名静默回落 ＋ GNU tar 读不了 zip），**不是**构建本身有问题。
- **同一件事在"本机 `tar`"与"CI `tar`"上不是同一个程序**（2026-09-20 实测，CI 上真红）：
  APK 就是 zip，而 **Windows/macOS 的 `tar` 是 bsdtar（认 zip）、CI 的 ubuntu 上是 GNU tar（不认 zip）**
  ⇒ 用 `tar -tf` 列 APK 的那条判据在 CI 上恒 `exit 2`「没验」（本地永远复现不出来）。
  本机对照：`wsl tar -tf x.apk` ⇒ `This does not look like a tar archive`；`tar -tf x.apk` ⇒ 正常列出。
  ⇒ 读 zip 一律走 `scripts/lib/zip.mjs`（纯 JS，`check-apk-contents.mjs` 与 `check-android-bundle.mjs` 共用）。
  > 这条的**形状**值得记：它不报错、也不说谎，只是把一条产物判据变成**永远不生效**的摆设 ——
  > 而"没验"（exit 2）与"通过"本仓是分开的，所以只看绿/红会以为它一直在工作。
- **命令行参数被静默忽略 ⇒ CI 上"取错平台"**（2026-09-20 实测，安卓流水线**连着三跑**红在这，见下面一节）：
  `node scripts/fetch-pdfium.mjs android-arm64` 是**位置形式**，而脚本当时只认 `--platform <名>`
  ⇒ 参数被吃掉、回落到"当前平台"，ubuntu runner 上取回的是 **linux-x64**；
  报错点却在**下一步**（`stage` 才说"vendor 里没有 android-arm64 的那份库"）——
  读日志的人会去查 vendor、查 stage，真凶是参数。**修法不是改那一行调用，而是去掉"静默回落"这个状态**：
  解析抽成 `scripts/lib/pdfium-target.mjs`（位置参数与 `--platform` 等价、认不出的名字当场 exit 2），
  判据在 `scripts/lib/pdfium-target.test.mjs` ＋ `scripts/fetch-pdfium.test.mjs`（都离线）。
  > 同族教训：**"我写了个参数"和"它被读到了"是两件事**，跨进程边界（脚本 / workflow / 子进程）时尤其要
  > 用判据钉住；只靠"读一遍代码觉得对"会在 CI 上以"另一处的报错"形式出现。
- **判据里起子进程必须带 `ELECTRON_RUN_AS_NODE=1`**（2026-09-20 本机实测）：本仓的 `vitest` 跑在 Electron 里，
  `process.execPath` 是 **electron 而不是 node** ⇒ `spawnSync(process.execPath, [...])` 会以"加载 Electron 主进程模块"
  的方式起来了又崩，**表现成"被测脚本自己 exit 1"**——很容易误读成"判据真的红了"（我第一版就是这么被骗了一轮）。
  现成写法见 `scripts/fetch-pdfium.test.mjs` 里那个 `run()` 助手。
- **在 Windows 本机出一个 Linux AppImage（WSL2 配方，2026-09-20 实测跑通）**：AppImage 只能由 Linux 构建，
  但**不必**装一台 Linux —— WSL2 里那套工具链够用（实测：`cargo 1.98.1`、`tauri-cli 2.11.5`、
  `webkit2gtk-4.1 = 2.52.6`、`gtk+-3.0 = 3.24.41`、`librsvg = 2.58.0`、`dpkg-deb`/`readelf`/`fusermount` 都在）。
  三步（**注意两个刻意的选择**）：
  ```bash
  # ① 前端产物在 Windows 侧建（WSL 里没有 node/pnpm）：pnpm build  ⇒ dist/
  # ② WSL 里只跑 Rust ＋ 打包；CARGO_TARGET_DIR 指到 ext4 上（快，且**避免与 Windows 的
  #    target/release 撞车** —— 同名目录、不同 host triple，混用会互相作废缓存）
  export PATH="$HOME/.cargo/bin:$PATH"
  export CARGO_TARGET_DIR=/home/cnzen/target-appimage
  cd /mnt/c/Users/cnzen/zhai/<worktree>
  cargo tauri build --bundles appimage \
    --config '{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'
  # ③ 判据要的原始读数在 WSL 里取（本机没有 dpkg-deb / 跑不了 AppImage / 没有 readelf），
  #    解析与判定仍由 Windows 侧那份 check-linux-bundle 做（判据一个字不改）
  ./ShuyoNote_*.AppImage --appimage-extract        # 不需要 FUSE
  ```
  **实测读数（2026-09-20，`ShuyoNote_1.91.10_amd64.AppImage` 117,504,504 B、构建 7m47s）**：
  `usr/lib/ShuyoNote/libpdfium.so` **7,664,592 B** sha256 `eb19d385…`（源那份 7,645,184 B `f7289309…`）、
  `usr/lib/ShuyoNote/NotoSansSC-Regular.ttf` 在**资源目录那一层**；
  结构比对 **✅ 动态表 31/32 条 · 只有 `RUNPATH=$ORIGIN` · 动态符号 783/783 · 大小 7645184/7664592**
  ⇒ `check-linux-bundle` **0 条 problem**（AppImage 那条判据**第一次**在真产物上跑，之前只有 deb 的读数）。
  > ⚠️ 展开后的路径**必须以 `./` 开头**（`./squashfs-root/usr/lib/...`）才算"包内相对路径"：
  > `squashfs-root` 是打包容器的根名，判据会把它摘掉再数层数。写成 `.squashfs-root/...`（少一个斜杠）
  > 会被判成"位置不对"——我第一版就踩了，而判据的反应是**正确地红**（说明那条位置判据确实在干活）。
- **取 GitHub 资产：两条路，只有网络类失败才换路；换路不许静默**（2026-09-23 收口，本机实测）：
  `node scripts/fetch-gh-asset.mjs <owner/repo> <tag|latest> <名子串> <输出> [期望 sha256]`（`--list` 只列资产）。
  分工：纯逻辑 `scripts/lib/gh-asset.mjs`、网络与落盘 `scripts/lib/gh-asset-fetch.mjs`、薄 CLI 只管参数/打印/退出码；
  `scripts/fetch-pdfium.mjs` 的退路调**同一份** ⇒ 原先那两份 `.tools/gh-api-asset.mjs`、`.tools/fetch-pdfium-via-api.mjs` 已删。
  本机读数：Node 直连 `api.github.com` ⇒ `UND_ERR_CONNECT_TIMEOUT`（网络类）⇒ 退 `curl --resolve 140.82.113.6` ⇒ **200**；
  `node scripts/fetch-pdfium.mjs win-x64` 的直链（`github.com`）⇒ `curl (35) schannel … CRYPT_E_REVOCATION_OFFLINE`（网络类）
  ⇒ 退 API 资产端点 ⇒ **3,733,154 字节**、sha256 `73cc0de6…` 与平台表钉死值一致、解出 `bin/pdfium.dll` **7,211,520 字节**。
  判据：`scripts/lib/gh-asset.test.mjs`（纯：选择/路由/状态码/哈希/argv 无凭据/curl 退出码分类）
  ＋ `scripts/lib/gh-asset-fetch.test.mjs`（注入 `fetchImpl`，**不碰网络**）。
  > ⚠️ 两条钉过的坑：① `curl -s` **不看状态码** ⇒ 不带 `-w` 时 `releases/tags/<不存在的 tag>` 的 404 体会被当成功读进来，
  > 于是"这个 tag 不存在"被读成"这个 release 一个资产都没有"（正是本仓禁止的"结果类冒充事实"）；
  > ② 输出目录不存在时 curl 报 `(23) client returned ERROR on write` —— **像网络故障，其实是路径**（已改成先建目录）。
  > 凭据一律走 `--config` 临时文件、**绝不进 argv**（2026-09-16 那次 "Bearer token 打进公开日志" 的教训）。

## 三条线**相交**的格子：三平面联合验收（**不在默认门禁里**，2026-09-23 加）

三条在飞战役（国密 / 全库 AI 覆盖 / 块级 CRDT）各自都有常开门禁、各自都绿，但它们**两两/三三相交的格子
此前没有任何人负责**：三个平面的数据住在同一张空间库、走同一条写路径、还要一起过加密 / 备份 / 同步 / 全库扫描。
**分开绿 ≠ 一起绿。**

```bash
node scripts/joint-acceptance.mjs                       # 就绪面板 ＋ 格子矩阵（只读）
node scripts/joint-acceptance.mjs --check               # 就绪 ⇒ 0；未就绪 ⇒ 2；探针坏了 ⇒ 1
node scripts/joint-acceptance.mjs --run j1              # 跑一格（cargo 格有**下限**：空跑即红）
```

- 登记表是 `scripts/lib/joint-planes.mjs`（平面 / 探针 / 联合格子 / 每格判据），**计划本身**就是它的文档视图：
  `docs/JOINT-ACCEPTANCE.md` 里那块机器事实由 `scripts/lib/joint-planes.test.mjs` **逐字核对**（该测试随默认组跑）。
- **为什么不进 CI**：它要真 SM 前缀、会打补丁重建、还要真机 ⇒ 属于**发版窗口**的动作（与 `RELEASING.md` 的配方同一档）。
  CI 里已经常开覆盖的是它的其中一格（`rust-sm-wired`：打补丁 ＋ `--features sm-library` 跑**全量 lib** ⇒ 含 CRDT 与派生那几族）。
- **三态**：就绪 / 未就绪（**不是红**）/ **未实查**（真机、Windows 静态前缀、LibreOffice、真模型、Web CORS）。
  「自报跳过」在联合验收里**不算通过**（`forbidSkip`）—— 否则一份全绿的报告里可能有两格根本没跑。

## CI 红了：**先读注解**，不要去猜（2026-09-17 的教训）

**为什么单列一节**：那天默认组连红三次（`7a6df321` / `bb993251` / `6569e2b9`，其中一次还是**纯文档提交**），
而**没有任何人能说出是哪条门禁** —— 步骤日志要鉴权、artifact 下载要鉴权，`check-runs/{id}/annotations`
是唯一**无需鉴权**能读的通道，而它当时是**空的**（工作流从来没写过注解）。
结果"红了"只变成一句"又红了"，三台机器（macOS 绿 / Windows 绿 / Linux 红）白猜了半天。

现在这条通道是通的，顺序是：

1. **看注解**（公开可读，不需要 token）：
   ```bash
   # 取该提交的 check run，再读它的注解
   curl -s "https://api.github.com/repos/ShuyoNote/ShuyoNote/commits/<sha>/check-runs" | grep -o '"id": [0-9]*' | head -1
   curl -s "https://api.github.com/repos/ShuyoNote/ShuyoNote/check-runs/<id>/annotations" | grep -o '"message": "[^"]*"' | head -20
   ```
   注解里会有：**哪条门禁红**、挡什么事故、命令与退出码、**失败用例名与首行信息**、
   基线退步的**原因**、以及**被判据自报跳过**的条目（绿的门禁也可能少跑了几条）。
   ⚠️ **注解只覆盖"门禁清单里"的那些**。不在清单里的步骤（`release.yml` / `android.yml` 的构建步骤）
   注解是空的 —— 那类红**必须读步骤日志**，配方见下条。
2. **读步骤日志（要 token；Windows 侧 2026-09-20 实测可用）**：日志接口会 302 到签名 URL，
   `Invoke-WebRequest` 在 NonInteractive 下会自己卡住/报错，用 `curl.exe` 反而干净：
   ```powershell
   # token 就在本机 git 凭据里（与 `git push github` 用的是同一个），**不要**打印出来
   $tok = ((Get-Content "$env:USERPROFILE\.git-credentials" | Where-Object { $_ -match 'github\.com' } |
           Select-Object -First 1) -replace '^https://','' -replace '@github\.com.*$','').Split(':')[-1]
   $h = @{ Authorization = "Bearer $tok"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'dsh' }
   # ① 该 workflow 最近几跑（拿到 run id / head_sha / conclusion）
   (Invoke-RestMethod -Headers $h 'https://api.github.com/repos/ShuyoNote/ShuyoNote/actions/workflows/android.yml/runs?per_page=5').workflow_runs
   # ② 该跑的 jobs 与**每个 step 的结论**（哪一步红的，一眼看到）
   (Invoke-RestMethod -Headers $h 'https://api.github.com/repos/ShuyoNote/ShuyoNote/actions/runs/<run_id>/jobs').jobs
   # ③ 那一步的全文日志（98 KB 级别，落地再 grep，别直接往终端倒）
   curl.exe -sL -H "Authorization: Bearer $tok" -H "Accept: application/vnd.github+json" `
     "https://api.github.com/repos/ShuyoNote/ShuyoNote/actions/jobs/<job_id>/logs" -o $env:TEMP\job.log
   ```
   实测收获（2026-09-20）：`android.yml` 的「随包 PDFium 库（Android）」**连着三跑**都红，
   日志第一行就写着 `target: … / linux-x64` —— 而注解通道对这条**完全为空**，只读注解会以为"什么都没有"。
   （同一跑里 `jobs` 接口还能看到红在**第 17 步**，后面 6 步是 `skipped` —— 这比人眼翻 1000 行日志快得多。）
3. **本地复跑同一条门禁**：`node scripts/test-report.mjs --only <gate-id>`；
   门禁清单与 CI **同源**（`scripts/lib/gates.mjs`），所以本地跑的就是 CI 跑的那条。
4. **仍是"本机绿、CI 红"就找环境差异**，已知的两类（都真实发生过）：
   - **干净检出**没有的东西：git tag、未跟踪的构建产物。（`release.mjs` 的 tag 守卫就是这么咬到测试自己的。）
   - **浏览器语言/区域**：CI 的 Chromium 是 `en-US`，而按文案匹配的判据只认中文时就会"找不到入口"。
     复现配方：给 Chrome 加 `--lang=en-US` 再跑同一条门禁（实测能逐字复现）。

> 三条规矩，都是那天用时间换来的：**①按钮/文案匹配一律双语**（或改用 `data-*`/role 选择器）；
> **②判据宁可红、不许静默跳过**（静默跳过会被基线抓成"数字降了"，但**原因**必须自己说出来）；
> **③诊断要打"现场"**（哪一步没走到 + 现场长什么样），而且**打印别截断证据**（只打前 N 个，
> 要找的那个很可能正好被截掉 —— 那天就这么又猜了一轮）。

## 新增一条门禁

1. 写脚本（纯 Node 优先；需要浏览器的放 `browser` 组）。
2. 在 `scripts/lib/gates.mjs` 注册：`id` / 分组 / 中文标签 / `cmd` / **`incident`（挡什么事故）**；
   有确定读数就加 `counters` 与 `baseline: true`。
3. 在 `scripts/test-report.test.mjs` 的 `REQUIRED_GATE_IDS` 里加上它（CI 必需门禁清单）。
4. 跑 `node scripts/test-report.mjs --group <组> --update-baseline` 更新 `tests/baseline.json`。
5. 更新本文件的表格。
6. 本地跑一遍 `pnpm verify`；CI 会自动跑同一份清单——**不要**在 `ci.yml` 里另抄一份命令。
7. **开 MR 前按目标分支对一次 diff**：`git diff --stat origin/<目标分支> <你的分支>`。
   diff 里出现"你没动过的文件"就是信号——2026-09-16 的真实例子：把当时的 `main` merge 进分支取测试集，
   而那条测试修法只在 `dev` 上，于是相对 `dev` 的 diff 里出现了 `src-tauri/src/sync.rs | 15 --`
   （**合进去就会回退别人的修复**）。发现后再 merge 当前 `main` 即可消除。

> 自测兜底：`scripts/test-report.test.mjs` 会校验"id 不重复 / 命令引用的脚本真实存在 /
> 本地默认组不许依赖浏览器或 cargo / 标了 baseline 就必须有 counters / CI 必需门禁一条不少 /
> 外部套件登记字段完整"。
> 汇总器自己的**纯逻辑**（读数解析、基线判定、markdown 渲染、状态回写）在
> `scripts/lib/report-core.mjs`，由 `scripts/lib/report-core.test.mjs`（28 条）覆盖——
> 门禁清单和它的仪器**都**进了回归，它们同样是一种会被顺手改坏的代码。
> 那次"把 `check-plugin-hosting` 的进度数字当成 `2280/4560 断言`"的事故，其回归用例也在那里。
> 写这套单测时它还立刻抓出两个真问题：①"通过了却解析不出读数"（解析链断了）此前**不会**报违规；
> ②cargo 的 `test result` 行每个测试二进制一行，只取第一行会把 Rust 读数算少一大截。
