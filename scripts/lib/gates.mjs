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
  { id: "check-changelog", group: "contract", label: "CHANGELOG 结构", cmd: "node scripts/check-changelog.mjs" },
  {
    id: "check-changelog-numbers",
    group: "contract",
    label: "CHANGELOG 门禁数字（与基线一致）",
    cmd: "node scripts/check-changelog-gate-numbers.mjs",
    incident: "发版说明里的断言数一直靠人从终端抄：抄错了下一次改动后就成假话，而散文不参与构建，没人会发现",
  },
  { id: "check-web-commands", group: "contract", label: "命令契约（web/桌面两侧）", cmd: "node scripts/check-web-commands.mjs" },
  { id: "check-capabilities", group: "contract", label: "能力注册表", cmd: "node scripts/check-capabilities.mjs" },
  { id: "check-doc-links", group: "contract", label: "文档相对链接", cmd: "node scripts/check-doc-links.mjs" },
  {
    id: "check-workflow-yaml",
    group: "contract",
    label: "workflow YAML 窄规则",
    cmd: "node scripts/check-workflow-yaml.mjs",
    incident: "2026-09-12：`--lib plugins::` 行尾冒号 ⇒ 非法 YAML ⇒ 0 个 job 的红 run，49 次 push 全红无人察觉",
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
    id: "check-ps1-ascii",
    group: "contract",
    label: "PowerShell 脚本编码（纯 ASCII 或 BOM）",
    cmd: "node scripts/check-ps1-ascii.mjs",
    incident: "2026-09-11：无 BOM 的 UTF-8 .ps1 在 PS 5.1 下按 ANSI 解码 ⇒ 报 9 处假语法错误",
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
    id: "check-doc-content-access",
    group: "contract",
    label: "文档内容直接访问（只减不增：新文件 / 超基线即红）",
    // 为什么挂在 contract：纯 Node、离线、零依赖、约 1 秒 ⇒ 本机默认组与 CI 的 `checks` job 都能跑。
    cmd: "node scripts/check-doc-content-access.mjs",
    incident:
      "同页并发 → 全量 CRDT（路线 C）要换实现时，全仓直接摸 content_json / content_text / contentJson 的面是 746 次 / 80 个文件；不把「只经一层（read/write/merge/derive）」做成单调收敛的机器判据，收口就只能靠一次大爆炸重构，而且新写的直接访问没有任何东西会拦（今天已经有人把 542 行 / 26 文件这个错口径当成规模）",
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

  // ---- rust ----
  // 读数（`counters: "cargo"`）**已在 Linux 侧实测并入** tests/baseline.json：
  //   rust-test 310 / rust-plugins-alone 114（2026-09-16，dev=dc7fa13b，WSL2 Ubuntu 24.04）。
  // 本机 Windows 跑不了它们（测试二进制加载期 `0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND`，见
  // docs/TESTING.md 的"已知边界"），所以本机 `pnpm verify:rust` 会红——那是**环境**问题；
  // 权威执行地是 Linux（CI / 本机 WSL）。基线校验只比较**跑通过**的门禁，本机红不产生假违规。
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
    id: "rust-sm-crypto",
    group: "rust",
    label: "国密应用层（SM4-CBC ＋ HMAC-SM3）：编译 ＋ 全量单测（--features sm-crypto）",
    // 为什么必须**常开**（方案 §0-E 的原话："必须有那条常开 job，否则国密路径会变成
    // 「没人编、坏了也没人知道」的死代码"）：国密代码整段在 `#[cfg(feature = "sm-crypto")]` 后面，
    // 默认构建**一行都不编**，所以默认 CI 全绿**证明不了**国密那半边还能用。
    //
    // 跑全量（不带 `--lib`）是刻意的：镜像 `rust-test` 的口径，这样"国密版"与"默认版"跑的是同一套
    // 用例集合，差别只在 feature —— 否则"国密版少跑了一半用例"这种事没人会发现。
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml --features sm-crypto",
    counters: "cargo",
    // ✅ 2026-09-19 起标 `baseline: true`：读数值取自 **Linux**（WSL2/Ubuntu，与既有 rust-test 基线同一台），
    // 读数 **376/376**（mac 侧钉 KDF 黄金向量那一笔之后在 Linux 上的重新读数；建基线时是 374，
    // 当时与 macOS 独立跑出的 374/374 **逐值相同** ⇒ 这套用例没有平台条件差异）。
    // 并入流程（CI 出报告后）：
    //   node scripts/test-report.mjs --baseline-from rust-report.json
    // 之后的护栏是"**只增不减**"：用例数掉下来会红（`baselineViolations`）；承重证明见
    // `.tools/rust-baseline-mutation.mjs`（把基线抬到 400 ⇒ 当场红，还原后绿）。
    // ⚠️ 别拿本机 Windows 的数去建基线：Windows 上测试二进制加载期就异常退出（见 docs/TESTING.md）。
    baseline: true,
    incident:
      "国密这一支一旦没人编就会腐烂：默认包不含国密（§0-E），而 `--features sm-crypto` 若编译不过/单测红，本机与 CI 都不会有任何信号。2026-09-19 建这条 job 时顺带钉住两件事：① 库级密钥必须仍是 Argon2 legacy 那 32 字节（被国密密钥顶替 = 既有加密库全部打不开）；② 国密构建仍必须读得出 v0/v1 老密文（双读）",
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
];

export function gateSetOf(list) {
  const byGroup = {};
  for (const gate of list) {
    (byGroup[gate.group] ||= []).push(gate.id);
  }
  for (const g of Object.keys(byGroup)) byGroup[g].sort();
  return byGroup;
}
