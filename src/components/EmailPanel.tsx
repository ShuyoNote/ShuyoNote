import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useEmailPanel } from "../store/emailPanel";
import { InboxIcon, SendIcon, RefreshIcon, TrashIcon } from "./icons";

type EmailMeta = Awaited<ReturnType<typeof api.emailFetchInbox>>[number];
type EmailAccount = { host: string; port: number; username: string; password: string; use_tls: boolean };
type Section = { label: string; items: EmailMeta[] };

const AVATAR_COLORS = ["#4f7cff", "#7b61ff", "#2f9e67", "#e0a13a", "#d05b8b", "#1591b0", "#c2493b", "#8a6fde"];

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function fmtListTime(m: EmailMeta): string {
  const d = parseDate(m.date);
  if (!d) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const k = dayKey(d);
  if (k === dayKey(today)) return d.toTimeString().slice(0, 5);
  if (k === dayKey(yesterday)) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 分组：今天 / 上周（近7天，不含今昨） / 更早。
function groupEmails(list: EmailMeta[]): Section[] {
  const secs: Section[] = [];
  const map = new Map<string, Section>();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  for (const m of list) {
    const d = parseDate(m.date);
    let label: string;
    if (!d || d < weekAgo) label = "更早";
    else if (d >= today) label = "今天";
    else if (d >= yesterday) label = "昨天";
    else label = "上周";
    let sec = map.get(label);
    if (!sec) {
      sec = { label, items: [] };
      map.set(label, sec);
      secs.push(sec);
    }
    sec.items.push(m);
  }
  return secs;
}

// 聚合收件箱（邮件即笔记）— 桌面专属整页（左列表 + 右阅读），竖分隔线可拖动调整宽度。
// 账号配置在 设置 → 邮箱；这里只读已保存账号、拉取/阅读/转笔记。
export function EmailPanel() {
  const open = useEmailPanel((s) => s.open);
  const toggle = useEmailPanel((s) => s.toggle);
  const closePanel = useEmailPanel((s) => s.closePanel);
  const pageRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const [account, setAccount] = useState<EmailAccount | null>(null);
  const [list, setList] = useState<EmailMeta[]>([]);
  const [active, setActive] = useState<EmailMeta | null>(null);
  const [body, setBody] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingBody, setLoadingBody] = useState(false);
  const [listW, setListW] = useState(360);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [starred, setStarred] = useState<Set<number>>(new Set());

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
    setActive(m);
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

  const toggleChecked = (uid: number) => {
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });
  };

  const toggleStarred = (uid: number) => {
    setStarred((prev) => {
      const n = new Set(prev);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });
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

  // 拖动竖分隔线调整列表宽度。
  const onDividerDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: listW };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d || !splitRef.current) return;
      const maxW = splitRef.current.getBoundingClientRect().width - 320;
      const w = Math.max(280, Math.min(d.startW + (ev.clientX - d.startX), Math.max(280, maxW)));
      setListW(w);
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const sections = groupEmails(list);

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
                <button className="sync-btn primary" disabled={busy || !active} onClick={() => active && void saveUid(active.uid)}>
                  <SendIcon width={14} height={14} /> 存为笔记
                </button>
                <button className="sync-btn ghost" disabled={busy || !account} onClick={() => void refresh()}>
                  <RefreshIcon width={14} height={14} /> 拉取
                </button>
                <button className="sync-btn ghost" onClick={closePanel} aria-label="关闭">✕</button>
              </div>
            </header>

            <div className="email-page-body">
              {!account && (
                <div className="email-page-empty">请先在 <b>设置 → 邮箱</b> 配置 IMAP 账号。</div>
              )}

              {account && (
                <div className="email-split" ref={splitRef}>
                  <div className="email-pane-list" style={{ width: listW }}>
                    <div className="email-list-head">
                      <span className="email-list-head-title">邮件</span>
                      <span className="email-list-head-count">共 {list.length} 封</span>
                    </div>
                    <div className="email-col-head">
                      <span className="email-col-check" aria-hidden />
                      <span className="email-col-from">发件人</span>
                      <span className="email-col-subject">主题</span>
                      <span className="email-col-date">日期</span>
                      <span className="email-col-star" aria-hidden />
                    </div>
                    {list.length === 0 && <div className="email-page-empty">暂无邮件，点「拉取收件箱」。</div>}
                    {sections.map((s) => (
                      <div key={s.label} className="email-section">
                        <div className="email-section-label">{s.label}（{s.items.length}封）</div>
                        {s.items.map((m) => (
                          <div
                            key={m.uid}
                            className={`email-item${active?.uid === m.uid ? " is-selected" : ""}`}
                            onClick={() => void selectEmail(m)}
                          >
                            <span
                              className={`email-check${checked.has(m.uid) ? " is-checked" : ""}`}
                              role="checkbox"
                              aria-checked={checked.has(m.uid)}
                              tabIndex={-1}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleChecked(m.uid);
                              }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            </span>
                            <span className="email-item-from" title={m.from}>{m.from}</span>
                            <span className="email-item-subject" title={m.subject}>{m.subject || "(无主题)"}</span>
                            <span className="email-item-date">{fmtListTime(m)}</span>
                            <span
                              className={`email-item-star${starred.has(m.uid) ? " is-starred" : ""}`}
                              role="button"
                              tabIndex={-1}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleStarred(m.uid);
                              }}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
                              </svg>
                            </span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>

                  <div className="email-divider" role="separator" aria-orientation="vertical" onMouseDown={onDividerDown}>
                    <span className="email-divider-grip" aria-hidden>⋮⋮</span>
                  </div>

                  <div className="email-pane-read">
                    <div className="email-read-toolbar">
                      <button className="sync-btn ghost" disabled title="回复">
                        <SendIcon width={14} height={14} /> 回复
                      </button>
                      <button className="sync-btn ghost" disabled title="转发">
                        <SendIcon width={14} height={14} /> 转发
                      </button>
                      <button className="sync-btn ghost" disabled title="删除">
                        <TrashIcon width={14} height={14} /> 删除
                      </button>
                      <span className="email-read-toolbar-spacer" />
                      <button className="sync-btn ghost" disabled title="更多操作">更多操作</button>
                    </div>
                    {active ? (
                      <>
                        <div className="email-read-subject">{active.subject || "(无主题)"}</div>
                        <div className="email-read-meta">
                          <span className="email-read-meta-avatar" aria-hidden>
                            <span className="email-read-meta-avatar-inner" style={{ background: avatarColor(active.from) }}>
                              {(active.from.trim().charAt(0) || "?").toUpperCase()}
                            </span>
                          </span>
                          <span className="email-read-meta-main">
                            <span className="email-read-meta-from">{active.from}</span>
                            <span className="email-read-meta-sub">
                              <span>收件人：{account.username}</span>
                              <span>{active.date}</span>
                              <span>邮件类型：收件箱</span>
                            </span>
                          </span>
                          <button
                            className="sync-btn primary"
                            disabled={busy}
                            onClick={() => active && void saveUid(active.uid)}
                          >
                            存为笔记
                          </button>
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
