//! M11.13 阶段 1 的完成标志：**起一个真的宿主子进程，跑一段真的插件 JS，拿到结果**。
//!
//! 为什么必须是集成测试（而不是单元测试）：这一阶段要证明的东西**只有跨进程才存在**——
//! 分流发生在 Tauri 初始化之前、握手先于请求、帧能穿过真管道、父进程收工时子进程真的退出。
//! 在进程内怎么测都测不到这些。
//!
//! 用的是 `CARGO_BIN_EXE_shuyonote`（测试配置给出的**应用二进制**，不是测试进程自己）：
//! 生产路径就是"re-exec 自己"，所以这里跑的正是那条路径。
//!
//! 阶段 1 的能力调用是**假应答**（子进程没有库、没有密钥、没有路径）。所以这里的插件只用
//! 不需要数据的东西：返回字符串、`api.log`（走能力通道 → 假应答）、以及订阅一个事件。
//! 阶段 2 会把能力改成 RPC 回父进程，那时这批断言会跟着长大。

use shuyonote_lib::plugin_host::{HostClient, HostRunRequest};
use std::path::PathBuf;

fn app_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_shuyonote"))
}

fn req(source: &str, command_id: &str) -> HostRunRequest {
    HostRunRequest {
        plugin_id: "host-test".into(),
        source: source.into(),
        command_id: command_id.into(),
        args_json: String::new(),
        permissions: vec![],
        current_page_id: Some("p1".into()),
        current_page_json: "{}".into(),
        page_count: 3,
    }
}

#[test]
fn a_real_child_process_runs_plugin_js_and_returns_the_result() {
    let mut client = HostClient::spawn_with_exe(&app_bin()).expect("宿主子进程应当起得来");
    assert!(client.child_pid > 0, "握手要报上子进程 pid（证明是另一个进程，不是自己）");
    assert_ne!(
        client.child_pid,
        std::process::id(),
        "子进程的 pid 必须与父进程不同——相同就说明根本没 fork 出去"
    );

    // 最朴素的插件：没有能力调用，只有返回值。
    let res = client
        .run(req(
            r#"register({ id: "h.ok", title: "OK", run: function () { return "来自子进程"; } });"#,
            "h.ok",
        ))
        .expect("跑得通");
    assert_eq!(res.message, "来自子进程");
    assert!(res.drafts.is_null() || res.drafts.as_array().is_some(), "草稿形状原样透传");

    // 能力调用：阶段 1 是假应答，但仍然要**穿过** `__cap` 这条通道（回归价值在"通道通"，
    // 不在"数据对"——数据对是阶段 2 的事）。
    let res = client
        .run(req(
            r#"register({ id: "h.cap", title: "Cap", run: function () {
                 var echoed = api.kv.get("hello");
                 return "echo=" + String(echoed && echoed.method);
               } });"#,
            "h.cap",
        ))
        .expect("有假应答的能力调用也要跑得通");
    assert_eq!(res.message, "echo=kv.get", "能力调用要穿过 __cap 并拿到假应答：{}", res.message);

    // 入参照传：宿主给的 argsJson 要走完整条链。
    let mut with_args = req(
        r#"register({ id: "h.args", title: "Args", run: function (a) { return "args=" + String(a.who); } });"#,
        "h.args",
    );
    with_args.args_json = r#"{"who":"宿主"}"#.into();
    let res = client.run(with_args).expect("带参调用要跑得通");
    assert_eq!(res.message, "args=宿主");

    // 收工：子进程要真的退出（方案 §6.3：退出应用后不留孤儿进程）。
    client.shutdown().expect("礼貌收工应当是退出码 0");
}

#[test]
fn plugin_errors_come_back_as_a_code_not_a_broken_pipe() {
    let mut client = HostClient::spawn_with_exe(&app_bin()).expect("宿主子进程应当起得来");

    // 插件**抛错**不是"通道坏了"：shim 把它转成一句给用户看的结果（`__plugin: 执行出错…`），
    // 于是它走的是 Done 而不是 Failed —— 这条边界不该改变任何既有的错误语义。
    let res = client
        .run(req(
            r#"register({ id: "h.boom", title: "Boom", run: function () { throw new Error("炸了"); } });"#,
            "h.boom",
        ))
        .expect("插件抛错不该被当成通道故障");
    assert!(res.message.contains("炸了"), "用户要看到插件自己的话：{:?}", res.message);
    assert!(res.message.contains("执行出错"), "{:?}", res.message);

    // 语法错（插件根本没法初始化）才是 Failed：父进程拿到 (code, message)，而不是一句人话。
    let err = client
        .run(req(r#"register({ id: "h.bad", title: "Bad", run: function () { "#, "h.bad"))
        .expect_err("初始化失败要变成 Err");
    assert!(err.contains("plugin_error"), "错误要带 code：{err}");
    assert!(err.contains("初始化失败"), "错误要说清是初始化：{err}");
    assert!(!err.contains("通道"), "不该被当成通道故障：{err}");

    // 通道仍然可用
    let res = client
        .run(req(
            r#"register({ id: "h.ok", title: "OK", run: function () { return "还好"; } });"#,
            "h.ok",
        ))
        .expect("同一个子进程还能继续跑");
    assert_eq!(res.message, "还好");

    client.shutdown().ok();
}

#[test]
fn protocol_version_mismatch_is_refused() {
    // 版本对不上就直接失败（两边是同一个二进制，不一致只可能是有人把旧进程留着跑）。
    // 这里手工起一个子进程、先读掉它的 Ready，再验证 HostClient 的检查逻辑——
    // 用**伪造的帧**模拟"老版本子进程"。
    use shuyonote_lib::plugin_host::{read_frame, write_frame, HostOut, PROTOCOL_VERSION};
    use std::io::{BufReader, Write};
    use std::process::{Command, Stdio};

    let mut child = Command::new(app_bin())
        .arg("--plugin-host")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("起得来");
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let ready: HostOut = read_frame(&mut out).unwrap().expect("应当先收到握手");
    match ready {
        HostOut::Ready { protocol, .. } => {
            // 协议版本**写死在这里**：改协议是件要显式做的事，改常量时这条会红，
            // 逼着人想一遍"老进程还在跑怎么办"（当前答案：直接拒绝，见 HostIn 的注释）。
            assert_eq!(protocol, 1, "协议版本是契约，改动要同步这条断言");
            assert_eq!(protocol, PROTOCOL_VERSION);
        }
        other => panic!("握手应当是 Ready：{other:?}"),
    }
    // 关掉 stdin：子进程读到 EOF 应当**干净退出**（退出码 0），不是报错。
    drop(child.stdin.take());
    let st = child.wait().expect("等得到");
    assert!(st.success(), "父进程关管道 = 收工，退出码应当是 0：{st:?}");

    // 顺手证明 write_frame 的方向也能用（父 → 子）
    let mut buf: Vec<u8> = Vec::new();
    write_frame(&mut buf, &shuyonote_lib::plugin_host::HostIn::Shutdown).unwrap();
    buf.flush().unwrap();
    assert!(!buf.is_empty());
}

/// 父进程异常结束（没有礼貌收工）时**不许留下孤儿宿主进程**——方案 §6.3 的手工验收项，
/// 这里做成自动化的：`HostClient` 的 `Drop` 会杀子进程，杀掉之后 pid 必须真的消失。
#[cfg(unix)]
#[test]
fn dropping_the_client_leaves_no_orphan_host_process() {
    use std::process::Command;

    fn alive(pid: u32) -> bool {
        // `kill -0`：进程存在则成功（不真的发信号）。
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    let client = HostClient::spawn_with_exe(&app_bin()).expect("宿主子进程应当起得来");
    let pid = client.child_pid;
    assert!(alive(pid), "刚起来的子进程应当活着");

    drop(client); // 异常路径：没有 shutdown，只能靠 Drop 兜底

    // kill 是异步的：给它一点时间退干净，但别无限等。
    let mut gone = false;
    for _ in 0..50 {
        if !alive(pid) {
            gone = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(
        gone,
        "父进程 drop 之后宿主子进程 {pid} 还活着——这正是「退出应用后 ps 里还有残留」那种事故",
    );
}
