#!/usr/bin/env node
// 两条 Android 流水线的**步骤一致性门禁**。
//
// 为什么需要它（不是"防患于未然"，是**已经出过事故**）：
//   `.github/workflows/android.yml`（自检包）里有 `pnpm android:mobile-shell`（把
//   `ShuyoFsPlugin.kt` / inset 桥 / 返回键处理注入 `gen/`）与它的 `--check`，
//   而 `.github/workflows/release.yml` 的 android job **没有这两步** ⇒ v1.91.0 的发版 APK
//   里根本没有那个类，用户装上直接
//       Caused by: java.lang.ClassNotFoundException: cn.shuyo.shuyonote.ShuyoFsPlugin
//   **闪退**。两条流水线的 CI 都是绿的（自检包一直是好的），谁也没发现——
//   直到真机装上发版件。
//
// 判据：把两个 job 的 `- name:` 列表**归一化后逐一比对**，任何只出现在一边的步骤都必须
// 落在下面那张**显式允许表**里并写明理由；否则红。这样"以后有人只给一条流水线加步骤"
// 会在 push 时就红，而不是在用户手机上。
//
// 归一化的原因：两条流水线里同名步骤的括号说明常有出入，例如
//   自检：「Build APK (arm64, unsigned)」/ 发版：「Build APK (arm64, unsigned -> 下一步用正式密钥签)」
//   自检：「注入 Android 壳适配层（窗口 inset 桥 + 返回键）」/ 发版：「…（窗口 inset 桥 + 返回键 + 选择器/安装插件）」
// 所以只取**首个括号之前**的部分比对（那部分才是"这一步干什么"）。
import { readFileSync, existsSync } from "node:fs";

const SELF = ".github/workflows/android.yml";
const REL = ".github/workflows/release.yml";
const REL_JOB = "android";

/** 归一化步骤名：去 `**`/反引号/首尾空白，并砍掉首个括号及其后（半角与全角都算）。 */
function normalize(name) {
  return name
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .split(/[（(]/)[0]
    .trim();
}

/** 取某个文件里缩进为 6 空格的 `- name:`（= job 的步骤）。jobName 给了就只取那个 job 的范围。 */
function steps(file, jobName) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let from = 0;
  let to = lines.length;
  if (jobName) {
    const start = lines.findIndex((l) => new RegExp(`^  ${jobName}:\\s*$`).test(l));
    if (start < 0) return { steps: [], error: `找不到 job \`${jobName}:\`` };
    from = start;
    // 下一个顶格（2 空格）的 job 或文件结束
    for (let i = start + 1; i < lines.length; i++) {
      if (/^  [A-Za-z_][\w-]*:\s*$/.test(lines[i])) {
        to = i;
        break;
      }
    }
  }
  const out = [];
  for (let i = from; i < to; i++) {
    const m = lines[i].match(/^\s{6}- name:\s*(.+?)\s*$/);
    if (m) out.push(m[1]);
  }
  return { steps: out, error: null };
}

/**
 * 允许的差异：只在一边出现的步骤，必须在此处写明理由。
 * 两条流水线的**定位不同**（自检包 vs 可发布件），所以差异本身是合理的——
 * 不合理的是"悄悄多一步/少一步构建输入"。
 */
const ALLOWED = {
  selfOnly: {
    "报告产物体积": "自检流水线专有：量体积是它存在的理由之一（发版件不量）",
    "Upload APK": "自检流水线专有：传未签名包与体积报告",
    "Upload 已签名 APK": "自检流水线专有：artifact 名带 signed-test-hooks，只供自检/真机验收",
  },
  releaseOnly: {
    "用正式密钥签名 APK": "发版流水线专有：自检包也签名，但步骤名不同（见下一条）",
    "断言 APK 内 ABI 恰为 arm64-v8a": "发版流水线专有：产物级断言（自检包不需要）",
    "断言发版 APK 的 dex 里真的有壳适配层": "发版流水线专有：v1.91.0 闪退的产物级判据，见 §9.1",
    "改名成可辨识的发版文件名": "发版流水线专有：改成 ShuyoNote_<版本>_android-arm64-release.apk",
    "记录 APK 的 sha256": "发版流水线专有：产出更新清单里的 signature 凭据",
    "Upload 发版 APK": "发版流水线专有：artifact 名 android-release-apk",
  },
};

const self = steps(SELF);
const rel = steps(REL, REL_JOB);
let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
};

if (self.error) {
  console.error(`✗ 读 ${SELF} 失败：${self.error}`);
  process.exit(1);
}
if (rel.error) {
  console.error(`✗ 读 ${REL} 的 \`${REL_JOB}\` job 失败：${rel.error}`);
  process.exit(1);
}

console.log(`[release-parity] 自检流水线 ${self.steps.length} 步 · 发版流水线 android job ${rel.steps.length} 步`);

// 先自证"真的解析到了"：解析器坏掉返回空数组时，下面的集合比较会"全绿"——这正是最坏的假绿。
ok(self.steps.length >= 10, `解析到自检流水线的步骤（${self.steps.length} ≥ 10）——解析器没瞎`);
ok(rel.steps.length >= 10, `解析到发版 android job 的步骤（${rel.steps.length} ≥ 10）——解析器没瞎`);

const selfNorm = new Map(self.steps.map((s) => [normalize(s), s]));
const relNorm = new Map(rel.steps.map((s) => [normalize(s), s]));

const selfOnly = [...selfNorm.keys()].filter((k) => !relNorm.has(k));
const relOnly = [...relNorm.keys()].filter((k) => !selfNorm.has(k));

// 1) 自检有、发版没有 —— 这一边就是 v1.91.0 闪退的方向，最危险
const badSelfOnly = selfOnly.filter((k) => !(k in ALLOWED.selfOnly));
ok(
  badSelfOnly.length === 0,
  badSelfOnly.length === 0
    ? `自检流水线的步骤在发版件里都有（或已显式豁免）`
    : `这些步骤只在**自检包**里有、发版件没有，且没写进允许表：${badSelfOnly.join("、")}\n` +
      `      ⇒ 发版 APK 会缺这一步的产物（v1.91.0 就是这么闪退的：漏了壳适配层注入）。\n` +
      `      要么把它补进 release.yml 的 android job，要么在 ALLOWED.selfOnly 里写明理由。`,
);

// 2) 发版有、自检没有 —— 一般无害（发版件多几道断言），但仍要求显式记账
const badRelOnly = relOnly.filter((k) => !(k in ALLOWED.releaseOnly));
ok(
  badRelOnly.length === 0,
  badRelOnly.length === 0
    ? `发版流水线多出来的步骤都已显式记账`
    : `这些步骤只在**发版件**里有、自检包没有，且没写进允许表：${badRelOnly.join("、")}`,
);

// 3) 允许表里写的步骤必须真的存在（否则表会腐化成"过期的豁免"，下次真漏了却看着豁免过的名字）
for (const [k, why] of Object.entries(ALLOWED.selfOnly)) {
  ok(selfNorm.has(k), `允许表里的「${k}」确实在自检流水线里（${why}）`);
}
for (const [k, why] of Object.entries(ALLOWED.releaseOnly)) {
  ok(relNorm.has(k), `允许表里的「${k}」确实在发版流水线里（${why}）`);
}

// 4) 关键构建输入：**逐条点名**（不依赖集合比较的写法），确保以后重构也不会把这几步弄丢
const MUST_HAVE_BOTH = ["注入 rustls-platform-verifier 的 JVM 组件", "注入 Android 壳适配层", "Init Android project", "Build APK"];
for (const k of MUST_HAVE_BOTH) {
  ok(
    selfNorm.has(k) && relNorm.has(k),
    `「${k}」两条流水线都有（缺了就是"一边能构建、另一边构建出来的包是坏的"）`,
  );
}

console.log(`[结果] release-parity ${failed === 0 ? "通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
