// **T-10 · 十台设备的多端验证**（`U14` 的判据承载）—— **本机档 ＝ 下界**
//
// 为什么要有它：`U14`（单个空间最多 10 台设备同步，owner 2026-09-30 定）的四条判据**今天没有承载**
// （`personal-edition-spec` §14 只写了"能承诺什么、不能承诺什么"）。本脚本就是那个承载 ——
// 它跑 `src-tauri/src/mesh.rs` 里那条 `#[ignore]` 的十台判据（**60 秒真实时钟 ＋ 10 个真窗口**），
// 把读数解析出来，**在这里独立复核**四条判据（Rust 侧也自断言；两边都绿才算绿）。
//
// ⚠️⚠️ **这一档的结论只能写成"下界"**（本仓既有纪律：**回环只当下界**）
//   · 它起的是 **10 个真网格窗口**（各自 `127.0.0.1:0` ⇒ 真 TCP 环回、真 HTTP）＋
//     **10 份独立库文件**（＝任务书 §15.2 说的"独立 `--db`"），全部绑**同一** `space_id`；
//   · **对端清单是手工填的**（每台填其余 9 台）—— 因为发现层在回环上**挑不出对端**
//     （`lan::is_lan_base` **明确把 `127/8` 排除**在"网段里的别人"之外，甲-1 的口径）
//     ⇒ ⇒ **绕过了发现层**。
//   ⇒ ⇒ 所以它验的是 **①收敛 ②不落后 ③拉取量 ④合并余量** 这四条；
//      **验不了**：**真实 UDP 发现下 10 台能不能互相发现** ——
//      `personal-edition-spec` §14 把那条标成 `[无依据]`，它的载体是
//      **`M-10`（10 台真机／真网段，要人手）**，**不在本脚本里**。
//      ⚠️ **不许**把本脚本的绿写成"真机 10 台通过" —— 那正是本仓禁的那类混用。
//
// 四条判据（**照抄** `docs/specs/2026-09-29-personal-edition-tasks.md` §15.1，**不自创**）：
//   ① **收敛**：10 台同时编辑 60 秒 ⇒ 10 台的最终内容**逐字节相同**；
//   ② **不落后**：任何一台的"最后拉取时间" ≤ **10 秒**（＝2 个节拍，留一倍余量）；
//   ③ **拉取量**：**每台 ≤2 次/秒**、合计 ≤**18 次/秒**（＝10×9÷5；⚠️ 扇出是 **N²**）；
//   ④ **合并余量**：10 台各 5 次编辑/秒 ⇒ 合计 50 次/秒 ⇒ **不超舒适上界（500）的 20%**。
//
// ⚠️ 判据 ③ 数的是**真的发生过的拉取**：Rust 侧在窗口的 `dispatch` 里对 `/mesh/pull` 计数
//    （`MeshHandle::served_pulls`）⇒ 本脚本拿"**服务侧真的服务过几次**"与"客户端发起几次"**对平**
//    ⇒ 有额外拉取（跳号回退／重试／附件）时**对不平**，判据 ③ 就不会被静默污染。
//
// 用法：node scripts/verify-mesh-ten-devices.mjs      # ≈2 分钟（60 秒真实编辑窗 ＋ 收敛 ＋ 编译）
// 出口码：**0** ＝ 四条判据全绿（且 cargo 自己也绿）；**1** ＝ 有条红或交叉验不成立；
//         **2** ＝ **没拿到读数**（编译失败／测试没跑）—— ⚠️ `AI-NATIVE-DEV.md` §4／§12.1：
//         **`exit 2` / `exit 3` 不算通过**。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST = "mesh::tests::ten_devices_converge_with_no_device_left_behind";

// ⚠️ 本机 `cargo` / `rustc` 装在 `~/.cargo/bin`，**默认不在 PATH 上** ⇒ 脚本自己补上
//    （不补的话这行会在别人机器上直接"命令找不到"，而那不是判据红、是环境）。允许 `CARGO=` 覆盖。
const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
const cargoBin = join(home, ".cargo", "bin");
const cargo = process.env.CARGO || (existsSync(join(cargoBin, "cargo")) ? join(cargoBin, "cargo") : "cargo");
const env = { ...process.env, PATH: `${cargoBin}:${process.env.PATH ?? ""}` };

/** 判据上限：**照抄 `U14`／§15.1**（一处集中，免得散在断言里）。 */
const LIMITS = {
  staleness_ms: 10_000, // ② ＝ 2 个节拍
  pulls_per_device_per_sec: 2.0, // ③ 每台
  pulls_per_sec_aggregate: 18.0, // ③ 合计 ＝ 10×9÷5
  comfort_share: 0.2, // ④ 舒适上界（~500/秒）的 20%
};

console.log("=== T-10 · 十台设备的多端验证（`U14` 的判据承载）===");
console.log("⚠️ 本机档（回环 ＋ 手工对端清单 ⇒ **绕过发现层**）＝ **下界**；");
console.log("   真发现层／真机 10 台（`M-10`，要人手）**不在本脚本里**，也**不许**由它背书。");
console.log(`[T-10] cargo = ${cargo}`);
console.log(`[T-10] 跑：cargo test --lib ${TEST} -- --ignored --nocapture（约 2 分钟）`);

const res = spawnSync(cargo, ["test", "--lib", TEST, "--", "--ignored", "--nocapture"], {
  cwd: join(root, "src-tauri"),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  env,
});
const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
const cargoOk = res.status === 0;

// Rust 侧那几行 `[T10]` 读数原样转出来（人先看读数，再看判定）
for (const line of out.split("\n")) {
  if (line.startsWith("[T10]") || line.startsWith("T10-READING ")) console.log(line);
}

const line = out.split("\n").find((l) => l.startsWith("T10-READING "));
if (!line) {
  console.error("\n✗ **没拿到 `T10-READING` 读数** ⇒ **不算通过**（exit 2）。");
  console.error("  最常见成因：编译失败 / 测试没跑起来 / 名字改了。下面是最后 30 行原始输出：");
  console.error(out.split("\n").slice(-30).join("\n"));
  process.exit(2);
}

/** @type {any} */
let r;
try {
  r = JSON.parse(line.slice("T10-READING ".length));
} catch (e) {
  console.error(`\n✗ 读数解析不出来（${e.message}）⇒ **不算通过**（exit 2）。`);
  process.exit(2);
}

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  (cond ? pass++ : fail++);
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};
const maxOf = (xs) => xs.reduce((a, b) => Math.max(a, b), -Infinity);

console.log("\n--- 前置（读数自带的口径）---");
ok(r.scope === "loopback-lower-bound", `读数自带"下界"标记（scope=${r.scope}）`);
ok(
  r.devices === 10 && r.cadence_ms === 5000,
  `台数 ${r.devices} 台 ｜ 节拍 ${r.cadence_ms} ms（＝产品默认 PULL_INTERVAL_DEFAULT_MS）`,
);
ok(cargoOk, `底下的 cargo test 自己也是绿的（exit=${res.status ?? "(信号中断)"}）`);

console.log("\n--- ① 收敛（10 台同时编辑 60 秒 ⇒ 最终内容逐字节相同）---");
ok(
  r.converged === true,
  `全库投影**逐字节相同**（${r.pages} 页 ｜ ${r.rounds} 轮；见 Rust 侧输出）`,
);

console.log("\n--- ② 不落后（任何一台 ≤ 10 秒）---");
ok(
  r.worst_staleness_ms <= LIMITS.staleness_ms,
  `最差落后 ${r.worst_staleness_ms} ms ≤ ${LIMITS.staleness_ms} ms（收尾最差 ${maxOf(r.final_staleness_ms)} ms）`,
);

console.log("\n--- ③ 拉取量（每台 ≤2 次/秒、合计 ≤18 次/秒）---");
const perDev = r.pulls_per_device_per_sec.map((x) => Math.round(x * 1000) / 1000);
ok(
  maxOf(r.pulls_per_device_per_sec) <= LIMITS.pulls_per_device_per_sec,
  `每台 ${JSON.stringify(perDev)} 次/秒 ≤ ${LIMITS.pulls_per_device_per_sec}` +
    `（调度窗口 ${r.window_rounds} 轮 × ${r.cadence_ms} ms ＝ ${r.window_ms} ms；` +
    `时间戳差 ${r.wallclock_ms} ms ⇒ 实测口径 ${Math.round(r.pulls_per_sec_aggregate_wallclock * 1000) / 1000} 次/秒）`,
);
ok(
  r.pulls_per_sec_aggregate <= LIMITS.pulls_per_sec_aggregate,
  `合计 ${Math.round(r.pulls_per_sec_aggregate * 1000) / 1000} 次/秒 ≤ ${LIMITS.pulls_per_sec_aggregate}` +
    `（＝10×9÷5；⚠️ 分母用**调度窗口** ⇒ 这是**上界**口径，真速率只会更低）`,
);
ok(
  r.server_served_pulls_total === r.client_pulls_total,
  `**交叉验**：服务侧真的服务过 ${r.server_served_pulls_total} 次 ＝ 客户端发起 ${r.client_pulls_total} 次` +
    `（对平 ⇒ 没有额外拉取污染判据 ③）`,
);

console.log("\n--- ④ 合并余量（合计编辑速率 ≤ 舒适上界 500/秒 的 20%）---");
ok(
  r.comfort_share <= LIMITS.comfort_share,
  `${Math.round(r.edits_per_sec * 10) / 10} 次/秒（${r.edits_total} 次编辑 / 60 秒）` +
    ` ＝ 舒适上界的 ${(r.comfort_share * 100).toFixed(1)}% ≤ ${LIMITS.comfort_share * 100}%`,
);

console.log("\n--- 信息项（**不是判据**）---");
console.log(
  `· 原始 content_json 逐字节相同 = ${r.raw_content_equal}` +
    `（本地写 vs 合并落库 ⇒ 序列化形态**允许**不同；判据是上面的**投影**比对）`,
);
console.log(`· 服务侧真的服务过 ${r.server_served_pulls_total} 次 / 客户端发起 ${r.client_pulls_total} 次`);

console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.error("✗ T-10 **本机档判据红**（见上）。⚠️ 这只说明**本机档**不成立；真机档仍归 M-10。");
  process.exit(1);
}
console.log("✓ T-10 本机档四条判据全绿。");
console.log("⚠️ 结论**只到「下界」**：真实 UDP 发现（10 台互相发现）**未验** ⇒ 那一档是 `M-10`（真机，要人手）。");
