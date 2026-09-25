//! **Android 专属**：让局域网发现能**收到 UDP 广播/组播** —— 拿一把 `WifiManager.MulticastLock`。
//!
//! ## 为什么非要有这一层（真机实测，2026-09-25）
//!
//! 两台手机都在同一个热点上、`ping` 双向 **0% 丢包**，但**彼此的 UDP 广播都收不到**：
//! 双方状态行各是「本网段发现 0 台」。把**同样的公告**改成**单播**打到手机端口 `47821`
//! ⇒ 立刻收到并生效 ⇒ **收报那条路本身是好的**，被挡住的是 Android 的 Wi-Fi 侧：
//! 应用**不持有** `MulticastLock` 时，Wi-Fi 栈会把入站的广播/组播帧**过滤掉**
//! （省电路径的既有行为；`MulticastLock` 就是为这件事存在的 API）。
//!
//! ⇒ 没有这一层时，"两台安卓靠广播互看"**不成立**；而它在桌面/回环上完全看不出来
//! （回环不经 Wi-Fi 栈）——所以这条只有真机能发现。
//!
//! ## 为什么走 `jni_handle().exec` 这条"发了就算"的路
//!
//! 与 `tls_android.rs` 同一取舍：我们要做的是一句 `acquire()`，**不需要返回值**，
//! 而 `exec` 恰好把闭包投递到主线程执行（`WifiManager` 这类系统服务调用在主线程最稳）。
//! 需要返回值的活才走本地插件（见 `android_fs.rs` 模块头那三档权衡）。
//!
//! ⚠️ **锁要一直持有**：`MulticastLock` 被 GC 回收就等于 `release` ⇒ 所以这里把返回的对象
//! 存成**全局引用**并放进 `OnceLock`（进程生命周期）。`setReferenceCounted(false)` 也是
//! 为了这个：不计数就不会被别的 `release` 顺手拆掉。
//!
//! ⚠️ 失败**不让应用挂掉**：拿不到锁只是"局域网发现可能收不到广播"（与今天的行为一样），
//! 所以一律只写一行日志（`adb logcat -s RustStdoutStderr`）。

use std::sync::OnceLock;

use jni021::objects::{JObject, JValue};
use tauri::{Runtime, WebviewWindow};

/// 拿一次（幂等）。**必须在 WebView 建好之后调**（`exec` 要一个能取 `jni_handle` 的窗口）。
pub fn ensure_multicast_lock<R: Runtime>(window: &WebviewWindow<R>) {
    // 全局引用活到进程结束；`OnceLock` 保证只拿一次。
    static HELD: OnceLock<jni021::objects::GlobalRef> = OnceLock::new();
    if HELD.get().is_some() {
        return;
    }
    // ⚠️ 两层都返回 `Result`（`with_webview` 与 `exec`）—— 都**只记日志**：拿不到锁不该
    // 影响任何别的功能（发现层是加分项）。
    let _ = window.with_webview(|pw| {
        pw.jni_handle().exec(|env, activity, _webview| match acquire_global(env, activity) {
            Ok(g) => {
                let _ = HELD.set(g);
                eprintln!("[lan] 已拿到 MulticastLock（Android 收 UDP 广播/组播的前置）");
            }
            Err(e) => eprintln!(
                "[lan] 拿 MulticastLock 失败：{e} \n       ⇒ 局域网发现可能收不到广播（其余功能不受影响）"
            ),
        });
    });
}

/// 真正的三段调用：`getSystemService("wifi")` → `createMulticastLock(tag)` → `acquire()`，
/// 最后**转成全局引用**再返回。
///
/// ⚠️ 返回 `GlobalRef`（**拥有所有权**）而不是 `JObject<'a>`：`JObject` 的生命周期绑在
/// `&mut JNIEnv` 那次可变借用上，从函数里"逃"出来会撞上 jni 的参数不变性
/// （第一次编译就是这条：报错末尾就是 doc 的 subtyping/variance 那一页）。
/// 全局引用没有这个问题，而且我们本来就要一个能活到进程结束的句柄。
///
/// 抽成独立函数只为了把**错误路径**写全：真机上这条链出错时，只有这行日志能说清卡在哪一步。
fn acquire_global(
    env: &mut jni021::JNIEnv,
    activity: &JObject,
) -> Result<jni021::objects::GlobalRef, String> {
    // Context 用 Application 那一份（活动的那份会在旋转/重建后失效）。
    let ctx = env
        .call_method(activity, "getApplicationContext", "()Landroid/content/Context;", &[])
        .map_err(|e| format!("getApplicationContext 失败：{e}"))?
        .l()
        .map_err(|e| format!("getApplicationContext 返回值不是对象：{e}"))?;
    if ctx.as_raw().is_null() {
        return Err("getApplicationContext 返回空".into());
    }
    // Context.WIFI_SERVICE 的字面量就是 "wifi"（Android 源码里的常量值）。
    let svc = env.new_string("wifi").map_err(|e| format!("造 \"wifi\" 字符串失败：{e}"))?;
    let wm = env
        .call_method(
            &ctx,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[JValue::Object(&svc)],
        )
        .map_err(|e| format!("getSystemService(\"wifi\") 失败：{e}"))?
        .l()
        .map_err(|e| format!("getSystemService 返回值不是对象：{e}"))?;
    if wm.as_raw().is_null() {
        return Err("getSystemService(\"wifi\") 返回空（没有 Wi-Fi 服务？）".into());
    }
    let tag = env.new_string("shuyonote-lan").map_err(|e| format!("造 tag 失败：{e}"))?;
    let lock = env
        .call_method(
            &wm,
            "createMulticastLock",
            "(Ljava/lang/String;)Landroid/net/wifi/WifiManager$MulticastLock;",
            &[JValue::Object(&tag)],
        )
        .map_err(|e| format!("createMulticastLock 失败：{e}"))?
        .l()
        .map_err(|e| format!("createMulticastLock 返回值不是对象：{e}"))?;
    if lock.as_raw().is_null() {
        return Err("createMulticastLock 返回空".into());
    }
    // 不计数：免得将来某次 release 把锁拆了（我们只要"一直持有"）。
    let _ = env.call_method(&lock, "setReferenceCounted", "(Z)V", &[JValue::Bool(0)]);
    env.call_method(&lock, "acquire", "()V", &[])
        .map_err(|e| format!("acquire 失败：{e}"))?;
    env.new_global_ref(&lock).map_err(|e| format!("转全局引用失败：{e}"))
}
