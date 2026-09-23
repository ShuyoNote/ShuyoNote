//! **yrs 对拍尖刺**（冲刺缺口 §10.3-6 / §9.2-4）—— 只读/只算，不碰生产代码。
//!
//! 要回答的问题：**Rust 的 `yrs` 与 JS 的 `yjs` 能不能互操作到"同一条血统的更新可以互相合并"**
//! 这一步？能，则 S5 阶段 2（服务端开算）在**格式层**可行；不能，则阶段 2 只能换方案。
//!
//! 它**不做**什么：不实现 Lexical 投影（那是 `@lexical/yjs` 的事；Rust 侧复刻它就是第二份
//! 派生实现 —— 本仓最忌的形状）。所以分工是：
//!   · **JS**：造 fixtures（真 `yjs` ＋ 真 `@lexical/yjs`）＋ 合并 ＋ **投影**（用应用自己那份实现）；
//!   · **Rust（本文件）**：只做"**收下别人的 update → 合并 → 再吐出来**"，
//!     外加一份**结构读数**（state vector / 根节点树）供两侧对照；
//!   · **JS 再验一遍**：把 Rust 吐出来的状态投影出来，与 JS 自己合并的投影比。
//!
//! 用法（读数一律**写文件**，不靠管道 —— 调用方（vitest）与这里的 stdout 口径不必绑死）：
//!   yrs-interop merge   <out.bin> <in1.bin> [in2.bin ...]
//!   yrs-interop inspect <out.txt> <in1.bin> [in2.bin ...]
//!   yrs-interop threads <out.txt>              # 两线程共用一个 Doc 的失败形态实测
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::process::ExitCode;

use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlFragment, XmlOut};

/// 与 `src/lib/crdt/yDocBridge.ts` 的 `ROOT_KEY_V2` 是**同一个字面量**（跨语言契约）。
/// ⚠️ 这里刻意写死并注释来源：尖刺就是要证明"两侧认得同一个根"。
const ROOT_KEY_V2: &str = "root-v2";

fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("读不到 {path}: {e}"))
}

fn write_text(path: &str, text: &str) -> Result<(), String> {
    fs::write(path, text).map_err(|e| format!("写不了 {path}: {e}"))
}

/// 依次把各端的 update 应用到一个**空 Doc** 上（＝合并）。
///
/// 为什么起点可以是空 Doc：`yjs`/`yrs` 的 update 自带 clientID ＋ 时钟，合并语义不依赖
/// "先载入基线" —— 这正是"每页一份血统"能靠交换状态字节合并的原因（S2a 的那条口径）。
fn merged_doc(paths: &[String]) -> Result<Doc, String> {
    let doc = Doc::new();
    let mut txn = doc.transact_mut();
    for path in paths {
        let bytes = read_bytes(path)?;
        let update = Update::decode_v1(&bytes).map_err(|e| format!("decode_v1 失败（{path}）：{e:?}"))?;
        txn.apply_update(update)
            .map_err(|e| format!("apply_update 失败（{path}）：{e:?}"))?;
    }
    drop(txn);
    Ok(doc)
}

/// 根节点树的结构读数（不解释 Lexical 语义，只如实列出**结构**）。
///
/// ⚠️ **必须先拿到根句柄、再开读事务**：`get_or_insert_xml_fragment` 内部会开**写事务**
/// （`transact_mut`），而"持有读事务时再要写事务"在 `yrs` 里是**死锁**（不是报错 ——
/// 本文件第一次跑 `inspect` 就是这么挂住的，实测 ≥45s 无输出）。
/// 这条对服务端设计同样成立：**请求内短命 Doc** 的根句柄要在读事务之前拿好。
fn structure(doc: &Doc, out: &mut String) {
    let frag = doc.get_or_insert_xml_fragment(ROOT_KEY_V2);
    let txn = doc.transact();
    let mut clients: Vec<String> = txn
        .state_vector()
        .iter()
        .map(|(id, clock)| format!("{id}:{clock}"))
        .collect();
    clients.sort();
    let _ = writeln!(out, "state_vector={}", clients.join(","));

    let _ = writeln!(out, "root_children={}", frag.children(&txn).count());
    for (i, node) in frag.children(&txn).enumerate() {
        walk(&txn, i, &node, 0, out);
    }
}

fn walk<T: ReadTxn>(txn: &T, index: usize, node: &XmlOut, depth: usize, out: &mut String) {
    let pad = "  ".repeat(depth + 1);
    match node {
        XmlOut::Element(el) => {
            let mut attrs: Vec<String> = el
                .attributes(txn)
                .map(|(k, v)| format!("{k}={v}"))
                .collect();
            attrs.sort();
            let _ = writeln!(out, "{pad}[{index}] <{} {}>", el.tag(), attrs.join(" "));
            if depth < 2 {
                for (j, kid) in el.children(txn).enumerate() {
                    walk(txn, j, &kid, depth + 1, out);
                }
            }
        }
        XmlOut::Text(t) => {
            let _ = writeln!(out, "{pad}[{index}] #text {:?}", t.get_string(txn));
        }
        XmlOut::Fragment(_) => {
            let _ = writeln!(out, "{pad}[{index}] <fragment>");
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("merge") => {
            if args.len() < 3 {
                return usage();
            }
            let doc = match merged_doc(&args[2..]) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("{e}");
                    return ExitCode::FAILURE;
                }
            };
            let txn = doc.transact();
            let merged = txn.encode_state_as_update_v1(&StateVector::default());
            let clients = txn.state_vector().len();
            drop(txn);
            println!("clients={clients} merged_bytes={}", merged.len());
            if let Err(e) = fs::write(&args[1], &merged) {
                eprintln!("写不了 {}: {e}", args[1]);
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Some("inspect") => {
            if args.len() < 3 {
                return usage();
            }
            let doc = match merged_doc(&args[2..]) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("{e}");
                    return ExitCode::FAILURE;
                }
            };
            let mut text = String::new();
            structure(&doc, &mut text);
            print!("{text}");
            if let Err(e) = write_text(&args[1], &text) {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        // 「两线程共用一个 Doc」的失败形态 —— 见 `thread_probe` 的说明。
        Some("threads") => {
            if args.len() < 2 {
                return usage();
            }
            let text = format!("threads: {}\n", thread_probe());
            print!("{text}");
            if let Err(e) = write_text(&args[1], &text) {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        _ => usage(),
    }
}

fn usage() -> ExitCode {
    eprintln!("用法: yrs-interop merge   <out.bin> <in1.bin> [in2.bin ...]");
    eprintln!("      yrs-interop inspect <out.txt> <in1.bin> [in2.bin ...]");
    eprintln!("      yrs-interop threads <out.txt>");
    ExitCode::from(2)
}

/// ★ 实测「两线程共用一个 `Doc`」——**带看门狗，读数必须有界**。
///
/// `yrs` 的 `Doc` 走**内部可变**（`&self` 上就能开事务），所以"两个线程共享一个 Doc"
/// **编译得过**（`Doc: Sync`）—— 真正的限制在**运行期**。本函数把这件事变成**可复核的读数**，
/// 而不是引用一句文档。两条对照（同一次运行里都给出来）：
///   · **共享一个 Doc**：两线程各自"建 root ＋ 插一个字"；
///   · **各用一个 Doc**（对照）：同样两线程各写各的 —— 用来证明"卡住"不是"多线程本身"的锅。
///
/// ⚠️ 为什么要看门狗：第一次实测（2026-09-23）**整条命令卡死到 120s 超时**。
/// 对服务端来说"卡死"比"panic"更危险（连接不返回、线程池被吃光）⇒ 读数必须能**有界地**报出它。
/// 所以把每条探针放进一个线程，主线程 `recv_timeout`；超时 ⇒ 如实报"卡住 ≥N 秒"，然后照常退出
/// （卡住的那两条线程随进程结束一起消失，不会拖住调用方）。
fn probe<F>(label: &str, secs: u64, body: F) -> String
where
    F: FnOnce() -> String + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(body());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(secs)) {
        Ok(s) => format!("{label}: {s}"),
        Err(_) => format!(
            "{label}: ★ **{secs} 秒内没有结束（卡住）** —— 调用方按\"卡死\"处理（比 panic 更危险：不返回、会吃线程）"
        ),
    }
}

fn thread_probe() -> String {
    // ① **可复现的死锁形态**：**读事务还活着**的时候再调 `get_or_insert_*`
    //    （它内部开写事务）⇒ `yrs` 不报错、直接**卡住**。
    //    这条是真的踩出来的：本文件第一版 `structure()` 就是"先 `doc.transact()` 再去
    //    `doc.get_or_insert_xml_fragment(...)`"，实测 `inspect` **挂住 ≥45s 无输出**
    //    （另一次整条命令卡到 120s 超时）。单线程就能复现，不是并发问题。
    //    ⇒ 对服务端设计的约束：**根句柄要在读事务之前取好**；任何"事务里顺手 get_or_insert"
    //      都会变成卡死，而卡死比 panic 危险得多（不返回、吃线程）。
    let in_txn = probe("读事务还活着时再调 get_or_insert（失败形态）", 2, || {
        let doc = Doc::new();
        let text = doc.get_or_insert_text("t");
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, "x");
        }
        let _txn = doc.transact(); // ← 读事务，故意让它活到下一行之后（具名绑定才不会提前析构）
        let again = doc.get_or_insert_text("t2"); // ← 这里要写事务 ⇒ 卡住
        format!("**居然没卡**（读回 {again:?}）")
    });

    // ② 并发共享一个 Doc（两个线程各自顺手 `get_or_insert_text` ＋ 写）
    //    实测：**没有复现失败**（两笔都落住）。⇒ "共享会卡"这个说法**不成立**；
    //    真正会卡的是 ① 那种"事务里再要事务"的写法。
    let naive = probe("共享一个 Doc ＋ 两线程各自 get_or_insert 并写", 5, || {
        let doc = Doc::new();
        let (a, b) = std::thread::scope(|s| {
            let ra = s.spawn(|| {
                let text = doc.get_or_insert_text("t-a");
                let mut txn = doc.transact_mut();
                text.insert(&mut txn, 0, "A");
            });
            let rb = s.spawn(|| {
                let text = doc.get_or_insert_text("t-b");
                let mut txn = doc.transact_mut();
                text.insert(&mut txn, 0, "B");
            });
            (ra.join(), rb.join())
        });
        format!(
            "线程 A {}／线程 B {}",
            if a.is_ok() { "没有 panic" } else { "**panic 了**" },
            if b.is_ok() { "没有 panic" } else { "**panic 了**" },
        )
    });

    // ③ 对照：各用一份 Doc（每页独立、请求内短命 —— 我们打算用的形状）。
    let separate = probe("各用一个 Doc（我们打算用的形状）", 5, || {
        let (a, b) = std::thread::scope(|s| {
            let ta = s.spawn(|| {
                let doc = Doc::new();
                let text = doc.get_or_insert_text("t-a");
                {
                    let mut txn = doc.transact_mut();
                    text.insert(&mut txn, 0, "A");
                }
                let txn = doc.transact();
                (txn.state_vector().len(), text.get_string(&txn))
            });
            let tb = s.spawn(|| {
                let doc = Doc::new();
                let text = doc.get_or_insert_text("t-b");
                {
                    let mut txn = doc.transact_mut();
                    text.insert(&mut txn, 0, "B");
                }
                let txn = doc.transact();
                (txn.state_vector().len(), text.get_string(&txn))
            });
            (ta.join(), tb.join())
        });
        format!(
            "A={:?} B={:?}（两笔各在自己那份血统上落住）",
            a.map(|(c, s)| format!("clients={c} text={s:?}")),
            b.map(|(c, s)| format!("clients={c} text={s:?}")),
        )
    });

    format!("{in_txn}\n{naive}\n{separate}\n")
}
