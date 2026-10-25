//! 隧道帧协议 —— 把**一次原样的 HTTP 请求**搬到对端（Step 2b-1）。
//!
//! ## 它解决什么
//!
//! 方案 §四.1：同步逻辑只认「端点」，不认「怎么连上的」。局域网是 HTTP 直连；
//! 跨网要走一条**字节流**（QUIC / iroh 隧道）。本模块只做「请求 ↔ 流上的帧」这一层：
//! ⛔ 不解析业务字段、⛔ 不认识 `space_id`、⛔ 不碰同步语义 —— 中继只搬字节。
//!
//! ## 帧格式（刻意小，且**不靠分隔符扫正文**）
//!
//! ```text
//! 请求：  method "\n"  target "\n"
//! 应答：  status(十进制) "\n"  body_len(十进制) "\n"  body 字节
//! ```
//!
//! ⚠️ 正文用**长度前缀**而不是找分隔符：正文里可能含任意字节（JSON 里就有 `\n`）。
//! ⚠️ 两个上限都**必须有**（否则对端一句 `body_len=4000000000` 就能让我们分配 4 GB）：
//! [`MAX_LINE_BYTES`]（method/target 各一行）＋ [`MAX_BODY_BYTES`]（应答正文）。
//!
//! ## 今天做到哪
//!
//! ✅ 帧的读写 ＋ `serve_one`（读一个请求 → 交给 handler → 写回应）＋ 真流上的判据（`tokio::io::duplex`）
//! ⛔ **没做**：iroh 接线（建 endpoint、打洞、QUIC 流）—— 那是 Step 2b-2，
//!    它与本层**无关**：本层的入参是 `AsyncRead + AsyncWrite`，谁给流都行。
//! ⚠️ handler 在真接线里就是**本机同一套 `mesh::dispatch`**（⛔ 不为隧道另写一套路由）。

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// method/target 一行的上限（正常最长是 `/mesh/attachment?space_id=…&hash=…`，几百字节）。
pub const MAX_LINE_BYTES: usize = 8 * 1024;
/// 应答正文上限（附件走**流式**那条另算，不经过本协议）。
pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelRequest {
    pub method: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelReply {
    pub status: u16,
    pub body: Vec<u8>,
}

fn bad(msg: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, msg.into())
}

/// 读一行（到 `\n` 为止，**不含** `\n`），超过 [`MAX_LINE_BYTES`] ⇒ 报错。
async fn read_line<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<String> {
    let mut out: Vec<u8> = Vec::new();
    let mut buf = [0u8; 1];
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "流在对端说完之前断了",
            ));
        }
        if buf[0] == b'\n' {
            return String::from_utf8(out).map_err(|_| bad("帧里有一行不是 UTF-8"));
        }
        out.push(buf[0]);
        if out.len() > MAX_LINE_BYTES {
            return Err(bad(format!("一行超过上限 {MAX_LINE_BYTES} 字节")));
        }
    }
}

pub async fn write_request<W: AsyncWrite + Unpin>(
    w: &mut W,
    req: &TunnelRequest,
) -> std::io::Result<()> {
    if req.method.contains('\n') || req.target.contains('\n') {
        return Err(bad("method/target 里不许有换行（否则帧就断了）"));
    }
    w.write_all(format!("{}\n{}\n", req.method, req.target).as_bytes()).await?;
    w.flush().await
}

pub async fn read_request<R: AsyncRead + Unpin>(
    r: &mut R,
) -> std::io::Result<TunnelRequest> {
    let method = read_line(r).await?;
    let target = read_line(r).await?;
    if method.is_empty() || target.is_empty() {
        return Err(bad("method/target 不许为空"));
    }
    Ok(TunnelRequest { method, target })
}

pub async fn write_reply<W: AsyncWrite + Unpin>(
    w: &mut W,
    reply: &TunnelReply,
) -> std::io::Result<()> {
    w.write_all(format!("{}\n{}\n", reply.status, reply.body.len()).as_bytes()).await?;
    w.write_all(&reply.body).await?;
    w.flush().await
}

pub async fn read_reply<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<TunnelReply> {
    let status_line = read_line(r).await?;
    let status: u16 = status_line
        .parse()
        .map_err(|_| bad(format!("应答状态码不是数字：{status_line:?}")))?;
    let len_line = read_line(r).await?;
    let len: usize = len_line
        .parse()
        .map_err(|_| bad(format!("应答正文长度不是数字：{len_line:?}")))?;
    if len > MAX_BODY_BYTES {
        return Err(bad(format!("应答正文 {len} 字节，超过上限 {MAX_BODY_BYTES}")));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    Ok(TunnelReply { status, body })
}

/// 服务侧：**读一个请求 → 交给 handler → 写回应**（一条流只服务一个请求，简单为先）。
///
/// ⚠️ 真接线里 `handler` 必须是**本机同一套 `mesh::dispatch`** —— 这样隧道与局域网
/// 走的是同一份鉴权/路由/租约判定，⛔ 不会造出"第二条同步语义"。
pub async fn serve_one<R, W, H>(
    r: &mut R,
    w: &mut W,
    handler: H,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    H: FnOnce(&TunnelRequest) -> TunnelReply,
{
    let req = read_request(r).await?;
    let reply = handler(&req);
    write_reply(w, &reply).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_request_and_a_reply_round_trip_over_one_stream() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let h = tokio::spawn(async move {
            // 同一条流的两半：读写必须分开借（⛔ 不能把同一个 &mut 递两次）
            let (mut sr, mut sw) = tokio::io::split(server);
            serve_one(&mut sr, &mut sw, |req| {
                // ⚠️ 正文里**故意**放一个换行：这正是"不能用分隔符扫正文"的理由
                TunnelReply {
                    status: 200,
                    body: format!("你问的是 {}\n", req.target).into_bytes(),
                }
            })
            .await
        });
        write_request(
            &mut client,
            &TunnelRequest {
                method: "GET".into(),
                target: "/mesh/pull?space_id=sp&since=0".into(),
            },
        )
        .await
        .unwrap();
        let reply = read_reply(&mut client).await.unwrap();
        h.await.unwrap().unwrap();
        assert_eq!(reply.status, 200);
        assert_eq!(
            String::from_utf8(reply.body).unwrap(),
            "你问的是 /mesh/pull?space_id=sp&since=0\n"
        );
    }

    /// ⭐ 判据：**请求原样到达 handler**（method/target 一个字都不改）——
    /// 这钉的是"隧道路由与局域网路由是同一份"，⛔ 不是"另一条协议"。
    #[tokio::test]
    async fn the_handler_sees_the_exact_request() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let h = tokio::spawn(async move {
            let mut tx = Some(tx);
            let (mut sr, mut sw) = tokio::io::split(server);
            serve_one(&mut sr, &mut sw, move |req| {
                let _ = tx.take().unwrap().send(req.clone());
                TunnelReply { status: 204, body: Vec::new() }
            })
            .await
        });
        let sent = TunnelRequest {
            method: "GET".into(),
            target: "/mesh/manifest?space_id=abc&x=1".into(),
        };
        write_request(&mut client, &sent).await.unwrap();
        let reply = read_reply(&mut client).await.unwrap();
        h.await.unwrap().unwrap();
        assert_eq!(reply.status, 204);
        assert_eq!(rx.await.unwrap(), sent);
    }

    /// ⭐ 判据：**超长正文必须被拒**（⛔ 不许照着对端说的长度去分配内存）。
    #[tokio::test]
    async fn an_oversized_body_length_is_refused_not_allocated() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        let w = tokio::spawn(async move {
            let _ = server.write_all(format!("200\n{}\n", MAX_BODY_BYTES + 1).as_bytes()).await;
        });
        let err = read_reply(&mut client).await.expect_err("超长必须报错");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("超过上限"), "要说清为什么：{err}");
        w.await.unwrap();
    }

    /// ⭐ 判据：**流半截断**要报"对端没说完"，⛔ 不许把半帧当完整帧用。
    #[tokio::test]
    async fn a_truncated_frame_is_an_error_not_a_partial_request() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        tokio::spawn(async move {
            server.write_all(b"GET\n").await.unwrap();
            drop(server);
        });
        let err = read_request(&mut client).await.expect_err("半帧必须报错");
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof);
    }
}
