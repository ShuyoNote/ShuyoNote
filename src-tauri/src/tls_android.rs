//! Android 上把 TLS 的信任链交给**系统证书库**（Android 的 `TrustManager`），
//! 而不是 rustls 内置的 webpki 根。
//!
//! ## 为什么必须有这个文件
//!
//! reqwest 0.13 在 Android 上默认用 `rustls-platform-verifier` 做证书校验，而它
//! **不是"自动就绪"的**：进程里第一次用到它时如果没人初始化过，它会**直接 panic**。
//! 2026-09-13 真机 logcat 原话（HUAWEI Mate 40 / Android 12）：
//!
//! ```text
//! E/RustStdoutStderr: Expect rustls-platform-verifier to be initialized
//! ```
//!
//! 这不是"某个功能不好用"，而是**Rust 侧任何 HTTPS 一按就崩**（同步、社区、更新检查…），
//! 且崩在调用线程上——插件那类后台线程崩一次就够让整个功能不可用。
//!
//! ## 为什么初始化要这么绕：库里有**两套 jni**
//!
//! 初始化要交给它三样东西：`JavaVM`、一个 Android `Context`、以及该 Context 的
//! `ClassLoader`。三样都只能从 JNI 拿，而**两份 jni 的版本对不上**：
//!
//! | 谁 | jni 版本 |
//! |---|---|
//! | wry 0.55.1（`jni_handle()` 能拿到 env 与 Activity） | **0.21.1** |
//! | rustls-platform-verifier 0.7.0（`android::init_with_env` 的参数类型） | **0.22.4** |
//!
//! 两版类型**不能互换**——jni 0.22 的 `JavaVM::singleton()` 文档专门警告过：不同版本的
//! jni-rs 不共享任何状态。所以网上流传的那份写法（在 wry 的 `jni_handle().exec(...)`
//! 里直接调 `init_with_env`）在**我们这个版本组合下根本编不过**（tauri#13267 里那条就是）。
//!
//! 这里走的是**裸指针**，而且两边都只用各自版本里**文档化的构造器**，不按结构体布局硬转：
//!
//! 1. `JniHandle::exec` 的闭包给我们 `&mut JNIEnv`(0.21) 与 Android **Activity** 的 `&JObject`；
//! 2. `env.get_java_vm()?.get_java_vm_pointer()` → 裸 `JavaVM*`
//!    （JNI 规范里一个进程只可能有一个 VM，所以这个指针跨版本也指同一个东西）；
//! 3. `unsafe { JavaVM::from_raw(ptr) }`(0.22) 重建一个 0.22 的 `JavaVM`；
//!    `attach_current_thread(..)` 拿 0.22 的 `Env`（当前线程本来就附着着，这一步是廉价空操作）；
//! 4. Activity 的 `as_raw()` → `unsafe { JObject::from_raw(ptr) }`(0.22) 交给 `init_with_env`。
//!
//! 「两套 jni 的边界」被收在 [`install_from_raw`] 一个函数里：它只认裸指针与 jni 0.22，
//! 所以将来 wry 升到 jni 0.22（那时整段桥接都可以删掉）时，改动面就是这一个函数。
//!
//! ## 为什么传 `getApplicationContext()`，不传 Activity 本身
//!
//! 它会把 context 存成**全局引用**（活到进程结束）。存 Activity 就是长期持有 Activity——
//! Android 上典型的泄漏（旋转/重建后旧 Activity 无法回收）。Application 的 Context
//! 本来就和进程同寿，存它没有这个问题。
//!
//! ## 时序：为什么放在"窗口刚建好"那一刻
//!
//! `exec` 是把闭包**投递到主线程**执行的（wry 的 `MainPipe`），所以本函数会立刻返回，
//! 真正的初始化发生在 setup 之后、事件循环刚开始时。这仍然**早于任何 HTTPS 请求**：
//! 消息是在 setup 里排进主线程队列的，而网页要加载、JS 要跑起来才可能触发 Rust 侧的
//! 网络命令（那已经是很多轮主循环之后的事），FIFO 顺序保证我们排在前面。
//! 反过来说：**必须在建好窗口之后立刻调用**，不能挪到用户第一次点同步时再做。

use std::ffi::c_void;

use tauri::{Runtime, WebviewWindow};

/// 把证书校验交给系统证书库。**重复调用无害**（crate 内部是 `get_or_try_init`）。
///
/// 失败**不让应用挂掉**：初始化失败时 Rust 侧 HTTPS 用不了，但笔记、插件、本地功能
/// 都还正常——把原因写进日志（`adb logcat -s RustStdoutStderr`）比崩掉好。
pub fn init<R: Runtime>(window: &WebviewWindow<R>) {
    let res = window.with_webview(|pw| {
        pw.jni_handle().exec(|env, activity, _webview| {
            // Activity 本身也是 Context，但优先取 Application 的（见文件头"为什么"）。
            let context = match env.call_method(
                activity,
                "getApplicationContext",
                "()Landroid/content/Context;",
                &[],
            ) {
                Ok(v) => match v.l() {
                    Ok(obj) if !obj.is_null() => obj,
                    _ => {
                        eprintln!("[tls] getApplicationContext() 返回空，退回复用 Activity 当 Context");
                        activity.clone()
                    }
                },
                Err(e) => {
                    eprintln!("[tls] 调 getApplicationContext() 失败：{e}，退回复用 Activity 当 Context");
                    activity.clone()
                }
            };
            let vm = match env.get_java_vm() {
                Ok(vm) => vm.get_java_vm_pointer(),
                Err(e) => {
                    eprintln!("[tls] 取 JavaVM 失败：{e}（Rust 侧 HTTPS 会 panic）");
                    return;
                }
            };
            // SAFETY: `vm` 与 `context` 都来自本次 JNI 调用——一个是本进程唯一的 JavaVM，
            // 一个是同一线程内有效的局部引用；`install_from_raw` 只在本次调用内用它，
            // 且 `init_with_env` 会立刻把 context 转成它自己的全局引用。
            match unsafe { install_from_raw(vm.cast(), context.as_raw().cast()) } {
                Ok(()) => eprintln!("[tls] 证书校验已交给 Android 系统证书库"),
                Err(e) => eprintln!("[tls] rustls-platform-verifier 初始化失败：{e}（Rust 侧 HTTPS 会 panic）"),
            }
        });
    });
    if let Err(e) = res {
        eprintln!("[tls] 拿不到 WebView 的 JNI 句柄：{e}（Rust 侧 HTTPS 会 panic）");
    }
}

/// 用 jni **0.22** 的 API 完成初始化。只认裸指针，所以这是两套 jni 之间**唯一**的接口面。
///
/// # Safety
///
/// - `raw_vm` 必须是本进程真实 JVM 的 `JavaVM*`（由 jni 0.21 的 `get_java_vm_pointer()` 取得）；
/// - `raw_context` 必须是一个**仍然有效**的 Android `Context` 的局部引用，
///   且调用方所在线程已附着到 JVM（`JNIEnv` 在手就说明附着着）。
unsafe fn install_from_raw(raw_vm: *mut c_void, raw_context: *mut c_void) -> Result<(), String> {
    use jni::objects::JObject;

    let vm = jni::JavaVM::from_raw(raw_vm.cast());
    vm.attach_current_thread(|env| -> Result<(), jni::errors::Error> {
        let context = JObject::from_raw(raw_context.cast());
        rustls_platform_verifier::android::init_with_env(env, context)
    })
    .map_err(|e| e.to_string())
}
