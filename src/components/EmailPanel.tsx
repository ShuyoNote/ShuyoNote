import { useEffect, useState } from "react";
import { usePopover } from "../hooks/usePopover";
import { api } from "../lib/api";
import { SendIcon } from "./icons";

type EmailMeta = Awaited<ReturnType<typeof api.emailFetchInbox>>[number];

// 聚合邮箱（邮件即笔记）— 桌面专属。Web 调 email_* 会抛「仅桌面版」。
export function EmailPanel() {
  const { open, pos, triggerRef, contentRef, toggle } = usePopover<HTMLButtonElement>({
    width: 430,
    minSpace: 420,
  });

  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [useTls, setUseTls] = useState(true);
  const [list, setList] = useState<EmailMeta[]>([]);
  const [raw, setRaw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // 打开时回填已保存的 IMAP 账号配置。
  useEffect(() => {
    api
      .emailGetAccount()
      .then((a) => {
        if (a) {
          setHost(a.host);
          setPort(String(a.port));
          setUser(a.username);
          setPass(a.password);
          setUseTls(a.use_tls);
        }
      })
      .catch(() => { /* 尚未配置 / 桌面版才有，忽略 */ });
  }, []);

  const account = () => ({ host, port: Number(port) || 993, username: user, password: pass, use_tls: useTls });

  const saveConfig = async () => {
    if (!host) return;
    setErr("");
    try {
      await api.emailSaveAccount(account());
      setErr("配置已保存 ✓");
    } catch (e) {
      setErr(String(e));
    }
  };

  const fetchInbox = async () => {
    setErr("");
    setBusy(true);
    try {
      const r = await api.emailFetchInbox(account());
      setList(r);
      if (r.length === 0) setErr("未拉到邮件（检查账号 / 认证）");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveRaw = async () => {
    if (!raw.trim()) return;
    setErr("");
    setBusy(true);
    try {
      await api.emailSaveAsNote(raw);
      setRaw("");
      setErr("已存为笔记 ✓");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveUid = async (uid: number) => {
    setErr("");
    setBusy(true);
    try {
      await api.emailSaveUid(account(), uid);
      setErr("已存为笔记 ✓");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button ref={triggerRef} className="btn-sync" onClick={toggle} title="邮箱 · 聚合收件箱">
        <SendIcon width={14} height={14} />
        <span>邮箱</span>
      </button>

      {open && (
        <div
          ref={contentRef}
          className="sync-popover"
          style={{ top: pos.top, left: pos.left, width: 430 }}
        >
          <header className="sync-head">
            <div className="sync-head-text">
              <div className="sync-title">邮箱</div>
              <div className="sync-subtitle">聚合收件箱 · 邮件即笔记（桌面版）</div>
            </div>
          </header>

          <div className="sync-profiles">
            <div className="sync-field">
              <label className="sync-hint">IMAP 账号（应用密码 / 企业 IMAP）</label>
              <input className="sync-input" placeholder="imap.example.com" value={host} onChange={(e) => setHost(e.target.value)} />
              <div className="sync-auth-grid">
                <input className="sync-input" placeholder="端口 993" value={port} onChange={(e) => setPort(e.target.value)} />
                <label className="sync-hint" style={{ alignSelf: "center" }}>
                  <input type="checkbox" checked={useTls} onChange={(e) => setUseTls(e.target.checked)} /> TLS
                </label>
              </div>
              <input className="sync-input" placeholder="邮箱 / 账号" value={user} onChange={(e) => setUser(e.target.value)} />
              <input className="sync-input" type="password" placeholder="密码 / 应用密码" value={pass} onChange={(e) => setPass(e.target.value)} />
              <button className="sync-btn primary" disabled={busy || !host || !user} onClick={() => void fetchInbox()}>
                拉取收件箱
              </button>
              <button className="sync-btn" disabled={!host} onClick={() => void saveConfig()}>
                保存配置
              </button>
            </div>

            {list.length > 0 && (
              <div className="sync-history-list" style={{ marginTop: 8 }}>
                {list.map((m, i) => (
                  <div key={i} className="sync-history-item">
                    <span className={`sync-history-status${m.subject ? " is-ok" : ""}`} aria-hidden>✉</span>
                    <div className="sync-history-main">
                      <div className="sync-history-title">
                        <span className="sync-history-at" title={m.date}>{m.date}</span>
                        <span>{m.subject || "(无主题)"}</span>
                      </div>
                      <div className="sync-history-msg">{m.from}</div>
                    </div>
                    <button className="sync-btn" disabled={busy} onClick={() => void saveUid(m.uid)}>存为笔记</button>
                  </div>
                ))}
              </div>
            )}

            <div className="sync-field" style={{ marginTop: 10 }}>
              <label className="sync-hint">粘贴原始邮件（RFC822）→ 存为笔记</label>
              <textarea
                className="sync-input"
                rows={3}
                placeholder={"From: a@x.com\nSubject: 你好\n\n正文…"}
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
              />
              <button className="sync-btn" disabled={busy || !raw.trim()} onClick={() => void saveRaw()}>
                存为笔记
              </button>
            </div>

            {err && (
              <div className="sync-status is-progress is-err">
                <div className="sync-status-text">{err}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
