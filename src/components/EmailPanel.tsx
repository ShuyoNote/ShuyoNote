import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useEmailPanel } from "../store/emailPanel";
import { SendIcon } from "./icons";

type EmailMeta = Awaited<ReturnType<typeof api.emailFetchInbox>>[number];
type EmailAccount = { host: string; port: number; username: string; password: string; use_tls: boolean };

// 聚合收件箱（邮件即笔记）— 桌面专属整页。
// 账号配置在 设置 → 邮箱；这里只读已保存账号、拉取/阅读/转笔记。
export function EmailPanel() {
  const open = useEmailPanel((s) => s.open);
  const toggle = useEmailPanel((s) => s.toggle);
  const closePanel = useEmailPanel((s) => s.closePanel);
  const pageRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const [account, setAccount] = useState<EmailAccount | null>(null);
  const [list, setList] = useState<EmailMeta[]>([]);
  const [raw, setRaw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // 打开时：读已保存账号 → 拉取收件箱。
  useEffect(() => {
    if (!open) return;
    setErr("");
    setBusy(true);
    api
      .emailGetAccount()
      .then((a) => {
        if (!a) {
          setErr("请先在 设置 → 邮箱 配置 IMAP 账号");
          return null;
        }
        setAccount({ host: a.host, port: a.port, username: a.username, password: a.password, use_tls: a.use_tls });
        return api.emailFetchInbox({ host: a.host, port: a.port, username: a.username, password: a.password, use_tls: a.use_tls }).then((r) => {
          setList(r);
          if (r.length === 0) setErr("未拉到邮件（检查账号 / 认证）");
        });
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  }, [open]);

  // 全局快捷键：Ctrl+Shift+E 打开 / Esc 关闭。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "E" || e.key === "e")) {
        e.preventDefault();
        useEmailPanel.getState().openPanel();
      } else if (e.key === "Escape" && useEmailPanel.getState().open) {
        useEmailPanel.getState().closePanel();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // 点击邮箱页外部（侧边栏节点 / 工具栏 关系图·看板·文件夹·页面 / 标题栏）→ 自动关闭。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (pageRef.current?.contains(t)) return; // 页内不动
      if (btnRef.current?.contains(t)) return;  // 邮箱按钮：toggle 处理
      useEmailPanel.getState().closePanel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const refresh = async () => {
    if (!account) return;
    setErr("");
    setBusy(true);
    try {
      const r = await api.emailFetchInbox(account);
      setList(r);
      if (r.length === 0) setErr("未拉到邮件");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveUid = async (uid: number) => {
    if (!account) return;
    setErr("");
    setBusy(true);
    try {
      await api.emailSaveUid(account, uid);
      setErr("已存为笔记 ✓");
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

  return (
    <>
      {/* 侧栏入口：图标 + 文字，与「同步」一致；tooltip 提示快捷键。 */}
      <button ref={btnRef} className="btn-sync" onClick={toggle} title="邮箱（聚合收件箱） · Ctrl+Shift+E">
        <SendIcon width={14} height={14} />
        <span>邮箱</span>
      </button>

      {open &&
        createPortal(
          <div ref={pageRef} className="email-page" role="dialog" aria-label="邮箱">
            <header className="email-page-head">
              <div className="email-page-title">
                <div>邮箱</div>
                <div className="email-page-sub">聚合收件箱 · 邮件即笔记（桌面版）</div>
              </div>
              <div className="email-page-actions">
                <button className="sync-btn primary" disabled={busy || !account} onClick={() => void refresh()}>
                  拉取收件箱
                </button>
                <button className="sync-btn ghost" onClick={closePanel} aria-label="关闭">✕</button>
              </div>
            </header>

            <div className="email-page-body">
              {!account && <div className="email-page-empty">请先在 <b>设置 → 邮箱</b> 配置 IMAP 账号。</div>}

              {list.length > 0 && (
                <div className="email-list">
                  <div className="email-list-head">
                    <span className="email-list-title">收件箱（最近 {list.length} 封）</span>
                  </div>
                  {list.map((m, i) => (
                    <div key={i} className="email-item">
                      <span className="email-item-badge" aria-hidden>✉</span>
                      <div className="email-item-main">
                        <div className="email-item-title" title={m.subject}>{m.subject || "(无主题)"}</div>
                        <div className="email-item-meta">
                          <span className="email-item-from" title={m.from}>{m.from}</span>
                          <span className="email-item-date" title={m.date}>{m.date}</span>
                        </div>
                      </div>
                      <button className="sync-btn" disabled={busy} onClick={() => void saveUid(m.uid)}>存为笔记</button>
                    </div>
                  ))}
                </div>
              )}

              <div className="email-paste">
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

              {err && <div className="sync-status is-progress is-err"><div className="sync-status-text">{err}</div></div>}
            </div>
          </div>,
          document.querySelector(".main") ?? document.body,
        )}
    </>
  );
}
