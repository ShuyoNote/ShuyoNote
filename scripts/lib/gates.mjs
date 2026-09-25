// 回归门禁注册表——**门禁清单的单一事实来源**。
//
// 为什么单独一个文件：清单既要被 `scripts/test-report.mjs`（本地 `pnpm verify` 与 CI 共用）
// 消费，也要被 `scripts/test-report.test.mjs` **导入**做不变量自测（id 不重复、命令指向的
// 脚本真实存在、本地默认组不许依赖浏览器……）。放在执行器里就没法安全导入——那边一 import
// 就会跑起整套门禁并 process.exit。
//
// `incident` 字段不是装饰：每条门禁都对应一次真实事故（来自 ci.yml 与各脚本头部的记录）。
// 门禁存在的理由必须写下来，否则后人只会看到"一堆跑得慢的检查"，然后在某次赶工时把它删掉。
//
// 分组：
//   contract —— 纯 Node 契约检查（快，任何机器都能跑）
//   smoke    —— 类型检查 / 单测 / web 冒烟（纯 Node）
//   sync     —— 两设备同步一致性（纯 Node，真实 applyChange + 真实 sql.js）
//   plugin   —— 插件作者路径（类型包 + 作者 CLI + 脚手架冒烟）
//   browser  —— 需要真实 Chromium 的几何 / 加载验收
//   mobile   —— 需要先起 web dev server（:5173）的移动端布局与浮层验收
//   rust     —— cargo test（含插件宿主子进程集成测试）
//   artifact —— 需要"先打一个真包"的外部产物验收（CI 的 rust-tests job 里跑）

export const GATES = [
  // ---- contract ----
  { id: "check-versions", group: "contract", label: "版本号一致性", cmd: "node scripts/check-versions.mjs" },
  {
    id: "check-changelog-version-parity",
    group: "contract",
    label: "CHANGELOG 已发布标题与版本文件同改",
    cmd: "node scripts/check-changelog-version-parity.mjs",
    incident:
      "2026-09-20：一笔提交只把 CHANGELOG 顶部那节写成 1.91.10（没动三个版本文件）⇒ dev 上 `check-versions` 红，" +
      "而它只能说「当前内容不一致」、说不出是哪一笔；本门禁补「哪一笔」，并显式处理 merge（`-m --first-parent`）",
  },
  { id: "check-changelog", group: "contract", label: "CHANGELOG 结构", cmd: "node scripts/check-changelog.mjs" },
  {
    id: "check-changelog-numbers",
    group: "contract",
    label: "CHANGELOG 门禁数字（与基线一致）",
    cmd: "node scripts/check-changelog-gate-numbers.mjs",
    incident: "发版说明里的断言数一直靠人从终端抄：抄错了下一次改动后就成假话，而散文不参与构建，没人会发现",
  },
  {
    id: "check-changelog-tags",
    group: "contract",
    label: "每个 tag 的树自带本版台账段头",
    // 为什么挂在 contract：纯 Node + 只读 git，约 1 秒。**故意不进 `pnpm build`** ——
    // build 会在 release/macos/android 那几个 job 里跑，而那些 checkout 是默认深度（浅克隆）
    // ⇒ 一个 tag 都没有 ⇒ 本门禁判「判不了」（exit 3）⇒ 把发版链整条弄红。
    // 跑它的 `ci.yml` 的 `checks` job 已显式 `fetch-depth: 0`。
    cmd: "node scripts/check-changelog-tags.mjs",
    incident:
      "2026-08-31 一天里连发 7 个 tag（`v1.64.10` … `v1.64.16`），而**每一个的树顶格都还停在 `1.64.10`**" +
      "（`v1.64.10` 自己停在 `1.64.9`）—— 版本号 bump 了、台账一段没写。" +
      "`release-preflight` ③ 查的是「打 tag 之前的工作区」，它挡不住「tag 打在了台账陈旧的提交上」这个形状" +
      "（`git tag` 指哪个提交是手给的）；本门禁对**所有** tag 问「你这棵树里有没有你自己那一段」，是全量历史审计。" +
      "另记一条基线教训：第一版拿「当前 checkout 的 CHANGELOG」去比 tag，报出 4 个假缺失" +
      "（1.85.2 / 1.91.4 / 1.91.25 / 1.91.26）—— 真因是发布提交切在 `main`、`dev` 台账本来就落后两个版本；" +
      "判据的基线必须是被审计的那个对象自己（tag 的树）",
    registered: "2026-09-25",
  },
  {
    id: "check-main-only-commits",
    group: "contract",
    label: "发布线独占提交（漏在 main 上的开发改动）",
    // 为什么挂在 contract：纯 Node + 只读 git，约 1 秒。
    // ⚠️ 它**必须跑在非浅克隆上**：判据要算 `origin/main` 与 `origin/dev` 的祖先关系，而浅克隆下
    // `git rev-list A..B` 会**静默**给出偏少的答案 ⇒ 一律判「判不了」（exit 3），绝不当通过。
    // GitHub 的 `checks` job 是 `fetch-depth: 0`；GitCode 侧由「取全历史与 tag」那一步 `--unshallow`。
    cmd: "node scripts/check-main-only-commits.mjs",
    incident:
      "2026-09-25：`dev` 与 `origin/main` 分叉（dev 独有 208 笔、main 独有 7 笔），那 7 笔里**三笔带着开发线没有的内容**：" +
      "`a3cbd44a`（社区帖存成笔记后属性区不刷新）、`64a415a1`（团队版方案文档）、以及 **`686d0480 release: 1.91.25`**" +
      "—— 标题像纯发布，实际夹带了 `src/lib/mdPreview.ts` 的修复，而那是个**只在打包产物里显形**的 bug：" +
      "节点表在**模块顶层**求值 ＋ 循环 import ⇒ dev/vitest 走原生 ESM 永远绿，打包拼平后 `nodes[9]` 是 `undefined`。" +
      "⇒ 危害不是台账落后，是开发线**长期带着一个已经发出去的 bug**，且下次 `dev → main` 合并冲突取 dev 侧时会静默改回去。" +
      "⇒ **不能只看提交标题判**（那三笔里恰好有一笔就叫 `release:`）⇒ 判据改成按**文件集**：非 merge 的发布线独有提交" +
      "只许动发布产物（`RELEASE_ARTIFACTS`，与 `check-versions` 认的 7 处同源、并由自测钉住不许漂）；" +
      "merge 则要求除第一父外的父都能从 dev 走到（实测那三笔合并的第二父都在 dev 里 ⇒ 不是开后门）。",
    registered: "2026-09-25",
  },
  { id: "check-web-commands", group: "contract", label: "命令契约（web/桌面两侧）", cmd: "node scripts/check-web-commands.mjs" },
  { id: "check-capabilities", group: "contract", label: "能力注册表", cmd: "node scripts/check-capabilities.mjs" },
  { id: "check-doc-links", group: "contract", label: "文档相对链接", cmd: "node scripts/check-doc-links.mjs" },
  {
    id: "check-doc-facts",
    group: "contract",
    label: "文档里的机器事实（门禁 / 能力 / 命令数）与代码一致",
    cmd: "node scripts/check-doc-facts.mjs",
    incident:
      "这三类数字此前散在文档里**靠人手抄**：抄错不报错，只会让照着文档做的人做到一半发现文档是旧的。" +
      "两条断言：① 注册表里每条门禁都要在 docs/TESTING.md 里有名字（上线当天抓到 7 条漏写）；" +
      "② docs/TESTING.md 的「机器事实」块必须与代码逐字一致（数字取自 gates.mjs 与另两条门禁的自报输出，不重复实现）",
    registered: "2026-09-23",
  },
  {
    id: "check-workflow-yaml",
    group: "contract",
    label: "workflow YAML 窄规则 ＋ 私有 CARGO_HOME 交接（按 job）",
    cmd: "node scripts/check-workflow-yaml.mjs",
    incident:
      "2026-09-12：`--lib plugins::` 行尾冒号 ⇒ 非法 YAML ⇒ 0 个 job 的红 run，49 次 push 全红无人察觉；" +
      "2026-09-25：国密隔离后「打补丁」与「构建」之间少一次私有 `CARGO_HOME` 交接 ⇒ Android 自检包在 step 23 如实 panic（`release.yml` 恰好桌面 job 导了、android job 没导 ⇒ 判据必须按 job 切，按文件找会假绿）",
  },
  {
    id: "check-gitcode-workflow-rules",
    group: "contract",
    label: "GitCode workflow 平台规则（runs-on 白名单 / step 必须有 name / action 写法）",
    cmd: "node scripts/check-gitcode-workflow-rules.mjs",
    incident:
      "2026-09-16：GitCode 的校验接口实测出三条平台约束（GitHub 侧没有）——仓库既有的 euleros-2.10.1 与简写 action 都不合法；不合法时整条流水线不会被调度",
  },
  {
    id: "check-overlay-registry",
    group: "contract",
    label: "浮层登记（返回栈 / 移动端量测）",
    cmd: "node scripts/check-overlay-registry.mjs",
    incident: "2026-09-15：版本历史弹层没登记 ⇒ 真机上返回键直接退出应用（第 6 个真机问题）",
  },
  {
    id: "check-hook-order",
    group: "contract",
    label: "hooks 顺序（早退不许越过 hooks）",
    // 为什么现在才进注册表：它此前只挂在 `package.json` 的 build 链上，**没进本注册表**
    // ⇒ `pnpm verify`（本地一键验收与 CI 的 checks job 共用）**跑不到它**。
    // 2026-09-25 复核 Zustand 订阅粒度时发现的 —— 同一个坑 `mobile-views` 在 2026-09-22 踩过
    // （见上面 mobile 组那段注释）。"只挂在 build 链上"的门禁在 CI 的 verify 路径上是隐形的。
    cmd: "node scripts/check-hook-order.mjs",
    incident:
      "同一类错在这份代码里发生过**两次**，两次都是「用户的界面直接没了」：" +
      "① v1.85.1：`CommandPalette` 把参数表单的三个 `useState` 放在 `if (!open) return null` **之后** ⇒ 按 Ctrl+K 抛错（生产是 Minified React error #310）⇒ 整棵树被卸载成白屏；" +
      "② 2026-09-16：`App` 的加密锁定闸门是一句**排在七八个 hooks 之前**的早退 ⇒ 加密安装**重启即抛 `Rendered fewer hooks than expected`**，被根部 ErrorBoundary 接住 ⇒ 用户看到崩溃屏，而锁定屏**一次都没出现过**（真机只验了设置页开关）。" +
      "两次都不是「写错了」，是「**看漏了**」——早退和 hooks 隔着几十行，人眼很难可靠发现；渲染级测试只能证明「某一个组件当前是对的」，这条管的是「仓库里别再出现这种写法」。" +
      "自测：`node scripts/check-hook-order.mjs --self-test`（里面放的是两次真事故的**真实写法**，必须判红）。",
  },
  {
    id: "check-ps1-ascii",
    group: "contract",
    label: "PowerShell 脚本编码（纯 ASCII 或 BOM）",
    cmd: "node scripts/check-ps1-ascii.mjs",
    incident: "2026-09-11：无 BOM 的 UTF-8 .ps1 在 PS 5.1 下按 ANSI 解码 ⇒ 报 9 处假语法错误",
  },
  {
    id: "check-nsis-template",
    group: "contract",
    label: "NSIS 安装器模板（fork 的一行改动 + CLI 版本核对）",
    cmd: "node scripts/check-nsis-template.mjs",
    incident:
      "2026-09-21：owner 截图问「程序的安装地址不专业啊？」——" +
      "Tauri 没有自定义默认安装目录的配置项（只有 installMode，上游 tauri-apps/tauri#11015），" +
      "默认目录写在 NSIS 模板里，所以我们 fork 了一份上游模板只改那一行；" +
      "fork 的两个风险都不吵不闹：模板被删/改回去 ⇒ 又装到 AppData 里（本机那次是注册表记着旧路径，更容易被误判成'产品默认不专业'），" +
      "Tauri CLI 升级后上游模板变了而我们的 fork 停在旧版 ⇒ 与 CLI 传入的占位符对不上，打出来的包装不上",
  },
  {
    id: "check-pdfjs-shim",
    group: "contract",
    label: "pdf.js worker 垫片（顺序不变量，裸 Node）",
    cmd: "node scripts/check-pdfjs-worker-shim.mjs",
    incident: "老 WebView 上打不开任何 PDF：补齐层必须在 worker 内先装，install 顺序最容易被'顺手整理'破坏",
  },
  {
    id: "check-ocr-assets",
    group: "contract",
    label: "OCR 资源清单",
    cmd: "node scripts/check-ocr-assets.mjs",
    incident:
      "两个方向都真发生过（或差一点）：①「整个目录全拷」⇒ tesseract.js-core 的 6 变体 × 2 形态 ≈ 43.2 MiB 里只有一份会被 worker 加载，白白多进产物 ~23.3 MiB（Android 上还会被装两遍，再多约 46 MiB）；②反过来更危险：有人为 worker.detect 打开 legacyCore，而拷贝脚本仍只放 -lstm 三档 ⇒ 本地 OCR 在真机上只报一个看不懂的加载错误，构建 / 单测 / 类型检查全都发现不了",
  },
  {
    id: "check-deep-link",
    group: "contract",
    label: "deep-link 交付通道",
    cmd: "node scripts/check-deep-link.mjs",
    incident:
      "这条链上每个断点的表现都是「什么都没发生」（点链接、应用无反应、控制台也不报错），而且四类断点都不是编译错误：scheme 写错或被删、single-instance 少了 deep-link feature（URL 被静默丢掉，窗口照常去所以看起来像解析失败）、lib.rs 忘注册插件或忘接事件、事件名前后端不一致",
  },
  {
    id: "check-plugin-hosting",
    group: "contract",
    label: "插件托管",
    cmd: "node scripts/check-plugin-hosting.mjs",
    incident:
      "应用侧门禁（external_index / external_package）验的是「文件」，而托管方要保证的是「线上那一份」能装：两类是「发布时毫无征兆、用户端才炸」—— 索引被长缓存 ⇒ 新插件永远看不到；包被 no-store 或被 CDN 改写 ⇒ 每次安装都重下几 MB（慢，但不报错）",
  },
  {
    id: "check-sys-deps",
    group: "contract",
    label: "构建期依赖登记 / 本机工具链（以 CI 配方为准）",
    // ⚠️ 这里**故意不带 `deb`**：Linux 的 deb 实查要求 Tauri 那套系统包在位，而本组跑在
    // `checks` job（ubuntu-latest，**不装** Tauri 依赖）⇒ 带上它第一条 push 就会红，且红得没道理。
    // deb 实查挂 rust 组的 `check-sys-deps-linux`，那条跑在装了依赖的 `rust-tests` job 里。
    cmd: "node scripts/check-sys-deps.mjs --checks registration,toolchain",
    incident:
      "两类真事故各一条：①2026-09-17 发版机清构建期依赖（libssl-dev）⇒ 社区端 openssl-sys 编译失败；②同日 15:51 本机 Xcode 27 装完许可未接受 ⇒ git/python3/cc/xcrun 全线不可用（notarytool 一条探针就能提前发现）",
  },
  {
    id: "check-derived-writers",
    group: "contract",
    label: "派生表唯一写入者（Rust 生产代码不许写 attachment_text / chunks）",
    // 为什么挂在 contract：纯 Node、离线、零依赖、<1 秒。
    cmd: "node scripts/check-derived-writers.mjs",
    incident:
      "2026-09-18 spike 问题二查出**正文文本有两条派生实现**（7 个样本里 4 个结果不同，症状是搜索片段/反链随『谁最后保存』变）；同族风险是派生**表**长出第二个写入者 —— 两边各写一份时两侧测试都绿，用户看到的是同一份附件两套派生文本。Windows 裁定「写只有一处（TS 抽取管线：src/lib/extract/store.ts / chunkStore.ts）」，并要求把这条落成**可执行判据**（原话：只写在文档里的规则会漂）。Rust 侧今天确有两处 INSERT，但都在 #[cfg(test)] 里播种夹具 ⇒ 判据必须做区域判定（与 check-doc-content-access 共用 scripts/lib/rust-scan.mjs）",
  },
  {
    id: "check-doc-content-access",
    group: "contract",
    label: "文档内容直接访问（只减不增：新文件 / 超基线即红）",
    // 为什么挂在 contract：纯 Node、离线、零依赖、约 1 秒 ⇒ 本机默认组与 CI 的 `checks` job 都能跑。
    cmd: "node scripts/check-doc-content-access.mjs",
    incident:
      "同页并发 → 全量 CRDT（路线 C）要换实现时，全仓直接摸 content_json / content_text / contentJson 的面是 746 次 / 80 个文件；不把「只经一层（read/write/merge/derive）」做成单调收敛的机器判据，收口就只能靠一次大爆炸重构，而且新写的直接访问没有任何东西会拦（今天已经有人把 542 行 / 26 文件这个错口径当成规模）",
  },

  {
    id: "check-prism-components",
    group: "contract",
    label: "代码块高亮只有一条装配路径（不许再有 vendored 的 Prism script）",
    // 为什么挂在 contract：纯 Node、离线、零依赖、<1 秒（只读 index.html ＋ 两个源文件 ＋ 目录是否还在）。
    cmd: "node scripts/check-prism-components.mjs",
    incident:
      "2026-09-25 清冗余文件时实测：仓库里本来有**两条并行的 Prism 装配路径** —— " +
      "① `index.html` 里 10 行 `<script src=\"prism/prism-*.js\">` ＋ `public/prism/` 下 10 份 vendored 组件（77 KB，且是**阻塞式** script）；" +
      "② `src/editor/prismSetup.ts`（`Editor.tsx` 启动时 import）：prismjs 核心 ＋ 16 个组件 ＋ `window.Prism ??= Prism` —— 它自己的注释就写着 " +
      "\"independent of the index.html plain <script> loading\"。两条路做的事完全重合 ⇒ ①是纯冗余。" +
      "真 Chromium 实测（把①整条去掉后重新加载）：`window.Prism` 照旧能 highlight json / rust / sql / go / markdown、页面零 JS 报错 ⇒ 已删。" +
      "⚠️ 本门禁的第一版把方向判反了（写成「vendored ⇒ 必须在 index.html 里被加载」）：那条规则会**逼着**冗余的第二条路继续存在，" +
      "而它唯一的「证据」（`prism-json.js` 没被加载）真相是**两条路都不该有①** —— 先量事实再写判据，这条留作记录。" +
      "另有**只报告不判红**的静态对账：选择器列了、而 `prismSetup.ts` 没显式 import 的语言（今天 markdown / yaml）。",
    registered: "2026-09-25",
  },
  {
    id: "check-store-subscriptions",
    group: "contract",
    label: "Zustand 订阅粒度（组件不许整店订阅；只减不增）",
    // 为什么挂在 contract：纯 Node、离线、零依赖、<1 秒。
    cmd: "node scripts/check-store-subscriptions.mjs",
    incident:
      "2026-09-25 复核技术选型评估里「Zustand 在多空间/多视图的规模下需警惕隐式依赖导致的重渲染」这一条时实测：213 个 store 调用点里 **39 处 / 32 个文件**是 `const { openPage } = useNotes();` 这种**不带选择器**的整店订阅，" +
      "而 action 引用恒定、本来一次都不该被唤醒——其中 13 处**一个 state 字段都没读**。最重的一处是 `PageTree.tsx:189` 的 `TreeItem`：它**每个可见树节点渲染一次**，却也整店订阅；" +
      "叠加「自动保存（600ms 去抖）每次都 `updateCurrent()` ＋ `loadPages()` 全量重拉」⇒ 打一次字停 1 秒就唤醒 ~24 个树节点实例，外加 DatabaseView(1751 行) / FileManagerView(1208 行) / SyncPanel(1071 行) / GraphView / CommandPalette 一起重跑 render。" +
      "它与 check-hook-order 同族：**不炸、不报错、测试全绿**，只是安静地多渲染；写的人也没写错，是没人告诉过他「这行是订阅」⇒ 只能靠机器判据钉住（判据是**订阅关系**，不是渲染耗时，边界写在脚本头部）。",
  },
  {
    id: "check-dead-code-receipts",
    group: "contract",
    label: "死代码收据（`allow(dead_code)` 必须带日期 ＋ 删除条件）",
    // 为什么挂在 contract：纯 Node、离线、零依赖、<1 秒（只读 `src-tauri/src` 与 `build.rs` 的文本）。
    // ⚠️ 它**不判**理由好不好、也不判那段代码该不该留：它只保证"有人签过字"（边界写在脚本头部）。
    cmd: "node scripts/check-dead-code-receipts.mjs",
    incident:
      "2026-09-25 给「清掉编译器报的死代码」收尾时做了一轮全仓稽查，发现的不是「有几个警告要修」，而是**这一整类东西没人管**（`allow(dead_code)` 不产生任何输出，所以过期了也没人会去看）：" +
      "① `sync.rs::IncomingChange.seq` 挂着豁免，而它其实被生产代码读了 8 处 —— 豁免早就过期；" +
      "② `commands.rs::mupdf_compiled()` 的 body 就是 `cfg!(feature)`，唯一使用者是一条 `assert_eq!(cfg!(f), cfg!(f))` 的**空转判据** —— 死代码还自己长了一条判据；" +
      "③ `security.rs` 一次「文档与属性被留在上一个函数下面」的事故让一个夹具生成器被 libtest **注册两遍**（跑两遍），另一条生成器彻底不可达；" +
      "④ `build.rs` 里留着一份搬走后的 `find_gm_marker_deprecated` 副本，靠无名无期的豁免挂着（本次删除）。" +
      "共同点：**一行豁免就让一整块东西免检**。本门禁把纪律变成断言：每处豁免要么删掉、要么门进 `#[cfg(test)]`、要么写一句 `// ★ YYYY-MM-DD 收据：为什么留 ＋ 什么时候删`。" +
      "⚠️ 命中必须**在代码里**（复用 `lib/rust-scan.mjs` 掩码）：仓里有十几处注释**在讲**这件事，grep 式扫描会把它们全算成违规（自测里有这一格）。",
    registered: "2026-09-25",
  },

  // ---- smoke ----
  { id: "tsc", group: "smoke", label: "类型检查（tsc --noEmit）", cmd: "pnpm exec tsc --noEmit" },
  {
    id: "vitest",
    group: "smoke",
    label: "单元测试（vitest）",
    cmd: "pnpm exec vitest run --reporter=json --outputFile={tmp}/vitest.json",
    counters: "vitest",
    baseline: true,
  },
  {
    id: "smoke-web",
    group: "smoke",
    label: "冒烟测试（web 平台行为的事实标准）",
    cmd: "node scripts/smoke-web.mjs --json {tmp}/smoke-web.json",
    counters: "smoke-web",
    baseline: true,
    incident: "曾因一处无守卫的 localStorage 访问整套崩掉，而**没有任何自动化在跑它**，长期无人察觉",
  },

  // ---- sync ----
  {
    id: "two-device-sync",
    group: "sync",
    label: "同步一致性（两设备并发，真实 applyChange + 真实 sql.js）",
    cmd: "node scripts/verify-two-device-sync.mjs",
  },

  // ---- plugin ----
  { id: "examples-tsc", group: "plugin", label: "示例插件类型检查", cmd: "pnpm exec tsc -p examples/plugins" },
  { id: "plugin-cli-validate", group: "plugin", label: "作者 CLI 校验示例插件", runner: "plugin-cli" },
  {
    id: "plugin-new-smoke",
    group: "plugin",
    label: "脚手架冒烟（生成的起点当场能过 CLI）",
    cmd: "node scripts/plugin-new.mjs ci-smoke-plugin {tmp}/plugin-new-smoke",
  },

  // ---- browser（真实 Chromium）----
  {
    id: "check-pdf-reload",
    group: "browser",
    label: "PDF 重复加载验收（真实 Chromium + 真实引擎）",
    cmd: "node scripts/check-pdf-reload.mjs",
    baseline: true,
    counters: "auto",
    flaky: true,
    incident: "React StrictMode 让加载 effect 跑两遍，第二次交出已 detach 的 buffer ⇒ 单测摸不到",
  },
  {
    id: "check-panel-layout",
    group: "browser",
    label: "面板布局几何（真实 Chromium）",
    cmd: "node scripts/check-panel-layout.mjs",
    baseline: true,
    counters: "auto",
    flaky: true,
    incident: "'文字被挤成一条竖柱'这类：happy-dom 不做布局、类型检查看不见，只有打开看一眼才发现",
  },
  {
    id: "check-web-build",
    group: "browser",
    label: "Web 构建产物自检（真实 Chromium）",
    cmd: ["pnpm build:web", "node scripts/check-web-build.mjs"],
    baseline: true,
    counters: "auto",
    flaky: true,
    incident: "v1.84.1：按静态引用过滤删旧文件，把 sql.js wasm / pdf worker 删了 ⇒ 页面照开、DB 初始化失败",
  },

  // ---- mobile（需先起 dev server）----
  // browser / mobile 这两组要真实 Chromium（+ dev server），是仓库里唯一有 flake 风险的档。
  // 标记 `flaky: true` **不是**允许它们随便红：只有显式 `--retry N` 时才重试，
  // 且重试一定写进报告（"靠重试才通过"会单独列一节）。CI 默认 0 次重试——flake 要吵出来。
  { id: "mobile-layout", group: "mobile", label: "移动端布局验收（真实 Chromium）", cmd: "node scripts/verify-mobile-layout.mjs", baseline: true, counters: "auto", flaky: true },
  { id: "mobile-overlays", group: "mobile", label: "浮层 / 弹窗验收（真实 Chromium）", cmd: "node scripts/verify-mobile-overlays.mjs", baseline: true, counters: "auto", flaky: true },
  // 主区里的**整视图**（笔记/看板/关系图/文件/数据库 8 模式 + 属性表 + 小控件 + PDF 阅读器真 DOM）。
  // 2026-09-22 补进注册表：它此前只挂在 package.json（`test:mobile-views`），`pnpm verify` 跑不到它。
  { id: "mobile-views", group: "mobile", label: "主视图移动端验收（真实 Chromium）", cmd: "node scripts/verify-mobile-views.mjs", baseline: true, counters: "auto", flaky: true },

  // ---- rust ----
  // 读数（`counters: "cargo"`）**已在 Linux 侧实测并入** tests/baseline.json：
  //   rust-test 310 / rust-plugins-alone 114（2026-09-16，dev=dc7fa13b，WSL2 Ubuntu 24.04）。
  // 本机 Windows 可以用 scripts/win-cargo-test.ps1 跑 **lib 目标**（cargo 生成的测试 exe 没有
  // 应用清单，加载器因此绑到旧 comctl32 ⇒ 0xC0000139；脚本注入 v6 清单后再跑）。但它只覆盖单测，
  // 不含要真宿主进程的 `plugins::` 那 34 条，整组仍以 Linux（CI / 本机 WSL）为准，见
  // docs/TESTING.md 的"已知边界"。所以本机 `pnpm verify:rust` 仍可能红——那是**能力**问题；
  // 基线校验只比较**跑通过**的门禁，本机红不产生假违规。
  {
    id: "rust-test",
    group: "rust",
    label: "Rust 单测 + 集成测试（cargo test）",
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml",
    counters: "cargo",
    baseline: true,
  },
  {
    id: "rust-plugins-alone",
    group: "rust",
    label: "插件测试必须能单独跑",
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml --lib plugins::",
    counters: "cargo",
    baseline: true,
    incident: "2026-09-13：某测试依赖进程级 APP_DATA_DIR ⇒ 单跑必红、全量反而绿，改一行只跑一条时极易误判",
  },
  {
    id: "gm-conformance",
    group: "rust",
    label: "国密对拍（GM/T 标准向量 ＋ RustCrypto↔Tongsuo 双向）",
    // 为什么在 rust 组：它是 cargo 驱动的（`tools/gm-conformance` 这个独立工具 crate），
    // 与 rust-test 同一个 CI job；Tongsuo 缺席时**自报跳过**（不装绿、也不冒充通过）。
    cmd: "node scripts/check-gm-conformance.mjs",
    incident:
      "国密这条线**同时保两份 SM4 实现**（应用层 RustCrypto / 库级 Tongsuo，见方案 §0-F）——两份漂移的后果是「跨设备读不出对方的数据」，而它没有任何编译期信号、本机单测也照绿。夹具来自 AMD 2026-09-17（信箱仓 gm-conformance），2026-09-19 搬进本仓：去 target/、驱动重写成跨平台 Node（原 driver.sh 是 Linux 专用：stat -c/sha256sum/$HOME/tongsuo-build）、Tongsuo 缺席自报跳过；并加「空跑即红」下限——固定下限会漏掉「Tongsuo 分支整段被删」，所以下限随 Tongsuo 是否参与而变（3 或 8）",
  },
  {
    id: "rust-no-sm-crypto",
    group: "rust",
    label: "回滚通道：关掉默认特性（不编国密）仍能编译 ＋ 全量单测",
    // ★ 2026-09-20 改造（owner 拍板「无兼容快路」后，方案 §3.4）：
    //   原先这条门禁跑 `--features sm-crypto`，理由是"国密整段在 feature 后面，默认构建一行都不编，
    //   默认 CI 全绿证明不了国密那半边"。**那条理由现在反过来了** —— `sm-crypto` 已是**默认特性**
    //   ⇒ 默认门禁（`rust-test`）跑的就是国密那半边，原命令与它**逐值相同**，成了纯粹的重复。
    //   而快路带来了一条**新的、真正没人验证**的路径：`--no-default-features`（一行可逆的**回滚通道**）。
    //   它同样"没人编就会腐烂"（比如有人删掉只被旧路径用到的辅助函数），所以把这条常开门禁**改指它**。
    //   ⚠️ 改名不是洁癖：一个叫 `rust-sm-crypto` 却在验证"不编国密"的门禁，正是我们自己最反对的那种
    //   "名字比它证明的事多"。旧读数 `rust-sm-crypto: 398` 随之作废（同一条命令现在由 `rust-test` 覆盖）。
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml --no-default-features",
    counters: "cargo",
    baseline: true,
    incident:
      "2026-09-20：`sm-crypto` 成为默认特性后，原 `rust-sm-crypto`（跑 --features sm-crypto）与 `rust-test` 变成同一条命令；本门禁改为验证**回滚通道**（--no-default-features）——它是「一行可逆」这个承诺的实现，没人编就会腐烂。",
  },
  {
    id: "rust-sm-wired",
    group: "rust",
    label: "库级国密**接线**构建：打补丁 ＋ `--features sm-library` 下的全量单测",
    // ★ 2026-09-22 加，动机是**一次真实事故**：应用接线（`apply_gm_page_settings`）整段在
    //   `#[cfg(feature = "sm-library")]` 后面，而 CI 原有的 rust 门禁**全部跑默认特性**
    //   ⇒ 那条路**没有任何门禁碰过**。我在本机把发版链原样跑一遍时踩到的那个坑
    //   （`--prepare` 只清 dev profile ⇒ release 的旧 CommonCrypto SQLCipher 被原样复用
    //   ⇒ 包表面全对而库级不是国密）就是这一类，只有产物断言抓住。
    //   本门禁把它变成常开：能拿到 SM 版 OpenSSL 前缀就真跑（Linux 用 `/usr`），拿不到**自报跳过**。
    //   ⚠️ 它跑完会**还原补丁并把默认特性重新编好** —— 否则同一 job 里后面的 `check-crypto-backend`
    //   会读到"补丁态 ＋ openssl 最新产物"而按平台默认声明判红。
    cmd: "node scripts/check-gm-wired.mjs",
    incident:
      "2026-09-22：接线那段（`set_cipher_key` → 能力探针/设标签/回显校验）没有任何 CI 门禁覆盖；同时在 macOS 本机发现「只清 dev profile ⇒ release 旧 SQLCipher 被复用 ⇒ 发出非国密包」。两者一起促成本门禁：打补丁 ＋ 清两个 profile ＋ `--features sm-library` 跑全量单测（内部下限 380 passed/0 failed，空跑即红），跑完还原补丁并重建默认特性，避免留下混态。",
  },
  {
    id: "gm-registry-clean",
    group: "rust",
    label: "共享 registry 没留国密补丁（默认构建别被它悄悄改掉）",
    // 为什么挂在 rust 组：它读的是 cargo registry 里那份 **libsqlite3-sys 的 SQLCipher 源码**，
    // 而那正是 rust 组所有 cargo 门禁会去编译的同一份源码。
    // 三档：原版 / "这次就是 sm-library 构建" ⇒ ok；带补丁但本平台不红 ⇒ **只提示不判红**；
    // 带补丁 ∧ macOS 默认构建 ⇒ **红**（那 12＋7 条红会伪装成"加密库坏了"）。
    // 读不出来（没跑过 cargo / 拿不到 Cargo.lock）⇒ 只提示，**不判红**。
    cmd: "node scripts/check-gm-registry-clean.mjs",
    incident:
      "2026-09-22（AMD 侧报的，方案 §五「macOS-only 风险：补丁留在共享 registry 上」）：补丁打在**全机共享**的 `libsqlite3-sys-<v>/sqlcipher/sqlite3.c` 上，而 `sm-library-build.mjs` **刻意不自动还原**（自动还原会造出「源码是 AES、产物是 SM4」的新静默态）⇒「跑过一次国密构建、忘了 --revert」会在 macOS 上让后续**默认**构建红 12＋7 条，而**现场长得像「加密库坏了」**（`PRAGMA key = \"x'…'\"` 被拒），不是一眼能认出「这是补丁残留」；Linux/Windows 上不红、但后续默认构建被**静默**改成写 SM4 页。原先唯一的防线是收尾横幅＋人的纪律 ⇒ 这条把纪律变成断言（并且**只读**：`--print-source-sha256`/`--require-static`/`--print-env` 都会先打补丁，想核状态反而会改状态）。",
  },
  {
    id: "check-crypto-backend",
    group: "rust",
    label: "SQLCipher 的加密后端与声明一致（构建期实查，不是看环境变量）",
    // 为什么挂在 rust 组、且排在 cargo 类门禁后面：它读的是**构建产物**里 libsqlite3-sys 的 `output`
    // （`-DSQLCIPHER_CRYPTO_CC` / `link-lib=dylib=crypto`），所以必须先把东西编出来才查得到；
    // 没有产物时**自报跳过**（"没编过"不等于"编错了"）。
    cmd: "node scripts/check-crypto-backend.mjs",
    incident:
      "2026-09-19（本门禁作者本人踩的）：按方案 §3 第 5 条设了 OPENSSL_DIR=<Tongsuo> 跑 cargo test —— 编译通过、测试全绿、产物里**仍然是 framework=Security（CommonCrypto）**。原因是 libsqlite3-sys 的 build.rs **没有**为 OPENSSL_DIR 声明 rerun-if-env-changed ⇒ cargo 认为环境没变 ⇒ 构建脚本根本没重跑。⇒「设了环境变量」≠「换了后端」，必须 cargo clean -p libsqlite3-sys。这条门禁就是拿产物说话：声明与实际不一致就红（本机两种方向都实测过），旧产物分类不同只提示不判红。⚠️ macOS 今天默认仍是 CommonCrypto（Apple 那支只有 AES）⇒ 平台声明里 darwin 现写 commoncrypto，等 P2/P3 的 provider 补丁落地时随构建配置一起改成 openssl",
  },
  {
    id: "check-sys-deps-linux",
    group: "rust",
    label: "构建期系统依赖（dpkg 实查，与本组 CI job 的 apt 配方同源）",
    // 为什么挂在 rust 组：这是**唯一**会编译整个 Rust 工作区的 job，也就是唯一该要求
    // 「Tauri 那套系统包在位」的地方。本机 macOS/Windows 上这条会显式打印「未实查」而不是装绿。
    cmd: "node scripts/check-sys-deps.mjs --checks registration,deb",
    incident:
      "2026-09-17：发布机把 libssl-dev 当「客户端专用」清掉 ⇒ openssl-sys 构建失败。判据不是「表里写了什么」，而是「CI 配方装的包这台机器有没有」——表里的硬判据必须能在 ci.yml 的 Linux system deps 步里找到，否则门禁自己就是假话",
  },

  // ---- artifact（需先打一个真包；缺环境变量时显式跳过，绝不冒充通过）----
  {
    id: "external-index",
    group: "artifact",
    label: "外部索引：应用真解析器验收",
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml --lib external_index -- --ignored --nocapture",
    requiresEnv: ["SHUYONOTE_INDEX_FIXTURE", "SHUYONOTE_INDEX_APP_VERSION"],
  },
  {
    id: "external-package",
    group: "artifact",
    label: "外部插件包：应用真校验器验收",
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml --lib external_package -- --ignored --nocapture",
    requiresEnv: ["SHUYONOTE_PKG_ZIP", "SHUYONOTE_PKG_SIG", "SHUYONOTE_PKG_PUB"],
    incident: "打包从命令行 zip 换成库后字节布局变了：签名验过但解不开，只有装的时候才炸",
  },
  {
    id: "plugin-fragment-no-zip",
    group: "artifact",
    label: "打包工具不许依赖系统 zip",
    runner: "no-system-zip",
    incident: "曾经的 grep 门禁只写在 Linux CI 的 run 里；Windows 上没有命令行 zip，那边 `pnpm test` 红过三条",
  },
];

export const GROUP_ORDER = ["contract", "smoke", "sync", "plugin", "browser", "mobile", "rust", "artifact"];

// 本地默认组：必须**只含纯 Node 门禁**——需要 Chromium / dev server / cargo 的组不进默认，
// 否则"一键本地验收"在没装浏览器的机器上直接红，很快就没人跑了。
// 这条不变量由 scripts/test-report.test.mjs 机器校验（不是靠这段注释）。
export const DEFAULT_GROUPS = ["contract", "smoke", "sync", "plugin"];

// 本地默认组允许出现的前缀/关键字：命令里出现 `cargo`、或名单里这些脚本即视为需要额外环境。
export const DEFAULT_GROUP_FORBIDDEN = [
  "cargo",
  "check-pdf-reload",
  "check-panel-layout",
  "check-web-build",
  "build:web",
  "verify-mobile-layout",
  "verify-mobile-overlays",
  "verify-mobile-views",
];

export function gateSetOf(list) {
  const byGroup = {};
  for (const gate of list) {
    (byGroup[gate.group] ||= []).push(gate.id);
  }
  for (const g of Object.keys(byGroup)) byGroup[g].sort();
  return byGroup;
}
