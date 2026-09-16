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
  { id: "check-ocr-assets", group: "contract", label: "OCR 资源清单", cmd: "node scripts/check-ocr-assets.mjs" },
  { id: "check-deep-link", group: "contract", label: "deep-link 交付通道", cmd: "node scripts/check-deep-link.mjs" },
  { id: "check-plugin-hosting", group: "contract", label: "插件托管", cmd: "node scripts/check-plugin-hosting.mjs" },

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
  { id: "rust-test", group: "rust", label: "Rust 单测 + 集成测试（cargo test）", cmd: "cargo test --manifest-path src-tauri/Cargo.toml" },
  {
    id: "rust-plugins-alone",
    group: "rust",
    label: "插件测试必须能单独跑",
    cmd: "cargo test --manifest-path src-tauri/Cargo.toml --lib plugins::",
    incident: "2026-09-13：某测试依赖进程级 APP_DATA_DIR ⇒ 单跑必红、全量反而绿，改一行只跑一条时极易误判",
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
