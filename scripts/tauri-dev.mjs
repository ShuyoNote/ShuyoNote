#!/usr/bin/env node
// ShuyoNote 桌面版开发启动器。
//
// 为什么需要它：裸 `pnpm tauri dev` 在几种环境下会踩坑——
//   1. `cargo` 不在 PATH（DSH 沙箱的 PATH 被洗过；macOS 上要 `source ~/.cargo/env`）；
//   2. **PATH 里混进宿主/沙箱的目录**会让 `cargo-tauri` 把它当成子命令
//      （DSH 沙箱会灌 `/Applications/DSH Desktop.app/...`）⇒ `unrecognized subcommand` 直接退出。
//      所以启动前自建一条干净 PATH；
//   3. 端口 1420/1421 被占用时 `vite`（strictPort）与 tauri 会直接报 PORT in use 退出。
//
// 本脚本：探测 cargo → 自建干净 PATH → 检查 1420/1421 → 可选清理残留进程 →
// 后台启动 `pnpm tauri dev`（日志写系统临时目录）→ 打印健康 URL。
//
// 用法（建议从终端用 pnpm 入口）：
//   pnpm run dev:desktop                 # 默认：若端口被占用先清理再启动
//   pnpm run dev:desktop -- --no-clean   # 不清理，直接启动（端口被占用会失败）
//   pnpm run dev:desktop -- --attach     # 不启动，只打印当前 dev 日志/进程状态
// 也可直接：
//   node scripts/tauri-dev.mjs [--no-clean|--attach]
//
// 交付物：脚本本身加入 git（scripts/）；运行方式是本机开发习惯，不计入 CI。
//
// ---------------------------------------------------------------------------
// 2026-09-22：**跨平台重写**（此前它只认 macOS/Linux）
//
// 背景：这台开发机是 **Windows**，而旧版在第 3 行就 `bash -lc 'command -v cargo'`
// ⇒ 直接打印"找不到 cargo"退出，而 cargo 明明在 `%USERPROFILE%\.cargo\bin`。
// 旧版一共四处 POSIX-only：`bash -lc` / `command -v` / `lsof` / `ps -axo` / 写死 `/tmp/`。
// 现在按 `process.platform` 分支，口径是"**能用 Node 自己做的就不用外部命令**"：
//   · 端口占用探测 → `node:net` 直接试着 bind（两边同一套逻辑，不再依赖 lsof）；
//   · "谁占着端口" → POSIX 用 `lsof -t`，Windows 用 `netstat -ano` + PID 列；
//   · 残留进程提示 → POSIX 用 `ps -axo pid,command` 精确匹配命令行；
//     Windows 只按**镜像名**给提示（拿命令行要 PowerShell/WMI，启动时多花约 1 秒不值当，
//     见 `findTauriDevProcs` 的注释）；
//   · 日志路径 → `os.tmpdir()`（macOS 上是 `/var/folders/…`，脚本会把它打印出来）；
//   · PATH 分隔符 → Windows `;` / POSIX `:`；npm 可执行文件 → Windows `pnpm.cmd` + `shell`。
// ⚠️ 仓库根目录用 `fileURLToPath` 而不是 `new URL("..").pathname`：后者在 Windows 上
//    会给出 `/C:/Users/...` 这种带前导斜杠的路径，`cwd` 直接失效。
// ---------------------------------------------------------------------------

import { execFileSync, execSync, spawn } from "node:child_process";
import { closeSync, createWriteStream, existsSync, openSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const root = fileURLToPath(new URL("..", import.meta.url));
const npm = {
  host: "127.0.0.1",
  vitePort: 1420,
  hmrPort: 1421,
};
const LOG = path.join(os.tmpdir(), "shuyonote-tauri-dev.log");

const args = process.argv.slice(2);
const NO_CLEAN = args.includes("--no-clean");
const ATTACH = args.includes("--attach");

// ---- helpers ----

/**
 * 自建一条"干净" PATH：把"真实的" cargo / node 排在最前，并（在 POSIX 上）剔掉宿主目录。
 *
 * ⚠️ **两边的判据不一样，这是有意的**：
 *   · POSIX：`cargo-tauri` 会被**任何带空格的 PATH 项**带偏（那一项被当成子命令）
 *     ⇒ 含空格就剔除（DSH 灌进来的 `/Applications/DSH Desktop.app/...` 正是这种）；
 *   · Windows：**空格不是问题**（`C:\Program Files\nodejs` 是常态，CreateProcess 不做
 *     词切分）⇒ **一个都不过滤**，只把 `.cargo\bin` 与当前 node 目录提到最前。
 *     第一版照着 POSIX 的规则筛，结果把 node 自己的目录筛掉又由 `prefer` 加回来——
 *     自相矛盾，所以这里按平台分开写清楚。
 *
 * 注：在 DSH 里跑时，harness 的 `pnpm` 垫片（`dsh-desktop pnpm runner`）也在 PATH 里，
 * 它会看门狗式地收掉"静默 300 秒"的子进程——**这是宿主行为，不在本脚本的处理范围**；
 * 想要一个不被收掉的 dev，请在**自己的终端**里跑本脚本。
 */
function cleanPath() {
  const sep = IS_WIN ? ";" : ":";
  const home = os.homedir();
  const existing = (process.env.PATH ?? "").split(sep).filter(Boolean);
  const kept = IS_WIN ? existing : existing.filter((p) => !/\s/.test(p));
  const prefer = IS_WIN
    ? [
        path.join(home, ".cargo", "bin"),
        path.dirname(process.execPath), // 当前 node（DSH 的也不带空格）
      ]
    : [
        path.join(home, ".local", "node-v24.20.0-darwin-arm64", "bin"), // node + pnpm（真实）
        path.join(home, ".cargo", "bin"), // cargo / cargo-tauri
        path.dirname(process.execPath), // 兜底：当前 node 目录
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ];
  return [...new Set([...prefer, ...kept])].join(sep);
}

/** `cargo --version`；找不到返回 null。Windows 上直接试 `.cargo\bin\cargo.exe`。 */
function cargoVersion() {
  const candidates = ["cargo"];
  if (IS_WIN) candidates.push(path.join(os.homedir(), ".cargo", "bin", "cargo.exe"));
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      if (out.trim()) return out.trim();
    } catch {
      /* 试下一个 */
    }
  }
  // POSIX 兜底：登录 shell 里 cargo 可能来自 `~/.cargo/env`（PATH 被洗过的场景）。
  if (!IS_WIN) {
    try {
      const out = execSync(
        `bash -lc 'source "$HOME/.cargo/env" >/dev/null 2>&1; command -v cargo; cargo --version 2>/dev/null'`,
        { encoding: "utf8" },
      ).trim();
      if (out) return out.split("\n").pop().trim();
    } catch {
      /* 没有就没有 */
    }
  }
  return null;
}

/**
 * 端口是否被占用：直接试着 bind 一下（`node:net`），不再依赖 `lsof`。
 * ⚠️ 只在 `127.0.0.1` 上试——这与仓库 `vite.config.ts` 里 host 的设置一致。
 *    若某进程**只**监听 `::1`，这里会判成"空闲"（vite 默认两条都听，实测不受影响）。
 */
function portBusy(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e) => resolve(e.code === "EADDRINUSE" || e.code === "EACCES"));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, npm.host);
  });
}

/** 找出监听某端口的 PID：POSIX 用 `lsof -t`；Windows 解析 `netstat -ano`。 */
function pidsOnPort(port) {
  try {
    if (IS_WIN) {
      const out = execSync("netstat -ano -p tcp", { encoding: "utf8", windowsHide: true });
      const pids = new Set();
      // 形如：  TCP    127.0.0.1:1420    0.0.0.0:0    LISTENING    12345
      // ⚠️ 不能只 `includes(":1420")`——`:14200` 也会命中，所以要带上分隔符。
      const re = new RegExp(`:${port}\\s`);
      for (const line of out.split(/\r?\n/)) {
        if (!re.test(line)) continue;
        if (!/LISTENING/i.test(line)) continue;
        const cols = line.trim().split(/\s+/);
        const pid = cols[cols.length - 1];
        if (/^\d+$/.test(pid) && pid !== "0") pids.add(pid);
      }
      return [...pids];
    }
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`, {
      encoding: "utf8",
      shell: "/bin/bash",
    });
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

function killPids(pids, label) {
  for (const pid of pids) {
    try {
      // Windows 上 Node 的 `SIGTERM` 就是 TerminateProcess（没有真正的信号语义）。
      process.kill(Number(pid), "SIGTERM");
    } catch {
      /* 已经没了 */
    }
  }
  console.log(`  [dev] 已终止占用 ${label} 的进程 ${pids.join(", ")}`);
}

/**
 * 等端口真的空出来（轮询）；期间每隔一段时间调用一次 `onTick`（用来补杀）。
 * ⚠️ 必须轮询：见下面端口清理那段的注释 —— 立刻重查在 Windows 上会误判成"清理失败"。
 */
async function waitPortFree(port, timeoutMs, onTick) {
  const t0 = Date.now();
  let lastTick = 0;
  for (;;) {
    if (!(await portBusy(port))) return true;
    const now = Date.now();
    if (now - t0 > timeoutMs) return false;
    if (onTick && now - lastTick > 1500) {
      lastTick = now;
      onTick();
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * 残留的 tauri / vite 进程（**只做客套提示，不自动杀**）。
 *
 * POSIX：`ps -axo pid,command` 能拿到命令行 ⇒ 精确匹配 `tauri dev` / `vite`。
 * Windows：拿命令行要么 `wmic`（已废弃）要么 PowerShell CIM（每次约 1 秒），
 *          而这里只是个提示 ⇒ 退化成**按镜像名**看看 `shuyonote.exe` / `cargo.exe`
 *          还在不在，够用来提醒"你上次那个窗口可能没关干净"。
 */
function findTauriDevProcs() {
  try {
    if (IS_WIN) {
      const rows = [];
      for (const image of ["shuyonote.exe", "cargo.exe"]) {
        try {
          const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`, {
            encoding: "utf8",
            windowsHide: true,
          });
          for (const line of out.split(/\r?\n/)) {
            if (!line.includes(image)) continue;
            const m = line.match(/"([^"]+)","(\d+)"/);
            if (m) rows.push(`${m[2]} ${m[1]}`);
          }
        } catch {
          /* 没有这个镜像就跳过 */
        }
      }
      return rows;
    }
    const out = execSync(
      `ps -axo pid,command | grep -iE 'tauri dev|vite.js? (--config )?' | grep -v grep | grep -v "${process.pid}"`,
      { encoding: "utf8", shell: "/bin/bash" },
    );
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** 读日志尾部的 n 行（替代 `tail -n`，两个平台同一套）。 */
function tailLog(n = 15) {
  try {
    const lines = readFileSync(LOG, "utf8").split(/\r?\n/);
    return lines.slice(-n).join("\n").trim();
  } catch {
    return "";
  }
}

const healthUrl = `http://${npm.host}:${npm.vitePort}`;

// ---- mode: report only ----
if (ATTACH) {
  const busyVite = await portBusy(npm.vitePort);
  const busyHmr = await portBusy(npm.hmrPort);
  console.log(`[dev] 当前状态（${npm.host}：vite ${npm.vitePort} / hmr ${npm.hmrPort}）：`);
  console.log(`  平台       ${process.platform}`);
  console.log(`  vite :${npm.vitePort}  ${busyVite ? "占用" : "空闲"}`);
  console.log(`  hmr  :${npm.hmrPort}  ${busyHmr ? "占用" : "空闲"}`);
  const procs = findTauriDevProcs();
  console.log(`  残留进程   ${procs.length} 个${IS_WIN ? "（Windows 上按镜像名统计 shuyonote/cargo）" : ""}`);
  for (const p of procs.slice(0, 5)) console.log("    " + p);
  console.log(`  日志       ${LOG}${existsSync(LOG) ? "" : "（还没有）"}`);
  const tail = tailLog(15);
  if (tail) console.log("\n[日志尾部]\n" + tail);
  process.exit(0);
}

// ---- cargo ----
const cargoVer = cargoVersion();
if (!cargoVer) {
  console.error("[dev] ✗ 找不到 cargo。");
  console.error(
    IS_WIN
      ? "      期望在 PATH 或 %USERPROFILE%\\.cargo\\bin\\cargo.exe；没装的话先装 Rust（rustup）。"
      : "      已尝试 PATH 与 `source ~/.cargo/env`；没装的话先装 Rust（rustup）。",
  );
  process.exit(1);
}
console.log(`[dev] cargo：${cargoVer}`);

// 自建干净 PATH（脱敏：剔除宿主/沙箱目录），cargo-tauri 才能正确解析。
const PATH_FOR_DEV = cleanPath();
console.log(`[dev] 使用干净 PATH（已剔除宿主目录，${IS_WIN ? ";" : ":"} 分隔）：\n      ${PATH_FOR_DEV}`);

// ---- port preflight ----
const busy = [];
if (await portBusy(npm.vitePort)) busy.push(npm.vitePort);
if (await portBusy(npm.hmrPort)) busy.push(npm.hmrPort);

if (busy.length > 0) {
  if (NO_CLEAN) {
    console.error(`[dev] ✗ 端口 ${busy.join(", ")} 被占用（strictPort 会拒绝启动），且 --no-clean 已指定。`);
    console.error("      先停掉占用进程，或去掉 --no-clean 让本脚本清理。");
    process.exit(1);
  }
  console.log(`[dev] ⚠️ 端口 ${busy.join(", ")} 被占用，尝试清理…`);
  for (const port of busy) {
    const pids = pidsOnPort(port);
    if (pids.length) killPids(pids, `:${port}`);
  }
  // ⚠️ 杀完**必须轮询等端口真的释放**，不能立刻重查：Windows 上 `TerminateProcess` 之后
  //    监听套接字不会立刻消失，马上重查会看到"仍被占用"，于是误判成"权限不够/系统服务"
  //    直接 exit 1 —— 2026-09-22 实测踩到：明明已经杀掉了 pid 27392，却报"无法清理"。
  //    （这条路径之前从没在 Windows 上真跑过：上次验的是"端口空着"的 happy path。）
  // 等待期间再补一次重杀（第一次 SIGTERM 可能没落地）。
  for (const port of busy) {
    const freed = await waitPortFree(port, 6000, () => {
      const pids = pidsOnPort(port);
      if (pids.length) killPids(pids, `:${port}（第二次）`);
    });
    if (!freed) console.log(`[dev] ⚠️ :${port} 6 秒内没释放，继续检查…`);
  }
  const still = [];
  if (await portBusy(npm.vitePort)) still.push(npm.vitePort);
  if (await portBusy(npm.hmrPort)) still.push(npm.hmrPort);
  if (still.length) {
    console.error(`[dev] ✗ 端口 ${still.join(", ")} 仍被占用，无法清理。请手动处理（或加 --no-clean 自行处理）。`);
    process.exit(1);
  }
  console.log(`[dev] 端口已清理：${busy.join(", ")} 现在空闲`);
}

// ---- warn about stale tauri/vite (not holding 1420 but still running) ----
const stale = findTauriDevProcs();
if (stale.length) {
  console.log(`[dev] ℹ️ 检测到 ${stale.length} 个残留进程（未占 ${npm.vitePort}）：`);
  for (const s of stale.slice(0, 5)) console.log("    " + s);
  console.log("       若非你正在用，可手动结束；本脚本照常启动。");
}

// ---- launch ----
console.log(`[dev] 启动桌面 dev：pnpm tauri dev（日志 ${LOG}）…`);
/**
 * ⚠️ Windows 上必须走 `pnpm` + `shell: true`：`pnpm` 是个 `.cmd`，
 *    直接 `spawn("pnpm")` 会 ENOENT（Node ≥ 18.20 起 `.cmd/.bat` 只能经 shell 启动）。
 *    而 `shell: true` **再传 args 数组**会触发 `DEP0190` 弃用警告（"参数只做拼接、不转义"）
 *    ⇒ Windows 这条把整条命令写成一个字符串、不再传 args（命令里没有用户输入，无注入面）；
 *    POSIX 那条仍是 `spawn("pnpm", ["tauri","dev"])`，不经过 shell。
 * ⚠️ 子进程 env 要**先把大小写各异的 Path 删掉**再设 `PATH`：
 *    Windows 环境变量不区分大小写，而 Node 会原样把两份都传下去，
 *    子进程可能读到旧的那份 `Path`（于是"干净 PATH"白设了）。
 */
const childEnv = { ...process.env };
for (const k of Object.keys(childEnv)) if (/^path$/i.test(k)) delete childEnv[k];
childEnv.PATH = PATH_FOR_DEV;

const spawnOpts = {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: childEnv,
  windowsHide: false,
};
const child = IS_WIN
  ? spawn("pnpm tauri dev", { ...spawnOpts, shell: true })
  : spawn("pnpm", ["tauri", "dev"], spawnOpts);

const logStream = createWriteStream(LOG, { flags: "a" });
child.stdout.pipe(logStream, { end: false });
child.stderr.pipe(logStream, { end: false });

child.on("exit", (code) => {
  console.log(`[dev] pnpm tauri dev 退出，code=${code}`);
  try {
    closeSync(logStream.fd ?? 0);
  } catch {
    /* ignore */
  }
  process.exit(code ?? 0);
});

// 等 vite 起来，给用户一个明确的健康 URL。
console.log(`[dev] 等待 vite :${npm.vitePort} 起来…`);
let tries = 0;
const timer = setInterval(async () => {
  tries++;
  if (await portBusy(npm.vitePort)) {
    clearInterval(timer);
    console.log(`[dev] ✅ 桌面 dev 已启动：${healthUrl}  (tsc 通过后 Tauri 窗口将打开)`);
    console.log(`     日志：${LOG}    停止：Ctrl+C 或结束本 shell 任务`);
  } else if (tries > 90) {
    clearInterval(timer);
    console.warn(`[dev] ⚠️ 90 秒内未等到 vite 监听 :${npm.vitePort}。查看日志排查：`);
    console.warn(`     ${LOG}`);
  }
}, 1000);

// 保持进程存活（spawn 子进程已挂到 stdout/stderr 管道）；本进程作为前台任务常驻。
await new Promise(() => {});
