import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useEmailPanel } from "../store/emailPanel";
import { InboxIcon } from "./icons";

type EmailMeta = Awaited<ReturnType<typeof api.emailFetchInbox>>[number];
type EmailAccount = { host: string; port: number; username: string; password: string; use_tls: boolean };

// 聚合收件箱（邮件即笔记）— 桌面专属整页（两栏：左列表 + 右阅读）。
// 账号配置在 设置 → 邮箱；这里只读已保存账号、拉取/阅读/转笔记。
export function EmailPanel() {
  const open = useEmailPanel((s) => s.open);
  const toggle = useEmailPanel((s) => s.toggle);
  const closePanel = useEmailPanel((s) => s.closePanel);
  const pageRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const [account, setAccount] = useState<EmailAccount | null>(null);
  const [list, setList] = useState<EmailMeta[]>([]);
  const [selected, setSelected] = useState<EmailMeta | null>(null);
  const [body, setBody] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingBody, setLoadingBody] = useState(false);

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
        const acc = { host: a.host, port: a.port, username: a.username, password: a.password, use_tls: a.use_tls };
        setAccount(acc);
        return api.emailFetchInbox(acc).then((r) => {
          setList(r);
          if (r.length > 0) void selectEmail(r[0], acc);
          else setErr("未拉到邮件（检查账号 / 认证）");
        });
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectEmail = async (m: EmailMeta, acc: EmailAccount = account!) => {
    setSelected(m);
    setLoadingBody(true);
    setErr("");
    try {
      const bodyText = await api.emailGetBody(acc, m.uid);
      setBody(bodyText);
    } catch (e) {
      setErr(String(e));
      setBody("");
    } finally {
      setLoadingBody(false);
    }
  };

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

  // 点击邮箱页外部（侧边栏节点 / 工具栏 / 标题栏）→ 自动关闭。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (pageRef.current?.contains(t)) return;
      if (btnRef.current?.contains(t)) return;
      useEmailPanel.getState().closePanel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <>
      <button ref={btnRef} className="btn-sync" onClick={toggle} title="邮箱（聚合收件箱） · Ctrl+Shift+E">
        <InboxIcon width={14} height={14} />
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
              {!account && (
                <div className="email-page-empty">请先在 <b>设置 → 邮箱</b> 配置 IMAP 账号。</div>
              )}

              {account && (
                <div className="email-split">
                  <div className="email-pane-list">
                    <div className="email-list-head">收件箱 · {list.length} 封</div>
                    {list.length === 0 && <div className="email-page-empty">暂无邮件，点「拉取收件箱」。</div>}
                    {list.map((m, i) => (
                      <button
                        key={i}
                        className={`email-item${selected?.uid === m.uid ? " is-selected" : ""}`}
                        onClick={() => void selectEmail(m)}
                      >
                        <span className="email-item-badge" aria-hidden>✉</span>
                        <span className="email-item-main">
                          <span className="email-item-title" title={m.subject}>{m.subject || "(无主题)"}</span>
                          <span className="email-item-meta">
                            <span className="email-item-from" title={m.from}>{m.from}</span>
                            <span className="email-item-date">{m.date}</span>
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className="email-pane-read">
                    <div className="email-read-toolbar">
                      <button className="sync-btn primary" disabled={busy || !selected} onClick={() => selected && void saveUid(selected.uid)}>
                        存为笔记
                      </button>
                    </div>
                    {selected ? (
                      <>
                        <div className="email-read-subject">{selected.subject || "(无主题)"}</div>
                        <div className="email-read-meta">
                          <span>发件人：{selected.from}</span>
                          <span>{selected.date}</span>
                        </div>
                        <div className="email-read-body">
                          {loadingBody ? "加载正文…" : body || "（正文为空）"}
                        </div>
                      </>
                    ) : (
                      <div className="email-page-empty">在左侧选择一封邮件阅读。</div>
                    )}
                  </div>
                </div>
              )}

              {err && <div className="sync-status is-progress is-err"><div className="sync-status-text">{err}</div></div>}
            </div>
          </div>,
          document.querySelector(".main") ?? document.body,
        )}
    </>
  );
}
