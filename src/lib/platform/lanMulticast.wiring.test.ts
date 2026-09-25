// ★ 2026-09-25（真机实测逼出来的一条接线）：**Android 收 UDP 广播要先拿 MulticastLock**。
//
// 现场：两台手机在同一个热点上、`ping` 双向 0% 丢包，但**彼此的 UDP 广播都收不到**
// （双方状态行各是「本网段发现 0 台」）；把**同样的公告**改成**单播**打到手机端口 `47821`
// ⇒ 立刻收到并生效 ⇒ 收报逻辑没问题，挡住的是 Android 的 Wi-Fi 广播/组播过滤。
//
// 为什么用**文本级**判据：真机那条路（`jni_handle().exec` ＋ `WifiManager`）在 Windows 上
// 跑不出来，而这类 bug 的形态恰恰是"本机全绿、只有真机才炸"。所以这里钉**结构**：
// 三处必须同时在岗（少任何一处，锁都拿不到 / 拿不到也白拿）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("局域网发现 · Android 广播前置（MulticastLock）", () => {
  const libRs = read("src-tauri/src/lib.rs");
  const lanAndroid = read("src-tauri/src/lan_android.rs");
  const shell = read("scripts/android-mobile-shell.mjs");

  it("① 模块挂在 `target_os = \"android\"` 下，且 setup 里真的调了（窗口建好之后）", () => {
    expect(libRs).toMatch(/#\[cfg\(target_os = "android"\)\]\s*\nmod lan_android;/);
    // ⚠️ 必须在**窗口建好之后**：`exec` 要一个能取 `jni_handle()` 的窗口
    expect(libRs, "setup 里没调 ensure_multicast_lock ⇒ 锁永远拿不到").toContain(
      "lan_android::ensure_multicast_lock(&_window)",
    );
  });

  it("② 真的走进了 `WifiManager.MulticastLock` 那条链（且锁是**一直持有**的）", () => {
    for (const needle of [
      "getSystemService",
      "createMulticastLock",
      '"acquire"',
      "setReferenceCounted",
    ]) {
      expect(lanAndroid, `lan_android.rs 里缺 ${needle}`).toContain(needle);
    }
    // 锁被 GC 回收就等于 release ⇒ 必须存成全局引用
    expect(lanAndroid, "MulticastLock 没有存成全局引用 ⇒ 会被 GC 回收、锁等于没拿").toContain(
      "new_global_ref",
    );
  });

  it("③ manifest 里声明了 `CHANGE_WIFI_MULTICAST_STATE`（否则 `acquire()` 直接抛）", () => {
    expect(shell, "脚本没注入权限 ⇒ 真机上拿锁会失败").toContain(
      "android.permission.CHANGE_WIFI_MULTICAST_STATE",
    );
    // 与另外两条注入同款（都是"找不到才插"）
    expect(shell).toContain("changed = true");
  });
});
