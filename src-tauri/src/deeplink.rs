//! `shuyonote://` 的 **OS 层**（Windows 侧交付通道协议）。
//!
//! ## 这一层负责什么、不负责什么（分工是硬边界，不是风格）
//!
//! **负责**：把操作系统交过来的那条 URL **原样**送到前端；已有实例时把 URL 转给已运行的实例。
//! **不负责**：判定它是 `page` / `save` / `import` / `compose` 里的哪一种、参数合不合法、
//! 为什么非法。那些在 `src/lib/deepLink.ts`（前端纯函数）里做，就在一处做。
//!
//! 所以这里**一个字都不解析、不解码、不校验**——理由有两条，都不是洁癖：
//!
//! 1. **双重解码会把中文标题变成乱码**，而它看起来像"参数丢了"，极难倒查；
//! 2. 解析失败必须**说出原因**（社区方案里的硬要求：不允许静默失败）。OS 层如果自己
//!    先判一遍"合不合法"，失败原因就产生在两个地方，用户看到的那句话跟真实原因对不上。
//!
//! ## 为什么要有"待取队列"，而不只是事件
//!
//! Windows 上被唤起有两条路径，前端收到它们的**时机不一样**：
//!
//! - **应用没开**：系统起一个进程，URL 在 `deep-link` 插件 setup 阶段就被读走并 emit。
//!   而主窗口是**先隐藏**（`visible(false)`，等页面 load 完再 show，避免 WebView2 白屏），
//!   前端注册监听时那条事件**早就过去了** —— 只听事件会稳定丢掉"冷启动深链"。
//! - **应用已开**：第二个进程的 argv 经 `single-instance` 转到本进程，事件在前端已经
//!   监听着的时刻到达，这一条靠事件就够了。
//! - **Android 上这两条都换成 intent**（对照表见 [`attach`] 的文档）：冷启动那次 URL 在
//!   Kotlin `load()` 里 `channel` 还没建立，只留在 `currentUrl`；应用已开着时 `onNewIntent`
//!   才经 `channel` 送过来。**变的是"谁把 URL 送进来"，不变的是 Rust 侧的入口 API**，
//!   所以下面这套"先入队再 emit"一个字都不用改就同时覆盖手机。
//!
//! 两条都覆盖、又不重复投递的做法就是：**URL 一律先入队再 emit**，
//! 前端"启动时 drain 一次 + 之后听事件"，两边取到的是同一个队列，自然去重（不是靠前端猜）。
//!
//! ## 只放行 `shuyonote:`
//!
//! 过滤**不在**这里做：`tauri-plugin-deep-link` 自己按
//! `tauri.conf.json > plugins > deep-link > desktop > schemes` 比对，没命中的参数它直接跳过。
//! 这里再判一次只会让"两边各有一套白名单"——将来配置改了只改一处、另一处变成静默丢弃。

use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
// `DeepLinkExt` 提供 `app.deep_link()`。**它和 `on_open_url` 都不是桌面专属的**
// （插件 src/lib.rs 的 L481 / L511，都在 `#[cfg]` 之外；Android 那份 `DeepLink`
// 在 `mod imp` 里另有一份 `get_current`，走 `run_mobile_plugin("getCurrent")`），
// 所以这个 import 不再按平台收口——收口过的那一版正好让手机彻底收不到深链。
use tauri_plugin_deep_link::DeepLinkExt;

/// 前端监听的事件名。**前后端各写一遍字符串是最容易悄悄对不上的地方**
/// （对不上的表现就是"什么都没发生"），所以前端那份从这里对：见
/// `src/lib/platform/commands.ts` 的 `DEEP_LINK_EVENT`，两边有门禁脚本比对。
pub const EVENT_NEW_URL: &str = "deep-link-new-url";

/// 待取队列：已入队但前端还没取走的 URL（先进先出，取走即清）。
#[derive(Default)]
pub struct PendingDeepLinks(Mutex<Vec<String>>);

impl PendingDeepLinks {
    /// 入队并返回是否有内容（调用方负责 emit）。
    fn push(&self, url: String) {
        if let Ok(mut q) = self.0.lock() {
            q.push(url);
        }
    }

    /// 取走**全部**待处理 URL。
    ///
    /// 为什么是"全部"而不是"一条"：一次冷启动理论上只可能有一条，但把队列一次清干净
    /// 能保证**取过之后队列为空**——否则同一条 URL 会在下一次 drain 时被重复投递，
    /// 而重复投递在 `save` 语义下表现为"又问一遍要不要存"，用户看到的是"怎么又弹了"。
    /// 返回空数组表示"这段时间没有深链"，调用方据此**什么都不做**（幂等）。
    fn drain(&self) -> Vec<String> {
        match self.0.lock() {
            Ok(mut q) => std::mem::take(&mut *q),
            // 锁中毒（别的线程 panic 过）：这里**不 panic**。理由：深链不是关键路径，
            // 为了它让整个启动流程挂掉，比丢一条链接严重得多。
            Err(_) => Vec::new(),
        }
    }

    /// 看一眼队列（不清空）。**只给测试用**，运行时不需要"先看再拿"。
    #[cfg(test)]
    fn peek(&self) -> Vec<String> {
        self.0.lock().map(|q| q.clone()).unwrap_or_default()
    }
}

/// 在 builder 上注册 deep-link 插件。
///
/// ## 为什么必须是插件的 `init()`，不能自己 `Builder::new("deep-link")`
///
/// 我第一版写成裸 `Builder`（想让 manage 与接线挨在一起），结果**装完之后应用起不来**：
///
/// ```text
/// panicked at src\lib.rs:507:10:
/// error while running tauri application: PluginInitialization("deep-link",
///   "Error deserializing 'plugins.deep-link' within your Tauri configuration:
///    invalid type: map, expected unit")
/// ```
///
/// 原因：插件的 `init()` 返回的是 `TauriPlugin<R, Option<Config>>`，而裸 `Builder::new()`
/// 的泛型默认是 `()`（unit）。于是 `tauri.conf.json` 里那段 `plugins.deep-link` 配置
/// 会被当成 unit 反序列化 → map 对 unit → **启动即 panic（退出码 101）**。
///
/// 而这个 `Config` **没有被插件公开导出**（`mod config` 私有），所以想显式写类型也写不出来
/// ——返回类型只能写 `impl Plugin<R>`，把具体类型留给编译器推断（推断出来的仍是
/// `Option<Config>`，所以 `plugins.deep-link` 那份配置照样被正确反序列化）。
/// 结论：只能用它给的 `init()`，接线放到外面的 setup 里——见 [`attach`]。
/// 代价是"注册"与"接线"成了两个调用；本文件顶部的注释与 `scripts/check-deep-link.mjs`
/// 一起守住它们不被拆散。
///
/// **必须在建窗口之前注册**：它的 setup 会读 `std::env::args()` 处理"冷启动就是被深链唤起"
/// 的那一次，而主窗口是先隐藏、页面 load 完才 show 的。
///
/// **移动端也走这个函数**，不要在别处再写一遍 `tauri_plugin_deep_link::init()`：
/// Android 上它注册的是 Kotlin 侧的 `DeepLinkPlugin`（`android/` 模块由 tauri-cli 扫
/// `Cargo.toml` 自动加进 gradle），intent 再经 `setEventHandler` 的 channel 转回 Rust。
/// 注册与接线分成两个调用是插件的类型逼出来的（`Config` 没公开导出），不是平台差异。
pub fn plugin<R: Runtime>() -> impl tauri::plugin::Plugin<R> {
    tauri_plugin_deep_link::init()
}

/// 接上 deep-link 插件：建队列、补收"冷启动那一次"、再订阅后续的 URL。
///
/// **必须在 [`plugin`] 注册之后调用**（本函数要读插件的托管状态）。
///
/// ## 这里的顺序不是风格问题，是补一个真实的洞
///
/// 插件的 `setup`（注册时跑）就会读冷启动 argv 并 **emit 一次事件**——那一刻**我们还没订阅**
/// （本函数在更外层的 setup 里才跑）。只听事件的话，**冷启动那条 URL 会稳定丢掉**，
/// 而"应用已经开着再点一次"那条却正常——于是问题看起来像"第一次点没反应"。
///
/// 所以这里**先补收**（`get_current()` 拿插件已经解析好的那一条）**再订阅**：
///
/// | 情形 | 谁负责送到前端 |
/// |---|---|
/// | 冷启动被唤起 | `get_current()`（本函数开头） |
/// | 应用已开着时被唤起 | `on_open_url`（本函数末尾） |
/// | 前端挂载得比上面都晚 | 队列 drain（[`deep_link_take`] 命令） |
///
/// 三条汇入同一个 [`handle_urls`]，所以不会重复投递：入队与 emit 是同一个动作的两半。
///
/// ## 桌面与移动端共用这一份接线（不是"顺手兼容"）
///
/// 这里原本整段 `#[cfg(desktop)]`，注释理由是"移动端 `DeepLink` 是另一套 API（没有
/// `on_open_url`）"。**那句是错的**，代价实测过：Android 上插件把事件 emit 出来却没人接，
/// 表现就是"点深链完全没反应"（`adb shell am start -a android.intent.action.VIEW -d
/// shuyonote://test/...` 打进来，logcat 能看到 `NewIntentItem` 已交给 Activity，界面纹丝不动）。
///
/// 查 `tauri-plugin-deep-link-2.4.10/src/lib.rs` 得到的是结构性理由，不是试出来的：
/// `DeepLinkExt`（L481）与 `on_open_url`（L511）都在 `#[cfg]` 之外；Android 那份
/// `DeepLink`（`mod imp`，L87 起）**自己就有 `get_current`**（L121 走 `run_mobile_plugin`，
/// 读 Kotlin 的 `currentUrl`）。真正桌面专属的只有 `handle_cli_arguments`（L195）——
/// 那是"从 argv 里读"，手机本来就没有 argv。
///
/// 两平台**谁把 URL 送进来**不同，但**送进来的接口相同**：
///
/// | | 冷启动那一次 | 应用已开着时 |
/// |---|---|---|
/// | 桌面 | 插件 setup 读 `argv` → `get_current()` | `on_open_url`（second-instance 转发 argv） |
/// | Android | Kotlin `load()` 存进 `currentUrl` → `get_current()` | `on_open_url`（`onNewIntent` → channel） |
///
/// 注意 Android 的 `load()`（`DeepLinkPlugin.kt` L78-89）：那时 `setEventHandler` 还没跑，
/// `this.channel?.send(...)` 是**空操作**，URL 只落到 `currentUrl` 上——所以冷启动在
/// Android 上是**同一个洞**，`get_current()` 补收这段代码一行不改地正好补上。
pub fn attach<R: Runtime>(app: &AppHandle<R>) {
    app.manage(PendingDeepLinks::default());

    // 1) 补收冷启动那一次（插件已按 scheme 过滤过：这里只会拿到 shuyonote://）。
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        handle_urls(app, urls.iter().map(|u| u.to_string()).collect());
    }

    // 2) 订阅后续的（"应用已开着"那条路径）。用插件的公开 `on_open_url`，
    //    而不是自己监听 `"deep-link://new-url"` 字符串——跟着公开 API 走。
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        handle_urls(&handle, event.urls().iter().map(|u| u.to_string()).collect());
    });
}

/// 一条或多条 URL 到达时的**唯一**处理路径：先入队，再 emit。
///
/// 三条唤起路径都收敛到这里，所以"队列里有、事件也发过"不需要每处各记一遍。
fn handle_urls<R: Runtime>(app: &AppHandle<R>, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<PendingDeepLinks>() {
        for u in &urls {
            state.push(u.clone());
        }
    }
    // 事件也照发（"应用已经开着"那条路径的正常通道，前端此时在听）。
    // 发失败**不致命**：队列还在，前端的启动 drain 仍能取到。
    emit(app, &urls);
}

/// 发事件给前端。
pub fn emit<R: Runtime>(app: &AppHandle<R>, urls: &[String]) {
    use tauri::Emitter;
    let _ = app.emit(EVENT_NEW_URL, urls);
}

/// 前端启动时 drain 一次。
///
/// **没有待处理深链时返回空数组**，前端据此不做任何事——这就是"普通启动零副作用"
/// 的实现位置：队列空 ⇒ 不弹任何东西。
#[tauri::command]
pub fn deep_link_take(state: tauri::State<'_, PendingDeepLinks>) -> Vec<String> {
    state.drain()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 普通启动（没有深链）：队列空 ⇒ 前端拿到空数组 ⇒ 什么都不做。
    /// 这条是"零副作用"的可执行定义——不是"应该不会弹"，是 drain 出来就是空的。
    #[test]
    fn empty_queue_yields_nothing() {
        let q = PendingDeepLinks::default();
        assert!(q.drain().is_empty());
        assert!(q.peek().is_empty());
    }

    /// **一次冷启动只处理一次**（本文件里最容易写错的不变式）。
    ///
    /// `handle_urls` 是"入队 + emit"两件事，而前端也有两条路拿 URL（事件 / 启动 drain）。
    /// 所以同一条 URL 在 Rust 侧只该躺在队列里**一份**，且**取走即空**：
    /// 否则第二次 drain 会把旧链接再投一次，用户看到的是"怎么又问一遍要不要存"。
    #[test]
    fn drain_empties_the_queue_so_a_url_is_never_delivered_twice() {
        let q = PendingDeepLinks::default();
        q.push("shuyonote://save?url=https%3A%2F%2Fcommunity.shuyo.cn%2Fpost%2F1".into());

        let first = q.drain();
        assert_eq!(first.len(), 1);
        assert!(first[0].starts_with("shuyonote://save"));

        // 关键断言：第二次必须是空的。
        assert!(q.drain().is_empty(), "取过之后队列必须为空，否则前端会收到重复投递");
    }

    /// 先进先出 + 一条都不丢：冷启动那条与"已开着时"那条都进同一个队列。
    #[test]
    fn multiple_urls_come_out_in_arrival_order() {
        let q = PendingDeepLinks::default();
        q.push("shuyonote://first".into());
        q.push("shuyonote://second".into());
        assert_eq!(q.peek(), vec!["shuyonote://first", "shuyonote://second"]);
        assert_eq!(
            q.drain(),
            vec!["shuyonote://first", "shuyonote://second"],
            "顺序即到达顺序：页面 id 那类语义对顺序敏感时不至于被悄悄重排"
        );
        assert!(q.drain().is_empty());
    }
}
