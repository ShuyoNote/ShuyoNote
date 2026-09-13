mod ai;
mod community;
mod attachments;
mod backlinks;
mod backup;
mod blocks;
mod bookmark;
mod commands;
mod crypto;
mod database;
mod db;
// 交付通道协议 `shuyonote://` 的 **OS 层**。模块本身是跨平台编译的（队列与取件命令在
// 移动端也注册着，只是永远为空）；真正桌面专属的是 `plugin()` / `attach()`，
// 因为 `deep-link` 插件的移动实现是另一套 API（`on_open_url` 在移动端不存在）。
mod deeplink;
// 聚合邮箱（含发信）：**桌面专属**（2026-09-13 定）。它走 `native-tls`，而移动端为此要从
// 源码交叉编译 OpenSSL；移动端本就不提供该功能（`EmailPanel` 里早就写着"桌面版独有能力"），
// 所以模块连同依赖一起收窄到桌面。前端侧用 `emailSupported()` 判断，不要用
// `isDesktopPlatform()` —— 后者在同步/插件/加密处表示"有没有 Rust 内核"，移动端是要有的。
#[cfg(desktop)]
mod email;
#[cfg(desktop)]
mod smtp;
mod graph;
mod models;
mod capabilities_gen;
mod pdf_native;
// 「用户选的文件」的唯一落地入口：Android 的选择器返回 `content://` URI 而不是文件路径，
// `std::fs` 打不开它——这一层负责把它拷成临时真实路径（详情见模块头注释）。
mod picked_file;
mod plugin_budget;
pub mod plugin_host;
mod plugin_index;
mod plugin_validate;
mod plugins;
mod properties;
mod search;
mod security;
mod storage;
mod sync;
mod tags;
mod templates;
mod titlebar;
mod trash;
mod updates;
mod versions;
mod windows;
mod workspace_io;
mod workspaces;

use db::Db;
use std::borrow::Cow;
use std::sync::Mutex;
use tauri::http::header::CACHE_CONTROL;
use tauri::webview::PageLoadEvent;
use tauri::{utils::config::Color, Manager, WebviewUrl, WebviewWindowBuilder};

/// Apply cache headers to the Tauri-served web resources so that a version
/// upgrade does not leave the WebView serving a stale `index.html` from cache.
///
/// - The app shell (`index.html`, manifest, root) gets `no-cache`, so the next
///   launch re-validates and pulls the freshly embedded shell after an update.
/// - Content-hashed assets under `/assets/` stay immutable+long-lived (they are
///   content-addressed, so a stale hash can never point at wrong content).
fn with_cache_headers(
    request: tauri::http::Request<Vec<u8>>,
    response: &mut tauri::http::Response<Cow<'static, [u8]>>,
) {
    let path = request.uri().path().to_string();
    let value = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    if let Ok(header_value) = value.parse() {
        response.headers_mut().insert(CACHE_CONTROL, header_value);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // M11.13 阶段 1：**宿主子进程分流必须在最前面**——在任何 Tauri / 单实例初始化之前。
    // 放在后面会出两个真实后果（见方案 §7）：macOS 上多一个 Dock 图标；single-instance
    // 插件把子进程当成"第二个实例"，于是用户开第二个窗口时被"唤起已有窗口"。
    //
    // 子进程是**纯解释器**：不碰数据库、不拿解密密钥、没有路径，只跑插件 JS 并把结果
    // 回给父进程（能力调用在阶段 1 是假应答，阶段 2 起改成 RPC 回父进程）。
    if std::env::args().any(|a| a == plugin_host::HOST_FLAG) {
        std::process::exit(plugin_host::serve_stdio());
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        // fs 插件：**不是为了给前端开文件 API**（capabilities 里没授它任何权限，前端调不动），
        // 而是为了 `picked_file` 能在 Android 上用它的 `Fs::open`——那一条经 Kotlin 的
        // `ContentResolver` 取 fd，能打开选择器给的 `content://` URI。桌面侧它的 `open`
        // 就是 `std::fs::OpenOptions`，等价，不受影响。
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());

    // **深链在移动端也要注册**（桌面那份在下面的 `#[cfg(desktop)]` 块里，顺序有讲究）。
    // Android 上系统把 `shuyonote://…` 作为 intent 交给 Activity，插件的移动实现读走它并 emit
    // **同名事件** `deep-link://new-url` —— 前端的 `mountDeepLinks` 听的正是这个事件，
    // 所以语义分派（`page` / `save` / `test/…`）**两条路共用一套**，不需要各写一遍。
    // 桌面多出来的那层"冷启动 argv → 队列 → drain"（见 `deeplink.rs`）在移动端没有对应物：
    // 那边冷启动的 intent 由插件的移动实现自己处理。
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    // 桌面专属插件：移动端（Android/iOS）不适用，仅在桌面注册。
    // - deep-link：交付通道 `shuyonote://`。**只做 OS 层**（注册 scheme / 被唤起 /
    //   已有实例转发 / 把整条 URL 原样交给前端），语义解析在前端 src/lib/deepLink.ts。
    //   scheme 名单在 tauri.conf.json > plugins > deep-link > desktop > schemes，
    //   打包时 tauri-cli 会把它映射给 bundler，由 NSIS 模板写注册表（见 docs）。
    // - single-instance：只为 windows/macos/linux 实现（移动系统本身保证单实例），
    //   移动端引用其 `init` 会编译报 `cannot find function init`。
    // - updater：依赖桌面更新机制（移动端走应用商店更新）。
    #[cfg(desktop)]
    let builder = {
        // ⚠️ **`deep-link` feature 必须开**（见 Cargo.toml）。Windows 上系统唤起深链的
        // 方式是"起一个新进程、URL 作为唯一命令行参数"；没有这个 feature，回调里
        // **不会**把 argv 喂给 deep-link 插件，那条 URL 就被丢掉——而窗口照样会被还原，
        // 于是表现成"应用醒了，但什么也没发生"（最难查的那种：看起来像解析失败）。
        // 开了之后顺序是：插件先 `handle_cli_arguments` ⇒ 入队 + emit，然后才是
        // 「还原窗口 + 抢焦点」。
        let single_instance = tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // `_args` 不用自己解析：`deep-link` feature 已经把 URL 送进 deeplink
            // 模块的队列并 emit 出去了，这里只负责让用户**看见**窗口。
            //
            // 唤起已有实例到前台：先还原最小化窗口，再抢焦点。否则二次启动时最小化的
            // 实例只是被 set_focus，不会取消最小化/前置，用户以为没响应用户。
            fn raise(w: tauri::WebviewWindow) {
                let _ = w.unminimize(); // 最小化 → 还原
                let _ = w.show();       // 确保显示（可能在托盘/隐藏）
                let _ = w.set_focus();  // 抢焦点到前台
            }
            if let Some(w) = app.get_webview_window("main") {
                raise(w);
            }
        });
        let updater = tauri_plugin_updater::Builder::new().build();

        // 单实例：禁止多开。ShuyoNote 是本地优先单库（meta.db 一个 device_id /
        // token / auth_sessions），多实例会互相覆盖 token、device 绑定冲突（同机多实例
        // 各自登录 = 之前 zhaizy/cnzen001 那类 403）。第二个实例启动时唤起第一个。
        //
        // ## 与 deep-link 的注册先后：**与成败无关**
        //
        // 上一轮我怀疑"谁先注册"会决定"应用已开着时再点链接有没有反应"。查代码后否掉了，
        // 理由是一条**结构性**的、不是靠试出来的：
        //
        // - 所有插件的 `setup` 都在 `App::run()` 内、**窗口与事件循环起来之前**按序同步执行
        //   （tauri 的 plugin 初始化路径），所以等任何 WM_COPYDATA 回调可能发生时，
        //   两个插件的托管状态都已建好；
        // - `single-instance` 的 `deep-link` feature 是在**回调执行时**才
        //   `app.try_state::<DeepLink<R>>()` 取插件的 —— 运行时查状态，不是注册时绑定。
        // - 因此顺序不进入这条因果链。**真正会让第二次点击静默失效的是不开那个 feature**
        //   （见 Cargo.toml）：回调照跑、窗口照样还原，只有 URL 没了。
        //
        // 真机三步跑的是**下面这个默认顺序**（deep-link 先）。留着这个常量是为了
        // "需要时能一行切到另一种顺序再验一遍"，**不是**因为顺序可疑。
        const DEEP_LINK_REGISTERED_FIRST: bool = true;
        let builder = builder.plugin(updater);
        if DEEP_LINK_REGISTERED_FIRST {
            builder.plugin(deeplink::plugin()).plugin(single_instance)
        } else {
            builder.plugin(single_instance).plugin(deeplink::plugin())
        }
    };

    builder
        // E1 attachment at-rest decryption-on-serve: `convertFileSrc(path, "attachment")`
        // produces a platform-correct `attachment://`/`http://attachment.localhost` URL;
        // this handler percent-decodes the target path, validates it is under the app's
        // attachments dir, reads the (possibly session-key encrypted) bytes and returns
        // them decrypted — so the WebView renders plaintext WITHOUT writing it to disk.
        .register_uri_scheme_protocol("attachment", |ctx, request| {
            use percent_encoding::percent_decode;
            use std::path::{Component, Path};
            use tauri::http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE};
            let raw_path = request.uri().path().as_bytes();
            let decoded = percent_decode(if raw_path.len() > 1 { &raw_path[1..] } else { raw_path })
                .decode_utf8_lossy()
                .into_owned();
            let app = ctx.app_handle();
            let data_dir = app.path().app_data_dir().ok();
            let attachments_dir = data_dir.map(|d| d.join("attachments"));
            // Validate the target is inside the attachments dir. A lexical
            // `starts_with` is NOT a boundary (it doesn't normalize `..`), so:
            // 1) reject any `..` path component outright, and
            // 2) canonicalize both sides and compare the resolved paths.
            let ok = attachments_dir
                .as_ref()
                .and_then(|ad| ad.canonicalize().ok())
                .and_then(|canon_ad| {
                    let p = Path::new(&decoded);
                    if p.components().any(|c| matches!(c, Component::ParentDir)) {
                        return None;
                    }
                    let canon = p.canonicalize().ok()?;
                    canon.starts_with(&canon_ad).then_some(())
                })
                .is_some();
            if !ok {
                return tauri::http::Response::builder()
                    .status(403)
                    .body(Cow::Owned(Vec::new()))
                    .unwrap();
            }
            let raw = std::fs::read(&decoded).unwrap_or_default();
            let key = {
                let db = app.state::<Db>();
                let c = db.0.lock().expect("db mutex poisoned");
                security::key_if_enabled(&c)
            };
            let out = security::decrypt_attachment_bytes(key.as_ref(), &raw).unwrap_or(raw.clone());
            let ext = Path::new(&decoded)
                .extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_else(|| "bin".to_string());
            let mime = match ext.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "svg" => "image/svg+xml",
                "pdf" => "application/pdf",
                _ => "application/octet-stream",
            };
            // The app shell (http://tauri.localhost in prod / localhost:1420 in dev)
            // fetches these URLs cross-origin. Without ACAO the browser blocks the
            // response and the PDF/image fails to load. Echo the caller's origin if
            // it is one of our app origins (attachment URLs are content-addressed and
            // unguessable, so we do NOT use `*`).
            let origin = request
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let allow_origin = match origin.as_deref() {
                Some(o)
                    if o.starts_with("http://tauri.localhost")
                        || o.starts_with("http://127.0.0.1")
                        || o.starts_with("http://localhost") =>
                {
                    o
                }
                _ => "http://tauri.localhost",
            };
            tauri::http::Response::builder()
                .header(CONTENT_TYPE, mime)
                .header(ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin)
                .body(Cow::Owned(out))
                .unwrap()
        })
        .setup(|app| {
            // 深链接线：建队列 → 补收冷启动那一次 → 订阅后续。
            //
            // 必须放在**本 setup 的最前面**，而且不能挪进 `deeplink::plugin()`：
            // 插件的 `init()` 返回 `TauriPlugin<R, Option<Config>>`，而那个 `Config`
            // 没有公开导出，所以没法自己用 `Builder` 复刻它的 setup（试过，见
            // deeplink.rs 里那段 panic 记录）。放在这里还能顺带保证：下面任何一句
            // 提前 return，都不会让深链处于"注册了但没人接"的半截状态。
            #[cfg(desktop)]
            deeplink::attach(&app.handle());

            let app_data_dir = app.path().app_data_dir()?;
            let conn = db::init(app_data_dir).map_err(|e| {
                eprintln!("failed to init db: {e}");
                std::io::Error::other(e.to_string())
            })?;
            // E1: if workspace encryption is enabled, default to the locked state on
            // launch so the passphrase must be re-entered before any encrypted sync.
            security::startup_lock(&conn);
            app.manage(Db(Mutex::new(conn)));
            // 聚合邮箱定时收取：后台轮询未读数并推事件给前端（WebView 最小化时
            // 会节流 JS timer，所以放在 Rust 侧做）。**桌面专属**，见 mod email 的说明。
            #[cfg(desktop)]
            {
                app.manage(email::EmailPollState::default());
                email::start_email_poller(app.handle().clone());
            }
            // Seed a bundled demo plugin so the plugin system has something to load.
            let _ = plugins::ensure_demo_plugin(&app.handle());

            // The main window is built in code so we can attach the resource
            // cache-header hook (config-created windows can't). Its label is
            // "main" to match the `default` capability and the rest of the app.
            let version = app.package_info().version.to_string();
            let url = WebviewUrl::App("index.html".into());
            let main_builder = WebviewWindowBuilder::new(app, "main", url)
                .title(format!("ShuyoNote 数友笔记 · v{version}"))
                .inner_size(1200.0, 800.0);
            // 自绘标题栏（前端 <TitleBar />）。做成无边框而不是保留系统栏，
            // 是为了让顶栏能显示「当前页面 · 空间」并与应用配色连成一体。
            // 用户可在 设置 → 外观 关掉，前端会运行时 setDecorations(true)
            // 恢复系统标题栏——因为 Windows 上无边框要自己接管 Aero Snap
            // 与边缘 resize，万一某台机器手感不对得有退路。
            // 注意：`decorations` 是桌面概念，移动端（Android/iOS）的 builder 无此
            // 方法（窗口装饰由系统管理），故按平台条件编译——与下面 drag_and_drop 同款写法。
            #[cfg(desktop)]
            let main_builder = main_builder.decorations(false);
            // 关键：Windows 上内置 drag-drop handler 开着时，HTML5 拖拽
            // API 不可用——data-tauri-drag-region 正是依赖它拖窗口，所以
            // 标题栏拖不动。这里关掉，让标题栏可拖；文件视图需要 OS 拖文件
            // 时前端临时开（见 titlebar::set_drag_drop_enabled）。
            // 注意：drag_and_drop 是 Windows/WebView2 专用 API，Linux/mac 的
            // builder 无此方法，故按平台条件编译。
            #[cfg(target_os = "windows")]
            let main_builder = main_builder.drag_and_drop(false);
            let _window = main_builder
                // 关键注释：Windows 上 dragDropEnabled 默认 true，此时
                // data-tauri-drag-region 不生效（标题栏拖不动）。这里显式关掉，
                // 文件视图挂载时前端临时打开（api.setDragDropEnabled(true)）。
                // 关键：Windows 上必须 dragDropEnabled=false，data-tauri-drag-region
                // 才生效（否则标题栏/PDF 头部都拖不动窗口——默认值 true 时 WebView
                // 把鼠标当文件拖入处理）。代价是 OS 文件拖入上传失效，因此文件视图
                // 挂载时会临时 setDragDropEnabled(true)，离开时再关（见 api.ts
                // setDragDropEnabled）。
                // Start hidden + brand-dark background: WebView2 cold-start shows a
                // white window before the HTML/SW/splash paints. We tint the
                // window to the splash's dark background and only reveal it once
                // the page has finished loading, so there's no white flash.
                .background_color(Color(11, 21, 51, 255))
                .visible(false)
                .on_page_load(|window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        let _ = window.show();
                    }
                })
                .on_web_resource_request(with_cache_headers)
                // 开启调试控制台：正式版也能 Ctrl+Shift+I / F12 打开 WebView2
                // devtools，看 console 报错（排查 mermaid 等问题）。
                .devtools(true)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_pages,
            commands::list_workspace_pages,
            workspaces::list_workspaces,
            workspaces::create_workspace,
            workspaces::get_active_workspace_id,
            workspaces::set_active_workspace_id,
            workspaces::copy_page_to_workspace,
            workspaces::delete_workspace,
            workspaces::get_workspace_name,
            workspaces::rename_workspace,
            workspaces::set_workspace_settings,
            commands::get_page,
            commands::create_page,
            commands::create_folder,
            // 聚合邮箱命令：**桌面专属**（与 mod email 同一条边界）。移动端这些命令**不存在**，
            // 前端用 `emailSupported()` 把入口隐藏掉，不会去调它们。
            #[cfg(desktop)]
            email::email_save_as_note,
            #[cfg(desktop)]
            email::email_fetch_inbox,
            #[cfg(desktop)]
            email::email_fetch_all,
            #[cfg(desktop)]
            email::email_fetch_all_months,
            #[cfg(desktop)]
            email::email_save_uid,
            #[cfg(desktop)]
            email::email_get_body,
            #[cfg(desktop)]
            email::email_get_html,
            #[cfg(desktop)]
            email::email_get_message,
            #[cfg(desktop)]
            email::email_get_attachments,
            #[cfg(desktop)]
            email::email_save_account,
            #[cfg(desktop)]
            email::email_get_account,
            #[cfg(desktop)]
            email::email_list_accounts,
            #[cfg(desktop)]
            email::email_remove_account,
            #[cfg(desktop)]
            email::email_unseen_count,
            #[cfg(desktop)]
            email::email_list_folders,
            #[cfg(desktop)]
            email::email_list_months,
            #[cfg(desktop)]
            email::email_set_flag,
            #[cfg(desktop)]
            email::email_mark_read,
            #[cfg(desktop)]
            email::email_move_to_trash,
            #[cfg(desktop)]
            email::email_move_many_to_trash,
            #[cfg(desktop)]
            email::email_mark_many_read,
            #[cfg(desktop)]
            email::email_send,
            #[cfg(desktop)]
            email::email_test_connection,
            updates::fetch_update_manifest,
            commands::create_database,
            commands::save_page,
            commands::set_page_cover,
            commands::set_page_icon,
            commands::set_page_cover_height,
            commands::set_page_cover_pos,
            commands::save_pdf_annotations,
            commands::list_pdf_annotations,
            commands::list_all_pdf_annotations,
            commands::render_pdf_page,
            community::fetch_community_post,
            community::fetch_community_json,
            commands::delete_page,
            commands::move_page,
            search::search,
            sync::get_sync_config,
            sync::set_sync_config,
            sync::sync_now,
            sync::list_sync_profiles,
            sync::set_sync_profile,
            sync::sync_workspace,
            sync::team_register,
            sync::team_login,
            sync::team_logout,
            sync::team_list_spaces,
            sync::team_create_space,
            sync::team_list_members,
            sync::team_invite_member,
            sync::team_set_member_role,
            sync::team_remove_member,
            sync::team_get_session,
            sync::team_get_me,
            sync::team_get_server_email,
            sync::list_sync_history,
            sync::clear_sync_history,
            sync::team_list_orgs,
            sync::team_create_org,
            sync::team_list_org_members,
            sync::team_invite_org_member,
            sync::team_set_org_member_active,
            sync::team_remove_org_member,
            sync::team_approve_org_invite,
            sync::team_reject_org_invite,
            sync::team_deactivate_account,
            sync::team_deactivate_org_member,
            sync::team_generate_org_invite_code,
            sync::team_join_org_by_code,
            sync::team_presence_beat,
            sync::team_online,
            sync::team_list_comments,
            sync::team_add_comment,
            sync::team_delete_comment,
            sync::team_list_notifications,
            sync::team_seen_notification,
            sync::team_seen_all_notifications,
            attachments::save_image,
            attachments::attachment_path,
            attachments::copy_attachment,
            attachments::list_attachment_hashes,
            attachments::read_attachment_bytes,
            attachments::write_attachment_bytes,
            attachments::import_attachment_files,
            attachments::list_page_attachments,
            attachments::list_all_pdf_attachments,
            attachments::remove_attachment,
            attachments::remove_attachments,
            attachments::move_attachment,
            attachments::rename_attachment,
            attachments::get_attachment,
            attachments::restore_attachment,
            bookmark::fetch_bookmark_metadata,
            backlinks::get_backlinks,
            blocks::resolve_block,
            blocks::get_page_blocks,
            blocks::search_blocks,
            blocks::list_block_backlinks,
            graph::get_graph,
            properties::list_attr_defs,
            properties::create_attr,
            properties::update_attr,
            properties::delete_attr,
            properties::reorder_attrs,
            properties::set_page_prop,
            properties::remove_page_prop,
            properties::get_page_props,
            database::get_db_columns,
            database::add_db_column,
            database::remove_db_column,
            database::query_database,
            database::board_by_attr,
            database::reorder_db_columns,
            database::list_db_views,
            database::save_db_view,
            database::delete_db_view,
            database::set_db_rule,
            database::get_db_rule,
            database::resolve_refs,
            tags::list_tags,
            tags::create_tag,
            tags::rename_tag,
            tags::set_tag_color,
            tags::delete_tag,
            tags::page_tags,
            tags::add_tag,
            tags::remove_tag,
            tags::pages_by_tag,
            tags::board_data,
            tags::move_card,
            tags::reorder_card,
            tags::reorder_tag,
            templates::list_templates,
            templates::save_as_template,
            templates::delete_template,
            trash::list_deleted,
            trash::restore_page,
            trash::purge_page,
            versions::list_versions,
            versions::restore_version,
            versions::clear_page_versions,
            backup::export_backup,
            backup::import_backup,
            backup::write_text_file,
            backup::write_binary_file,
            backup::read_text_file,
            workspace_io::export_workspace,
            workspace_io::import_workspace,
            storage::storage_stats,
            storage::clear_trash,
            storage::cleanup_orphan_attachments,
            storage::cleanup_old_versions,
            storage::cleanup_temp_files,
            storage::purge_deleted_workspaces,
            windows::open_page_window,
            titlebar::set_titlebar_theme,
            titlebar::show_window_menu,
            titlebar::set_mica_effect,
            plugins::plugin_settings,
            plugins::set_plugin_setting,
            // 「重新确认」：插件声明扩张后宿主会暂停它，用户点这个按钮才恢复。
            // **别漏**：漏了的话前端有契约、有按钮，桌面点下去只有
            // "command approve_plugin not found"（而 web 平台的 stub 让它看起来正常）。
            // scripts/check-web-commands.mjs 现在会拦这种"CommandMap 有、Rust 没注册"。
            plugins::approve_plugin,
            plugins::emit_plugin_event,
            plugins::list_plugins,
            plugins::set_plugin_enabled,
            plugins::run_plugin_command,
            // 「取消」= 终止那次运行的宿主子进程（M11.13 / D4）。
            plugins::cancel_plugin_run,
            plugins::uninstall_plugin,
            plugins::install_plugin,
            // M11.11a：索引协议（拉索引 / 从索引安装）。
            plugins::fetch_plugin_index,
            plugins::install_plugin_from_index,
            // M11.11b 第一块：离线撤回列表（记住"这个版本不该再用"，离线也拦得住）。
            plugins::plugin_revocations,
            plugins::ignore_plugin_revocation,
            // M11.11b 第二块：发布者公钥固定（TOFU）。
            plugins::plugin_publisher_keys,
            // M11.11b：按发布者密钥撤回。
            plugins::plugin_revoked_keys,
            plugins::ignore_revoked_publisher_key,
            plugins::open_plugin_dir,
            plugin_validate::validate_plugin,
            // M11.11b 治理：事实清单（只摆事实，不评分）。
            plugins::plugin_facts,
            // M11.11a 多源：订阅一组索引（自托 / 社区 / 企业内网），可增删、可逐个检查。
            plugins::plugin_index_subscriptions,
            plugins::subscribe_plugin_index,
            plugins::unsubscribe_plugin_index,
            plugins::check_plugin_index_subscriptions,
            plugin_validate::plugin_dir_stamp,
            plugins::plugin_logs,
            plugins::clear_plugin_logs,
            plugins::plugin_audit,
            plugins::clear_plugin_audit,
            security::set_encryption,
            security::encryption_status,
            security::disable_encryption,
            security::lock_encryption,
            security::unlock_encryption,
            ai::ai_complete,
            ai::ai_probe,
            ai::ai_complete_stream,
            // `shuyonote://` 冷启动取件：前端挂载时 drain 一次队列。
            // 为什么要一条命令而不是只靠事件：主窗口是 `visible(false)` 先隐藏、
            // 页面 load 完才 show，冷启动那条事件在前端注册监听之前就过去了。
            // 队空 ⇒ 返回空数组 ⇒ 前端什么都不做（普通启动零副作用）。
            deeplink::deep_link_take,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
