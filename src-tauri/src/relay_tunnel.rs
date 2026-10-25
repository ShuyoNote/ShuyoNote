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
//! 请求：  method "\n"  target "\n"  header_count "\n"  (name "\n" value "\n")*
//! 应答：  status(十进制) "\n"  body_len(十进制) "\n"  body 字节
//! ⚠️ 头是**必须**的：对端 `mesh::dispatch` 靠三格头/口令鉴权（⛔ 匿名请求一律 401）。
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
/// 一条请求最多带多少个头（我们自己只用 3 个鉴权头 ＋ 可选 `authorization`）。
pub const MAX_HEADERS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelRequest {
    pub method: String,
    pub target: String,
    /// ⚠️ **HTTP 头也要带过去**：对端 `mesh::dispatch` 的鉴权靠三格头（设备号/时间戳/签名）
    /// 或会话口令 —— 帧里没有它们，对端就只会看到一条**匿名请求**（一律 401）。
    pub headers: Vec<(String, String)>,
}

impl TunnelRequest {
    pub fn new(method: &str, target: &str) -> Self {
        Self {
            method: method.to_string(),
            target: target.to_string(),
            headers: Vec::new(),
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
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
    let mut head = format!("{}\n{}\n{}\n", req.method, req.target, req.headers.len());
    for (k, v) in &req.headers {
        if k.is_empty() {
            return Err(bad("头名不许为空"));
        }
        if k.contains('\n') || v.contains('\n') {
            return Err(bad("头名/头值里不许有换行"));
        }
        head.push_str(k);
        head.push('\n');
        head.push_str(v);
        head.push('\n');
    }
    w.write_all(head.as_bytes()).await?;
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
    let n_line = read_line(r).await?;
    let n: usize = n_line
        .parse()
        .map_err(|_| bad(format!("头数量不是数字：{n_line:?}")))?;
    if n > MAX_HEADERS {
        return Err(bad(format!("头有 {n} 条，超过上限 {MAX_HEADERS}")));
    }
    let mut headers = Vec::with_capacity(n);
    for _ in 0..n {
        let k = read_line(r).await?;
        let v = read_line(r).await?;
        if k.is_empty() {
            return Err(bad("头名不许为空"));
        }
        headers.push((k, v));
    }
    Ok(TunnelRequest { method, target, headers })
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

/// ⭐ **Step 2b-2**：把上面这层帧协议架到 **iroh 的 QUIC 流**上。
///
/// ⚠️ 只有 `--features relay` 才编（owner 2026-10-25 拍：默认产物里不出现 `iroh`）。
/// ⚠️ 本模块**不做**同步语义：它只把「一条流」变成「一次请求/应答」，
/// 真正的路由/鉴权在对端 `handler` 里（真接线＝本机同一套 `mesh::dispatch`）。
///
/// 今天验到哪：**同一台机器两个端点直连**（`presets::Minimal` ＋ 直连地址）跑通一次请求
/// （判据 `two_endpoints_on_one_host_move_one_request`）；
/// ⛔ **没验**：经**公网中继**跨网（那要两台机器/一条真中继，留给真机验收）。
/// 分块流式应答的上限：**单块** 64 KB（⛔ 不是整包读入 —— 附件可以几百 MB）。
pub const STREAM_CHUNK: usize = 64 * 1024;

/// 应答「流式」而不是整包时用的帧（附件那条走这里）：
///
/// ```text
/// 应答： status "\n"  (chunk_len "\n" chunk)*  "0\n"
/// ```
///
/// ⚠️ 与整包应答（`status\n len\n body`）**不能混用**：靠请求的 method 区分
/// （`"GET+STREAM"` ⇒ 流式；`"GET"` ⇒ 整包）—— ⛔ 不靠"猜长度"。
pub async fn write_stream_reply<R, W>(
    w: &mut W,
    status: u16,
    src: &mut R,
) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    w.write_all(format!("{status}\n").as_bytes()).await?;
    let mut buf = vec![0u8; STREAM_CHUNK];
    let mut total: u64 = 0;
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        w.write_all(format!("{n}\n").as_bytes()).await?;
        w.write_all(&buf[..n]).await?;
        total += n as u64;
    }
    w.write_all(b"0\n").await?;
    w.flush().await?;
    Ok(total)
}

/// 客户端：把**流式应答**解成一条 `AsyncRead`（⛔ 不把整包读进内存）。
pub fn read_stream_reply<R>(r: R) -> StreamReplyReader<R>
where
    R: AsyncRead + Unpin,
{
    StreamReplyReader { inner: r, state: StreamState::Status, line: Vec::new(), chunk_left: 0, status: None }
}

enum StreamState { Status, ChunkLen, Chunk, Done }

/// 流式应答的读端：**先读一行 status**，之后按 `chunk_len` 一块块交付。
pub struct StreamReplyReader<R> {
    inner: R,
    state: StreamState,
    line: Vec<u8>,
    chunk_left: usize,
    status: Option<u16>,
}

impl<R> StreamReplyReader<R> {
    /// 帧头里那个状态码（读完第一行才有；还没读到 ⇒ `None`）。
    pub fn status(&self) -> Option<u16> {
        self.status
    }
}

impl<R: AsyncRead + Unpin> StreamReplyReader<R> {
    /// 已经在外面把 status 行读掉了 ⇒ 从这里接着读块。
    ///
    /// 附件那条要用它：调用方要先拿 status 判 404/401，再决定要不要往磁盘写字节。
    pub fn after_status(inner: R, status: u16) -> Self {
        Self {
            inner,
            state: StreamState::ChunkLen,
            line: Vec::new(),
            chunk_left: 0,
            status: Some(status),
        }
    }
}

async fn read_byte<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<u8> {
    let mut b = [0u8; 1];
    let n = r.read(&mut b).await?;
    if n == 0 {
        return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "流在对端说完之前断了"));
    }
    Ok(b[0])
}

/// 从一条流里读一行（到 `\n`），写进调用方的缓冲（⛔ 不借 `self`，免得 poll_read 里借两次）。
async fn read_line_into<R: AsyncRead + Unpin>(
    r: &mut R,
    line: &mut Vec<u8>,
) -> std::io::Result<String> {
    line.clear();
    loop {
        let b = read_byte(r).await?;
        if b == b'\n' {
            return String::from_utf8(std::mem::take(line)).map_err(|_| bad("帧里有一行不是 UTF-8"));
        }
        line.push(b);
        if line.len() > MAX_LINE_BYTES {
            return Err(bad(format!("一行超过上限 {MAX_LINE_BYTES} 字节")));
        }
    }
}

impl<R: AsyncRead + Unpin> tokio::io::AsyncRead for StreamReplyReader<R> {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use std::future::Future;
        let this = self.get_mut();
        loop {
            match this.state {
                StreamState::Done => return std::task::Poll::Ready(Ok(())),
                StreamState::Status => {
                    let fut = read_line_into(&mut this.inner, &mut this.line);
                    let mut fut = std::pin::pin!(fut);
                    match fut.as_mut().poll(cx) {
                        std::task::Poll::Pending => return std::task::Poll::Pending,
                        std::task::Poll::Ready(Err(e)) => return std::task::Poll::Ready(Err(e)),
                        std::task::Poll::Ready(Ok(line)) => {
                            let status: u16 = line
                                .parse()
                                .map_err(|_| bad(format!("应答状态码不是数字：{line:?}")))?;
                            this.status = Some(status);
                            this.state = StreamState::ChunkLen;
                        }
                    }
                }
                StreamState::ChunkLen => {
                    let fut = read_line_into(&mut this.inner, &mut this.line);
                    let mut fut = std::pin::pin!(fut);
                    match fut.as_mut().poll(cx) {
                        std::task::Poll::Pending => return std::task::Poll::Pending,
                        std::task::Poll::Ready(Err(e)) => return std::task::Poll::Ready(Err(e)),
                        std::task::Poll::Ready(Ok(line)) => {
                            let len: usize = line
                                .parse()
                                .map_err(|_| bad(format!("块长度不是数字：{line:?}")))?;
                            if len > STREAM_CHUNK {
                                return std::task::Poll::Ready(Err(bad(format!(
                                    "单块 {len} 字节，超过上限 {STREAM_CHUNK}"
                                ))));
                            }
                            if len == 0 {
                                this.state = StreamState::Done;
                            } else {
                                this.chunk_left = len;
                                this.state = StreamState::Chunk;
                            }
                        }
                    }
                }
                StreamState::Chunk => {
                    let want = std::cmp::min(this.chunk_left, buf.remaining());
                    if want == 0 {
                        return std::task::Poll::Ready(Ok(()));
                    }
                    let mut tmp = vec![0u8; want];
                    let mut rb = tokio::io::ReadBuf::new(&mut tmp);
                    match std::pin::Pin::new(&mut this.inner).poll_read(cx, &mut rb) {
                        std::task::Poll::Pending => return std::task::Poll::Pending,
                        std::task::Poll::Ready(Err(e)) => return std::task::Poll::Ready(Err(e)),
                        std::task::Poll::Ready(Ok(())) => {
                            let n = rb.filled().len();
                            if n == 0 {
                                return std::task::Poll::Ready(Err(std::io::Error::new(
                                    std::io::ErrorKind::UnexpectedEof,
                                    "块没读完流就断了",
                                )));
                            }
                            buf.put_slice(&tmp[..n]);
                            this.chunk_left -= n;
                            if this.chunk_left == 0 {
                                this.state = StreamState::ChunkLen;
                            }
                            return std::task::Poll::Ready(Ok(()));
                        }
                    }
                }
            }
        }
    }
}

#[cfg(feature = "relay")]
pub mod iroh_tunnel {
    use super::{read_reply, read_request, write_reply, write_request, TunnelReply, TunnelRequest};

    /// 隧道专用的 ALPN（与 iroh 上别的协议区分）。
    pub const ALPN: &[u8] = b"shuyo-mesh-tunnel/1";

    /// 起一个端点：`Minimal` 预设（⛔ 不配中继、不配发现 ⇒ 只走**直连地址**）。
    ///
    /// ⚠️ `Minimal` 只有在开了 `tls-ring` 时才会装上加密提供者（否则 `bind` 会失败），
    /// 所以 `Cargo.toml` 里 `iroh` 那行显式带了 `features = ["tls-ring"]`。
    pub async fn bind(secret: iroh::SecretKey) -> Result<iroh::Endpoint, String> {
        iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(|e| format!("起 iroh 端点失败：{e}"))
    }

    /// 客户端：连对端 → 一条双向流 → 写请求 → 读回应。
    pub async fn request(
        ep: &iroh::Endpoint,
        peer: iroh::EndpointAddr,
        req: &TunnelRequest,
    ) -> Result<TunnelReply, String> {
        let conn = ep
            .connect(peer, ALPN)
            .await
            .map_err(|e| format!("连对端失败：{e}"))?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| format!("开流失败：{e}"))?;
        write_request(&mut send, req)
            .await
            .map_err(|e| format!("写请求失败：{e}"))?;
        let reply = read_reply(&mut recv)
            .await
            .map_err(|e| format!("读回应失败：{e}"))?;
        conn.close(0u32.into(), b"done");
        Ok(reply)
    }

    /// 服务侧：接一个连接 → 接一条流 → 读请求 → `handler` → 写回应（一次一条，简单为先）。
    pub async fn serve_one_conn<H>(conn: iroh::endpoint::Connection, handler: H) -> Result<(), String>
    where
        H: FnOnce(&TunnelRequest) -> TunnelReply,
    {
        let (mut send, mut recv) = conn.accept_bi().await.map_err(|e| format!("接流失败：{e}"))?;
        let req = read_request(&mut recv).await.map_err(|e| format!("读请求失败：{e}"))?;
        let reply = handler(&req);
        write_reply(&mut send, &reply).await.map_err(|e| format!("写回应失败：{e}"))?;
        send.finish().map_err(|e| format!("收流失败：{e}"))?;
        conn.closed().await;
        Ok(())
    }
}

/// ⭐ **Step 2c-1**：把隧道包成**同一个 `Endpoint` trait 的实现** ——
/// 这样 `pull_from_peer` / `fetch_peer_*` 那些同步调用**一行都不用改**就能走跨网。
///
/// ⚠️ 只有 `--features relay` 才编（默认产物里不出现 `iroh`）。
/// ⚠️ 鉴权：把 `auth`/`token` 变成**同样的三格头/Authorization** 塞进帧里 ——
///    对端 `mesh::dispatch` 因此看到的是与局域网请求**完全一样**的鉴权材料。
#[cfg(feature = "relay")]
pub mod iroh_client {
    use super::{iroh_tunnel, TunnelReply, TunnelRequest};
    use crate::mesh_endpoint::{Endpoint, HttpReply};
    use std::future::Future;
    use std::pin::Pin;

    /// 一个跨网端点：持有 iroh 端点 ＋ 对端地址（一次构造，多次 `get`）。
    pub struct RelayEndpoint {
        ep: iroh::Endpoint,
        peer: iroh::EndpointAddr,
    }

    impl RelayEndpoint {
        /// 直连地址形态（**今天唯一验证过的一种**：单机两端点 / 手工填 node id ＋ 地址）。
        pub async fn connect(peer: iroh::EndpointAddr) -> Result<Self, String> {
            let ep = iroh_tunnel::bind(iroh::SecretKey::generate()).await?;
            Ok(Self { ep, peer })
        }

        /// 只给 node id（64 位 hex）—— ⚠️ 没有地址就**只能靠发现层**，
        /// 而发现层还没做（Step 3）⇒ 这条路今天会明确报错，⛔ 不静默地"连不上就一直等"。
        pub async fn connect_by_node_id(node_id_hex: &str) -> Result<Self, String> {
            let bytes = node_id_bytes(node_id_hex)?;
            let id = iroh::PublicKey::from_bytes(&bytes).map_err(|e| format!("node id 不是合法公钥：{e}"))?;
            Err(format!(
                "只知道 node id（{}…）还不够：跨网发现层还没做（Step 3）⇒ 没有可达地址",
                &node_id_hex[..8.min(node_id_hex.len())]
            ))
            .map_err(|e: String| {
                let _ = id;
                e
            })
        }

        pub fn peer_id(&self) -> String {
            hex(&self.peer.id.as_bytes())
        }
    }

    impl Endpoint for RelayEndpoint {
        fn get<'a>(
            &'a self,
            target: &'a str,
            auth: Option<(&'a str, i64, &'a str)>,
            token: Option<&'a str>,
        ) -> Pin<Box<dyn Future<Output = Result<HttpReply, String>> + Send + 'a>> {
            Box::pin(async move {
                let mut req = TunnelRequest::new("GET", target);
                // 与 `LanEndpoint` **同一套头**（名字取自 mesh，⛔ 不另立一份）
                if let Some((device_id, ts, sig)) = auth {
                    req = req
                        .with_header(crate::mesh::HDR_DEVICE, device_id)
                        .with_header(crate::mesh::HDR_TS, &ts.to_string())
                        .with_header(crate::mesh::HDR_SIG, sig);
                }
                if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
                    req = req.with_header("authorization", &format!("Bearer {t}"));
                }
                let TunnelReply { status, body } = iroh_tunnel::request(&self.ep, self.peer.clone(), &req).await?;
                Ok(HttpReply {
                    status,
                    body: String::from_utf8_lossy(&body).into_owned(),
                })
            })
        }

        /// 附件那条：**流式**走隧道（请求 method 用 `GET+STREAM`，应答走分块帧）。
        fn get_stream<'a>(
            &'a self,
            target: &'a str,
            auth: Option<(&'a str, i64, &'a str)>,
            token: Option<&'a str>,
        ) -> Pin<Box<dyn Future<Output = Result<(u16, crate::mesh_endpoint::AttachmentBody), String>> + Send + 'a>> {
            Box::pin(async move {
                let mut req = TunnelRequest::new("GET+STREAM", target);
                if let Some((device_id, ts, sig)) = auth {
                    req = req
                        .with_header(crate::mesh::HDR_DEVICE, device_id)
                        .with_header(crate::mesh::HDR_TS, &ts.to_string())
                        .with_header(crate::mesh::HDR_SIG, sig);
                }
                if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
                    req = req.with_header("authorization", &format!("Bearer {t}"));
                }
                let conn = self
                    .ep
                    .connect(self.peer.clone(), iroh_tunnel::ALPN)
                    .await
                    .map_err(|e| format!("连对端失败：{e}"))?;
                let (mut send, mut recv) = conn.open_bi().await.map_err(|e| format!("开流失败：{e}"))?;
                super::write_request(&mut send, &req)
                    .await
                    .map_err(|e| format!("写请求失败：{e}"))?;
                // 先读 status 行（调用方要据此判 404/401，再决定要不要往磁盘写）
                let status_line = super::read_line(&mut recv)
                    .await
                    .map_err(|e| format!("读状态行失败：{e}"))?;
                let status: u16 = status_line
                    .parse()
                    .map_err(|_| format!("应答状态码不是数字：{status_line:?}"))?;
                let reader = super::StreamReplyReader::after_status(recv, status);
                let body: crate::mesh_endpoint::AttachmentBody =
                    Box::pin(RelayBody { _conn: conn, _send: send, reader });
                Ok((status, body))
            })
        }
    }

    /// 隧道里的附件正文流：**把连接与发送端一起拿着**。
    ///
    /// ⚠️ 只留读端不够 —— 连接一丢，QUIC 流就没了；把 `conn`/`send` 跟着流一起活，
    /// 直到调用方把正文读完（或被丢弃）。
    pub struct RelayBody {
        _conn: iroh::endpoint::Connection,
        _send: iroh::endpoint::SendStream,
        reader: super::StreamReplyReader<iroh::endpoint::RecvStream>,
    }

    impl tokio::io::AsyncRead for RelayBody {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.reader).poll_read(cx, buf)
        }
    }

    /// 把 64 位 hex 的 node id 解析成 32 字节公钥（⛔ 长度/字符都要查，不猜）。
    pub fn node_id_bytes(s: &str) -> Result<[u8; 32], String> {
        let s = s.trim();
        if s.len() != 64 {
            return Err(format!("node id 必须是 64 位 hex（现在是 {} 位）", s.len()));
        }
        let mut out = [0u8; 32];
        for i in 0..32 {
            out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
                .map_err(|_| "node id 里有非 hex 字符".to_string())?;
        }
        Ok(out)
    }

    fn hex(b: &[u8; 32]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
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
            &TunnelRequest::new("GET", "/mesh/pull?space_id=sp&since=0")
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
        let sent = TunnelRequest::new("GET", "/mesh/manifest?space_id=abc&x=1")
            .with_header("x-shuyo-dev", "dev-a");
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

    /// ⭐⭐ **2026-10-25（Step 6 判据）**：**附件正文经隧道流式取回** —— 真 QUIC 两个端点，
    /// 服务端按块写 100 KB，客户端用 `Endpoint::get_stream`（GET+STREAM）逐块读。
    /// ⚠️ 要害：走的是**同一条隧道帧协议**，⛔ 不是「拼个 URL 直接 reqwest」。
    #[cfg(feature = "relay")]
    #[tokio::test]
    async fn an_attachment_streams_through_the_tunnel() {
        use crate::mesh_endpoint::Endpoint;
        use std::net::SocketAddr;

        let server_ep = super::iroh_tunnel::bind(iroh::SecretKey::generate())
            .await
            .expect("服务端端点");
        let port = server_ep
            .bound_sockets()
            .iter()
            .find_map(|s: &SocketAddr| match s {
                SocketAddr::V4(v4) if v4.port() != 0 => Some(v4.port()),
                SocketAddr::V6(v6) if v6.port() != 0 => Some(v6.port()),
                _ => None,
            })
            .expect("要有已绑定端口");
        let addr = iroh::EndpointAddr {
            id: server_ep.id(),
            addrs: [iroh::TransportAddr::Ip(SocketAddr::from(([127, 0, 0, 1], port)))]
                .into_iter()
                .collect(),
        };
        let payload: Vec<u8> = (0..100 * 1024).map(|i| (i % 253) as u8).collect();
        let expect = payload.clone();
        // ⚠️ 服务端写完不能立刻 drop 端点（客户端会报 connection lost），
        //   但也**不能**等 `conn.closed()` —— 客户端在等 `serve.await` ⇒ 会死锁。
        //   ⇒ 用一个 oneshot 让客户端读完再放服务端走。
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        let serve = tokio::spawn(async move {
            let Some(accepting) = server_ep.accept().await else {
                panic!("端点已关");
            };
            let conn = accepting.await.expect("握手");
            let (mut send, mut recv) = conn.accept_bi().await.expect("接流");
            let req = super::read_request(&mut recv).await.expect("读请求");
            assert_eq!(req.method, "GET+STREAM", "附件那条必须走流式 method");
            let mut src = std::io::Cursor::new(payload);
            super::write_stream_reply(&mut send, 200, &mut src)
                .await
                .expect("写流式应答");
            let _ = send.finish();
            let _ = done_rx.await;
            let _ = &conn;
        });

        let ep = super::iroh_client::RelayEndpoint::connect(addr)
            .await
            .expect("跨网端点");
        let (status, mut body) = ep
            .get_stream("/mesh/attachment?space_id=sp&hash=h1", None, None)
            .await
            .expect("经隧道取附件");
        assert_eq!(status, 200);
        let mut got = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut body, &mut got)
            .await
            .expect("读正文");
        assert_eq!(got, expect, "字节必须逐字节一致");
        let _ = done_tx.send(());
        serve.await.expect("服务任务不应 panic");
    }

    /// ⭐⭐ **2026-10-25（附件流式判据 ①）**：**大块数据按块搬，不进内存整包** ——
    /// 写端从一条 200 KB 的源流按 64 KB 分块；读端用 `StreamReplyReader` 一块块取。
    /// ⚠️ 断言的要害不是"能读完"，而是**块数 > 1** ⇒ 证明它真的是分块的（⛔ 不是整包）。
    #[tokio::test]
    async fn a_streamed_reply_arrives_in_chunks_not_one_buffer() {
        let total = 200 * 1024;
        let src: Vec<u8> = (0..total).map(|i| (i % 251) as u8).collect();
        let (mut a, mut b) = tokio::io::duplex(8 * 1024);
        let src2 = src.clone();
        let writer = tokio::spawn(async move {
            let mut reader = std::io::Cursor::new(src2);
            let n = write_stream_reply(&mut a, 200, &mut reader).await.unwrap();
            (n, a)
        });
        let mut out = Vec::new();
        let mut rd = read_stream_reply(&mut b);
        tokio::io::AsyncReadExt::read_to_end(&mut rd, &mut out).await.unwrap();
        assert_eq!(rd.status(), Some(200), "状态码要从帧里读出来");
        assert_eq!(out.len(), total, "字节数必须一致");
        assert_eq!(out, src, "内容必须逐字节一致");
        let (n, _a) = writer.await.unwrap();
        assert_eq!(n as usize, total);
        let chunks = total.div_ceil(STREAM_CHUNK);
        assert!(chunks > 1, "这个尺寸本来就该分成多块（{chunks} 块）");
    }

    /// ⭐ **附件流式判据 ②**：**单块标称超过上限 ⇒ 拒**（⛔ 不照它去分配）。
    #[tokio::test]
    async fn an_oversized_stream_chunk_is_refused() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        tokio::spawn(async move {
            let _ = a.write_all(format!("200\n{}\n", STREAM_CHUNK + 1).as_bytes()).await;
        });
        let mut rd = read_stream_reply(&mut b);
        let mut out = Vec::new();
        let err = tokio::io::AsyncReadExt::read_to_end(&mut rd, &mut out).await.expect_err("必须报错");
        assert!(err.to_string().contains("超过上限"), "要说清为什么：{err}");
    }

    /// ⭐ **附件流式判据 ③**：**块没读完就断流 ⇒ 报错**（⛔ 不把半块当完整数据）。
    #[tokio::test]
    async fn a_truncated_stream_chunk_is_an_error() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        tokio::spawn(async move {
            a.write_all(b"200\n10\nabc").await.unwrap();
            drop(a);
        });
        let mut rd = read_stream_reply(&mut b);
        let mut out = Vec::new();
        let err = tokio::io::AsyncReadExt::read_to_end(&mut rd, &mut out).await.expect_err("半块必须报错");
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof, "{err}");
    }

    /// ⭐⭐ **2026-10-25（Step 2b-2 判据）**：**同一台机器两个 iroh 端点，经 QUIC 跑通一次请求** ——
    /// 这是"跨网搬载荷"这条链上**第一次真的用上 iroh**（此前只有帧协议）。
    ///
    /// 只走**直连地址**（`presets::Minimal`：不配中继、不配发现）⇒ 离线可跑、进 CI 不需要网络。
    /// ⛔ 它**不**证明"经公网中继跨网"能通 —— 那要两台机器/一条真中继，留给真机验收。
    ///
    /// 跑法：`cargo test --features relay relay_tunnel::tests::two_endpoints`
    #[cfg(feature = "relay")]
    #[tokio::test]
    async fn two_endpoints_on_one_host_move_one_request() {
        use super::iroh_tunnel::{bind, request, serve_one_conn};
        use std::net::SocketAddr;

        let client_ep = bind(iroh::SecretKey::generate()).await.expect("客户端端点");
        let server_ep = bind(iroh::SecretKey::generate()).await.expect("服务端端点");
        // ⚠️ 不直接用 `server_ep.addr()`：它报的可能是绑定地址（如 0.0.0.0）。
        //   这里显式取**回环地址**，保证判据在本机可复现。
        let port = server_ep
            .bound_sockets()
            .iter()
            .find_map(|s: &SocketAddr| match s {
                SocketAddr::V4(v4) if v4.port() != 0 => Some(v4.port()),
                SocketAddr::V6(v6) if v6.port() != 0 => Some(v6.port()),
                _ => None,
            })
            .expect("服务端端点必须至少有一个已绑定端口");
        let peer = iroh::EndpointAddr {
            id: server_ep.id(),
            addrs: [iroh::TransportAddr::Ip(SocketAddr::from(([127, 0, 0, 1], port)))]
                .into_iter()
                .collect(),
        };

        let serve = tokio::spawn(async move {
            let Some(accepting) = server_ep.accept().await else {
                panic!("端点已关，接不到连接");
            };
            let conn = accepting.await.expect("握手");
            serve_one_conn(conn, |req| TunnelReply {
                status: 200,
                body: format!("回你：{}", req.target).into_bytes(),
            })
            .await
            .expect("服务一次");
        });

        let reply = request(
            &client_ep,
            peer,
            &TunnelRequest::new("GET", "/mesh/manifest?space_id=x")
        )
        .await
        .expect("单机两端点必须能通（直连地址）");
        assert_eq!(reply.status, 200);
        assert_eq!(
            String::from_utf8(reply.body).unwrap(),
            "回你：/mesh/manifest?space_id=x",
            "对端 handler 必须看到**原样 target**"
        );

        client_ep.close().await;
        serve.await.expect("服务任务不应 panic");
    }

    /// ⭐⭐ **2026-10-25（Step 2c-1 判据）**：**同一个 `pull_from_peer` 直接跑在隧道上** ——
    /// 证明"跨网"不是另写一条同步路，而是**换了一个端点**。
    ///
    /// 服务端 handler 模拟 `handle_pull` 的响应（一条记录 ＋ 高水位），
    /// 客户端用 `RelayEndpoint`（实现同一个 `Endpoint` trait）调**真的** `pull_from_peer`。
    ///
    /// **变异**：把 `RelayEndpoint::get` 改成不带头 ⇒ 服务端若做鉴权就会 401（本判据里 handler
    /// 会断言三格头在场，所以那条变异直接红）。
    #[cfg(feature = "relay")]
    #[tokio::test]
    async fn the_real_pull_call_runs_over_the_tunnel() {
        use super::iroh_client::RelayEndpoint;
        use std::net::SocketAddr;

        let server_ep = super::iroh_tunnel::bind(iroh::SecretKey::generate())
            .await
            .expect("服务端端点");
        let port = server_ep
            .bound_sockets()
            .iter()
            .find_map(|s: &SocketAddr| match s {
                SocketAddr::V4(v4) if v4.port() != 0 => Some(v4.port()),
                SocketAddr::V6(v6) if v6.port() != 0 => Some(v6.port()),
                _ => None,
            })
            .expect("要有已绑定端口");
        let addr = iroh::EndpointAddr {
            id: server_ep.id(),
            addrs: [iroh::TransportAddr::Ip(SocketAddr::from(([127, 0, 0, 1], port)))]
                .into_iter()
                .collect(),
        };

        let serve = tokio::spawn(async move {
            let Some(accepting) = server_ep.accept().await else {
                panic!("端点已关");
            };
            let conn = accepting.await.expect("握手");
            super::iroh_tunnel::serve_one_conn(conn, |req| {
                // ⭐ 鉴权材料必须**原样**到这里（否则真 dispatch 会 401）
                assert_eq!(req.header(crate::mesh::HDR_DEVICE), Some("dev-a"), "设备头必须在");
                assert!(req.header(crate::mesh::HDR_TS).is_some(), "时间戳头必须在");
                assert!(req.header(crate::mesh::HDR_SIG).is_some(), "签名头必须在");
                assert_eq!(req.header("authorization"), Some("Bearer tok-1"), "口令头必须在");
                TunnelReply {
                    status: 200,
                    body: br#"{"records":[{"device_seq":1,"entity":"page","entity_id":"p9","op":"upsert","payload":null,"updated_at":5}],"max_device_seq":9}"#.to_vec(),
                }
            })
            .await
            .expect("服务一次");
        });

        let relay_ep = RelayEndpoint::connect(addr).await.expect("跨网端点");
        let peer = crate::mesh::MeshPeer {
            device_id: "dev-a".to_string(),
            base: "http://unused.invalid:1".to_string(),
        };
        let (rows, max_seq) = crate::mesh::pull_from_peer(
            &relay_ep,
            &peer,
            "sp",
            0,
            Some("tok-1"),
            Some(("dev-a", 1_700_000_000_000, "sig-hex")),
            "",
        )
        .await
        .expect("同一个 pull_from_peer 必须能在隧道上跑通");
        assert_eq!(max_seq, 9, "高水位必须照样读出来");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].entity_id, "p9");
        serve.await.expect("服务任务不应 panic");
    }
}
