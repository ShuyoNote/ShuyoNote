//! **Android 专属**：自建一个本地 Tauri 插件，用来问系统「这个 `content://` URI
//! 叫什么名字、是什么类型」。
//!
//! ## 为什么非走 Kotlin 不可（一手证据）
//!
//! 选择器返回的 URI 到 Rust 手上时是**光秃秃一个字符串**：
//! `tauri-plugin-dialog 2.7.3` 的 `android/.../DialogPlugin.kt::createPickFilesResult`
//! 只做 `uris.add(uri.toString())` —— 没有 display name、没有 mime（读源码确认）。
//! 同一个包里的 `FilePickerUtils` 里明明有能做到的那两个函数
//! （`getNameFromUri` → `ContentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME))`、
//! `getMimeTypeFromUri` → `ContentResolver.getType(uri)`），但它们在这条路上**零调用点**
//! （全仓 grep：`getNameFromUri` 只有定义没有调用）。
//!
//! 而 URI 尾段也**不足以**当名字：`…/document/primary%3ADownload%2Fphoto.png` 能解出
//! `photo.png`，但 MediaStore/Downloads 给的是 `image%3A1234`、`msf%3A1000000042`
//! ——**那是 id，不是名字**。所以要"原始文件名"，唯一可靠来源就是 `ContentResolver`：
//! **只有 Android 运行时知道**，Rust 侧无论怎么解析字符串都拿不到。
//!
//! ## 为什么用「本地插件」而不是自己发 JNI 调用
//!
//! 我们已经有两套先例，权衡如下：
//!
//! - `tls_android.rs` 那种**裸 JNI**（`jni_handle().exec` + jni 0.22）：`exec` 是把闭包
//!   **投递到主线程**执行的（wry 的 `MainPipe`），**拿不回返回值** —— 初始化那种"发了就算"
//!   的活可以，这里要取值就不行。
//! - `webView.addJavascriptInterface` + 前端调用：能拿到值，但要多一条**前端↔壳**的桥，
//!   并且要把名字当成 IPC 参数从页面传回 Rust —— 多一条数据通路就多一处会漂的地方。
//! - **本地 Tauri 插件**（本文件）：`tauri` 官方的移动端扩展点就是它。Rust 侧
//!   `api.register_android_plugin(...)`（`tauri-2.11.5/src/plugin/mobile.rs:206`）会用反射
//!   构造 Kotlin 类、调 `PluginManager.load(...)`，之后 `PluginHandle::run_mobile_plugin`
//!   就是**同步的 Rust→Kotlin 调用**。`tauri-plugin-fs` / `-opener` / `-dialog` 全走这条路
//!   （我们本来就依赖 fs 插件，`picked_file` 正是靠它的 `Fs::open` 才能打开 URI）——
//!   所以这不是新机制，是**跟着官方插件抄**。前端一行都不用改。
//!
//! ## 线程：`run_mobile_plugin` 会阻塞，调用点不能在主线程
//!
//! 它内部是「投递到主线程 + `rx.recv()` 等回来」（`mobile.rs:504-508` + wry
//! `MainPipe::send`）。**在 Android 上这不是问题**：Tauri 的 IPC 走
//! `WebViewClient.shouldInterceptRequest` 那条路，是 WebView 的**非 UI 线程**回调，
//! 所以同步命令（`import_attachment_files`）本来就不在主线程上跑。这一点有**真机实证**：
//! 同一条路上的 `fs::open` → `run_mobile_plugin("getFileDescriptor")` 早就在真机上跑通了
//! （附件确实导进去了，只是名字/mime 丢了）。所以这里**沿用现有线程模型，不做改动**。
//!
//! ## 失败一律退化成 `None`
//!
//! 拿不到名字**不是错误**：附件照样要导进来。所有失败都只写一行日志，返回 `None`，
//! 由 `picked_file` 回退到 URI 尾段启发 / 内容嗅探 / 今天的原行为。

use tauri::Manager;

/// 插件名（Rust 侧标识，Kotlin 那边由 `PluginManager.load` 用这个名字登记）。
const PLUGIN_NAME: &str = "shuyo-fs";
/// Kotlin 类的包名（`register_android_plugin` 会把 `.` 换成 `/` 再 FindClass）。
const PLUGIN_IDENTIFIER: &str = "cn.shuyo.shuyonote";
/// Kotlin 类名。**必须与 `scripts/android-mobile-shell.mjs` 写进 `gen/`
/// 的那个类同名**，而且必须被 `.pro` 规则 keep 住（R8 开着；漏了就是
/// 「debug 绿、release 真机上 ClassNotFoundException」）。
const PLUGIN_CLASS: &str = "ShuyoFsPlugin";

/// Kotlin 那边 `pickedFileInfo` 命令的返回。
#[derive(Debug, Default, Clone, serde::Deserialize)]
pub(crate) struct PickedFileInfo {
    /// `OpenableColumns.DISPLAY_NAME`（provider 答不上来时是空串）。
    #[serde(default)]
    pub name: String,
    /// `ContentResolver.getType(uri)`（答不上来时是空串）。
    #[serde(default)]
    pub mime: String,
}

#[derive(serde::Serialize)]
struct PickedFileInfoPayload<'a> {
    uri: &'a str,
}

/// 挂在 `app.manage` 上的插件句柄（与 `tauri-plugin-opener` 同一个做法）。
pub(crate) struct ShuyoFs(tauri::plugin::PluginHandle<tauri::Wry>);

/// 注册这个插件。`lib.rs` 在 Android 上把它加进 builder。
///
/// 配置类型故意用 `serde_json::Value`（而不是 `()`）：`tauri.conf.json` 里没有这个插件的
/// 配置项时，`PluginApi::config()` 拿到的是 `null`；`Value` 对任何 JSON 都能反序列化成功，
/// 于是"配置缺失"永远不会变成"启动就报错"。
pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry, serde_json::Value> {
    tauri::plugin::Builder::<tauri::Wry, serde_json::Value>::new(PLUGIN_NAME)
        .setup(|app, api| {
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, PLUGIN_CLASS)?;
            app.manage(ShuyoFs(handle));
            Ok(())
        })
        .build()
}

/// 问一次系统。**任何失败都返回 `None`**（见模块头注释）。
pub(crate) fn picked_file_info(app: &tauri::AppHandle, uri: &str) -> Option<PickedFileInfo> {
    let fs = app.try_state::<ShuyoFs>()?;
    match fs
        .0
        .run_mobile_plugin::<PickedFileInfo>("pickedFileInfo", PickedFileInfoPayload { uri })
    {
        Ok(info) => Some(info),
        Err(e) => {
            // 只记一行：这条失败**不该**让导入失败，也不该刷屏。
            eprintln!("[picked] 问系统「这个文件叫什么 / 是什么类型」失败：{e}");
            None
        }
    }
}

#[derive(serde::Serialize)]
struct InstallApkPayload<'a> {
    path: &'a str,
}

/// 把下好的 APK 交给**系统安装器**（应用内更新的第二步，见 `updates.rs`）。
///
/// 与 `picked_file_info` 的**失败语义相反**：这条失败**必须**让用户知道
/// —— 静默什么都不发生的话，用户会以为"点了没反应"，而其实只是缺个权限。
/// Kotlin 侧实现在 `ShuyoFsPlugin.installApk`（FileProvider + ACTION_VIEW）。
pub(crate) fn install_apk(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let fs = app
        .try_state::<ShuyoFs>()
        .ok_or_else(|| "Android 壳插件没注册（应用内安装不可用）".to_string())?;
    fs.0.run_mobile_plugin::<serde_json::Value>("installApk", InstallApkPayload { path })
        .map(|_| ())
        .map_err(|e| format!("拉起系统安装器失败：{e}"))
}
