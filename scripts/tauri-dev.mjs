#!/usr/bin/env node
// ShuyoNote 桌面版开发启动器。
//
// 为什么需要它：`pnpm tauri dev` 在 DSH / 某些 shell 里会踩三个坑——
//   1. `cargo` 不在 PATH（DSH 沙箱的 PATH 已污染，需先 source ~/.cargo/env）。
//   2. **DSH 沙箱把 /Applications/DSH Desktop.app/.../MacOS（路径含空格）灌进 PATH**，
//      cargo-tauri 会把带空格的路径当成子命令 → `unrecognized subcommand` 直接退出。
//      所以启动前必须**自建干净 PATH**：只留 node + cargo + 系统 bin，剔除这些污染项。
//   3. 端口 1420/1421 被占用时 `vite`/`tauri` 因 strictPort 直接报 PORT in use 退出。
//
// 本脚本：sources cargo → 自建干净 PATH → 检查 1420/1421 → 可选清理残留进程 →
// 后台启动 `pnpm tauri dev`（日志写 /tmp/shuyonote-tauri-dev.log）→ 打印健康 URL。
//
// 用法（建议从终端用 pnpm 入口）：
//   pnpm run dev:desktop                 # 默认：若端口被占用先清理再启动
//   pnpm run dev:desktop -- --no-clean   # 不清理，直接启动（端口被占用会失败）
//   pnpm run dev:desktop -- --attach     # 不启动，只打印当前 dev 日志/进程状态
// 也可直接：
//   node scripts/tauri-dev.mjs [--no-clean|--attach]
//
// 交付物：脚本本身加入 git（scripts/）；运行方式是本机开发习惯，不计入 CI。

import { execSync, spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const npm = {
  host: "127.0.0.1",
  vitePort: 1420,
  hmrPort: 1421,
};

const args = process.argv.slice(2);
const NO_CLEAN = args.includes("--no-clean");
const ATTACH = args.includes("--attach");

// ---- helpers ----
// 自建干净 PATH：node + cargo + 系统 bin。剔除 DSH 沙箱灌入的带空格路径
// （/Applications/DSH Desktop.app/.../MacOS），否则 cargo-tauri 会把它当子命令。
function cleanPath() {
  const home = process.env.HOME ?? "";
  // 优先放“真实”的 node/pnpm（本地安装），其次 cargo；最后系统 bin。
  // 若当前 shell 的 node 来自 DSH 沙箱（dsh-desktop/harness/.desktop-bin），
  // 也是可用 node（无空格），但为了确定性，把本地 node 目录排最前。
  const parts = [
    `${home}/.local/node-v24.20.0-darwin-arm64/bin`, // node + pnpm（真实）
    `${home}/.cargo/bin`,                            // cargo / cargo-tauri
    execSync(`dirname $(command -v node)`).toString().trim(), // 兜底：当前 node 目录
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(parts)].join(":");
}

const hasCargo = () => {
  try {
    execSync("command -v cargo", { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
};

// Source ~/.cargo/env and print the cargo path it resolves to (for the user).
const sourceCargo = () => {
  const hs = process.env.HOME ?? "";
  const envFile = `${hs}/.cargo/env`;
  try {
    const out = execSync(
      `bash -lc 'source ${envFile} >/dev/null 2>&1; command -v cargo; cargo --version 2>/dev/null'`,
      { encoding: "utf8" },
    ).trim();
    return out;
  } catch {
    return null;
  }
};

const portBusy = (port) => {
  try {
    execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN >/dev/null 2>&1`, { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
};

// Find PIDs listening on a port (vite/tauri dev left over).
const pidsOnPort = (port) => {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: "utf8", shell: "/bin/bash" });
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
};

const killPids = (pids, label) => {
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  console.log(`  [dev] 已终止占用 ${label} 的进程 ${pids.join(", ")}`);
};

const findTauriDevProcs = () => {
  try {
    const out = execSync(
      `ps -axo pid,command | grep -iE 'tauri dev|vite.js? (--config )?' | grep -v grep | grep -v "${process.pid}"`,
      { encoding: "utf8", shell: "/bin/bash" },
    );
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const healthUrl = `http://127.0.0.1:${npm.vitePort}`;

// ---- mode: report only ----
if (ATTACH) {
  console.log(`[dev] 当前状态（vite ${npm.vitePort} / hmr ${npm.hmrPort}）：`);
  console.log(`  vite :${npm.vitePort}  ${portBusy(npm.vitePort) ? "占用" : "空闲"}`);
  console.log(`  hmr  :${npm.hmrPort}  ${portBusy(npm.hmrPort) ? "占用" : "空闲"}`);
  const procs = findTauriDevProcs();
  console.log(`  tauri/vite 进程数：${procs.length}`);
  for (const p of procs.slice(0, 5)) console.log("    " + p);
  try {
    const log = execSync(`tail -n 15 /tmp/shuyonote-tauri-dev.log 2>/dev/null || true`, { encoding: "utf8", shell: "/bin/bash" });
    if (log.trim()) console.log("\n[日志尾部]\n" + log);
  } catch {
    /* no log */
  }
  process.exit(0);
}

// ---- cargo + clean PATH ----
if (!hasCargo()) {
  const ver = sourceCargo();
  if (ver) {
    console.log(`[dev] 已 source ~/.cargo/env -> ${ver.split("\n")[0]}`);
  } else {
    console.error("[dev] ✗ 找不到 cargo（已尝试 source ~/.cargo/env）。请确认 Rust 已安装。");
    process.exit(1);
  }
}
// 自建干净 PATH（脱敏：剔除 DSH 沙箱灌入的带空格路径），cargo-tauri 才能正确解析。
const cleanPathStr = cleanPath();
console.log(`[dev] 使用干净 PATH（已剔除 DSH 沙箱带空格路径）：\n      ${cleanPathStr}`);
const PATH_FOR_DEV = cleanPathStr;

// ---- port preflight ----
const busy = [];
if (portBusy(npm.vitePort)) busy.push(npm.vitePort);
if (portBusy(npm.hmrPort)) busy.push(npm.hmrPort);

if (busy.length > 0) {
  if (NO_CLEAN) {
    console.error(`[dev] ✗ 端口 ${busy.join(", ")} 被占用（strictPort 会拒绝启动），且 --no-clean 已指定。`);
    console.error(`      可先停掉占用进程，或直接运行 (不清理) git stash/重启。`);
    process.exit(1);
  }
  console.log(`[dev] ⚠️ 端口 ${busy.join(", ")} 被占用，尝试清理…`);
  for (const port of busy) {
    const pids = pidsOnPort(port);
    if (pids.length) killPids(pids, `:${port}`);
  }
  // 再检查一遍；若仍有占用（权限/系统服务）则放弃。
  const still = [];
  if (portBusy(npm.vitePort)) still.push(npm.vitePort);
  if (portBusy(npm.hmrPort)) still.push(npm.hmrPort);
  if (still.length) {
    console.error(`[dev] ✗ 端口 ${still.join(", ")} 仍被占用，无法清理。请手动处理。`);
    process.exit(1);
  }
}

// ---- warn about stale tauri/vite (not holding 1420 but still running) ----
const stale = findTauriDevProcs();
if (stale.length) {
  console.log(`[dev] ℹ️ 检测到 ${stale.length} 个残留 tauri/vite 进程（未占 1420）：`);
  for (const s of stale.slice(0, 5)) console.log("    " + s);
  console.log("       若非你正在用，可手动 kill；本脚本照常启动。");
}

// ---- launch ----
console.log(`[dev] 启动桌面 dev：pnpm tauri dev（日志 /tmp/shuyonote-tauri-dev.log）…`);
const child = spawn("pnpm", ["tauri", "dev"], {
  cwd: root,
  shell: "/bin/bash",
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PATH: PATH_FOR_DEV },
});

const fs = await import("node:fs");
const logFd = fs.openSync("/tmp/shuyonote-tauri-dev.log", "a");
child.stdout.pipe(fs.createWriteStream(null, { fd: logFd }));
child.stderr.pipe(fs.createWriteStream(null, { fd: logFd }));

child.on("exit", (code) => {
  console.log(`[dev] pnpm tauri dev 退出，code=${code}`);
  try {
    fs.closeSync(logFd);
  } catch {}
  process.exit(code ?? 0);
});

// 等待 vite 起来，给用户一个明确的健康 URL。
console.log(`[dev] 等待 vite :${npm.vitePort} 起来…`);
let tries = 0;
const waitTicks = setInterval(() => {
  tries++;
  if (portBusy(npm.vitePort)) {
    clearInterval(waitTicks);
    console.log(`[dev] ✅ 桌面 dev 已启动：${healthUrl}  (tsc 通过后 Tauri 窗口将打开)`);
    console.log(`     日志：/tmp/shuyonote-tauri-dev.log    停止：Ctrl+C 或 kill 本 shell 任务`);
  } else if (tries > 90) {
    clearInterval(waitTicks);
    console.warn(`[dev] ⚠️ 90 秒内未等到 vite 监听 :${npm.vitePort}。查看日志排查：`);
    console.warn("     tail -n 60 /tmp/shuyonote-tauri-dev.log");
  }
}, 1000);

// 保持进程存活（spawn 子进程已挂到 stdout/stderr 管道）；本进程作为前台任务常驻。
await new Promise(() => {});
