// 「这次到底取哪个平台的 PDFium」这一步的**判据化**。
//
// 为什么单独抽一个模块（2026-09-20 实测踩出来的真 bug，CI 变红的就是它）：
//   `.github/workflows/android.yml` 与 `release.yml` 里写的是**位置形式**
//   `node scripts/fetch-pdfium.mjs android-arm64`，而 `fetch-pdfium.mjs` 原本只认
//   `--platform <名>` —— 位置参数被**静默忽略**、脚本回落成"当前平台"，
//   于是在 ubuntu runner 上取回的是 **linux-x64**（日志里明明白白：
//   `[fetch-pdfium] target: PDFium 151.0.7881.0 (build 7881) / linux-x64`）。
//   报错点却隔了一步：下一句 `pnpm android:stage-pdfium` 才说
//   「vendor 里没有 android-arm64 的那份库」⇒ 读日志的人会去查 vendor、查 stage，
//   而真凶是"参数被吃掉"。
//
// ⇒ 这里的口径是：**位置参数与 `--platform` 等价**，且
//   **认不出的值一律硬失败**（exit 2），不留"静默回落"这个状态——
//   "写错了却跑得下去"比"直接报错"贵得多。

/** 后面必须跟一个值的开关（解析时要把它们的值跳过去，别当成平台名）。 */
export const VALUE_FLAGS = ["--platform", "--print-sha256"];

/**
 * 解析 `process.argv.slice(2)`，得出本次要取的平台。
 *
 * @param {string[]} argv            去掉 `node 脚本` 之后的参数
 * @param {{ detect: () => string|null, known: Record<string, unknown> }} opts
 *        `detect` 是"没给平台时按当前系统猜"的兜底，`known` 是支持的平台表（取其键做白名单）
 * @returns {{ platform: string } | { error: string }}
 */
export function resolvePlatform(argv, { detect, known }) {
  const list = Object.keys(known);
  /** @type {{ value: string|null, source: string|null }} */
  const want = { value: null, source: null };
  const positionals = [];

  const take = (value, source) => {
    if (want.value !== null && want.value !== value) {
      return `平台给了两次且不一致：${want.source} 说 ${want.value}，${source} 说 ${value} —— 不猜，请只留一个`;
    }
    want.value = value;
    want.source = source;
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined) return { error: `${a} 后面缺少值` };
      if (a === "--platform") {
        const err = take(v, "--platform");
        if (err) return { error: err };
      }
      i++; // 跳过它的值
      continue;
    }
    if (a.startsWith("-")) continue; // 其它开关（如 --check）
    positionals.push(a);
  }

  if (positionals.length > 1) {
    return { error: `平台只能给一个，收到 ${positionals.length} 个：${positionals.join(", ")}` };
  }
  if (positionals.length === 1) {
    const err = take(positionals[0], "位置参数");
    if (err) return { error: err };
  }

  const platform = want.value ?? detect();
  if (!platform) {
    return { error: `没给平台，也认不出当前系统 —— 用 --platform <名> 指定；可选：${list.join(", ")}` };
  }
  if (!list.includes(platform)) {
    // ★ 这一条就是那次 CI 红的根因所在：写错的名字必须**当场**报错。
    return { error: `不支持的平台：${platform}（来自${want.source ?? "当前系统"}）；可选：${list.join(", ")}` };
  }
  return { platform };
}
