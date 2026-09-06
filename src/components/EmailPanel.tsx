import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import { createPortal } from "react-dom";
import { api, type EmailAccount, type EmailMeta } from "../lib/api";
import { platform } from "../lib/platform";
import { useEmailPanel } from "../store/emailPanel";
import { useEditorStore } from "../store/editor";
import { InboxIcon, SendIcon, RefreshIcon, TrashIcon, SettingsIcon, BookmarkIcon } from "./icons";

type Section = { label: string; items: EmailMeta[] };

const AVATAR_COLORS = ["#4f7cff", "#7b61ff", "#2f9e67", "#e0a13a", "#d05b8b", "#1591b0", "#c2493b", "#8a6fde"];

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// 从账号（邮箱地址）提取服务商短标注：取 @ 后的域名首段，如 zhaizy@qq.com → "qq"。
function providerLabel(username: string): string {
  const at = username.lastIndexOf("@");
  if (at < 0) return "";
  const domain = username.slice(at + 1).trim().toLowerCase();
  if (!domain) return "";
  return domain.split(".")[0] || domain;
}

// 从 "姓名 <a@b.com>" 形式提取裸邮箱地址。
function stripEmail(v: string): string {
  const m = v.match(/<([^>]+)>/);
  return m ? m[1].trim() : v.trim();
}

// 把后端返回的账号对象补全成完整 EmailAccount（含 SMTP 字段）。
function toAccount(a: EmailAccount): EmailAccount {
  return {
    host: a.host,
    port: a.port,
    username: a.username,
    password: a.password,
    use_tls: a.use_tls,
    auto_fetch: a.auto_fetch,
    interval_minutes: a.interval_minutes,
    smtp_host: a.smtp_host,
    smtp_port: a.smtp_port,
    smtp_security: a.smtp_security,
    smtp_user: a.smtp_user,
    smtp_pass: a.smtp_pass,
  };
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

// 文件夹显示名：把常见的英文 IMAP 文件夹名映射成中文，其余保留原始名。
// IMAP 标准特殊用途文件夹名（INBOX 及各 Inbox/Sent/Drafts/Trash/Junk 等大小写变体）。
const FOLDER_ZH: Record<string, string> = {
  inbox: "收件箱",
  "deleted messages": "已删除",
  "deleted items": "已删除",
  trash: "已删除",
  drafts: "草稿",
  draft: "草稿",
  junk: "垃圾邮件",
  spam: "垃圾邮件",
  "junk email": "垃圾邮件",
  "sent messages": "已发送",
  "sent items": "已发送",
  sent: "已发送",
  "spam folder": "垃圾邮件",
  "archive": "归档",
  "starred": "已加星标",
  "important": "重要",
};
function folderDisplay(name: string): string {
  const key = name.trim().toLowerCase();
  return FOLDER_ZH[key] ?? name;
}

// 用 DOMPurify 白名单消毒邮件 HTML（去 script/iframe/事件属性/javascript: 协议等），
// 并默认屏蔽远程图片（把 <img src> 移走、留下占位，点击「显示图片」才恢复）。
function sanitizeEmailHtml(html: string, showImages: boolean): string {
  const config = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["iframe", "script", "object", "embed", "form", "input", "style", "link", "meta", "base", "svg", "math"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "formaction", "xlink:href", "srcset"],
    ADD_ATTR: ["target", "rel"],
    ALLOW_DATA_ATTR: false,
  };
  // 消毒后强制链接新开 + noreferrer（防 opener 泄露 / 追踪）。
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noreferrer noopener");
    }
  });
  let clean = DOMPurify.sanitize(html, config);
  DOMPurify.removeHook("afterSanitizeAttributes");
  if (!showImages) {
    // 屏蔽远程图片：给 <img> 移除 src，仅留 alt 占位。
    const imgRe = /<img\b[^>]*>/gi;
    clean = clean.replace(imgRe, (tag) => {
      // 保留 alt 文字，去掉 src/onerror 等。
      const alt = /alt=["']([^"']*)["']/.exec(tag)?.[1] ?? "";
      return `<span class="email-img-placeholder" title="点击显示图片">[图片${alt ? "：" + alt : ""}]</span>`;
    });
    // 移除背景图/样式里的 url()（追踪/泄露风险）。
    clean = clean.replace(/url\s*\(\s*["']?[^"')]+["']?\s*\)/gi, "");
  }
  return clean;
}

// 把正文纯文本渲染成可读视图：段落 + 引用块 + 行内加粗(**text**) + 可点链接。
function EmailBody({ text }: { text: string }) {
  // 按连续空行分段；每段再按行归为段落或引用。
  const rawParas = text
    .split(/\n{2,}/)
    .map((s) => s.replace(/\r/g, "").trim())
    .filter(Boolean);

  interface Block { type: "para" | "quote"; lines: string[] }
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const para of rawParas) {
    const lines = para.split("\n");
    const isQuote = lines.some((l) => /^[>|　]/.test(l.trimStart()));
    const type: "para" | "quote" = isQuote ? "quote" : "para";
    if (!cur || cur.type !== type) {
      if (cur) blocks.push(cur);
      cur = { type, lines: [] };
    }
    for (const l of lines) {
      const line = l.trim();
      if (line) cur.lines.push(line.replace(/^[>|　]+\s*/, ""));
    }
  }
  if (cur) blocks.push(cur);

  const urlRe = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;
  const boldRe = /\*\*(.+?)\*\*/g;
  // 行内渲染：先识别 **粗体**，再在其中识别链接。
  const renderInline = (s: string, key: string): ReactNode[] => {
    const out: ReactNode[] = [];
    let last = 0;
    for (const bm of s.matchAll(boldRe)) {
      const idx = bm.index ?? 0;
      if (idx > last) out.push(renderLinks(s.slice(last, idx), `${key}-b${idx}`));
      out.push(<strong key={`${key}-bold${idx}`}>{renderLinks(bm[1], `${key}-bw${idx}`)}</strong>);
      last = idx + bm[0].length;
    }
    if (last < s.length) out.push(renderLinks(s.slice(last), `${key}-t${last}`));
    return out;
  };

  const renderLinks = (s: string, key: string): ReactNode[] => {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const m of s.matchAll(urlRe)) {
      const idx = m.index ?? 0;
      if (idx > last) parts.push(s.slice(last, idx));
      const url = m[0];
      const href = url.startsWith("http") ? url : `https://${url}`;
      parts.push(
        <a key={`${key}u${idx}`} href={href} target="_blank" rel="noreferrer" className="email-body-link">
          {url}
        </a>,
      );
      last = idx + url.length;
    }
    if (last < s.length) parts.push(s.slice(last));
    return parts;
  };

  return (
    <div className="email-body">
      {blocks.map((b, i) =>
        b.type === "quote" ? (
          <blockquote key={i} className="email-body-quote">
            {b.lines.map((l, j) => (
              <p key={j}>{renderInline(l, `${i}-${j}`)}</p>
            ))}
          </blockquote>
        ) : (
          <p key={i} className="email-body-para">{renderInline(b.lines.join("\n"), String(i))}</p>
        ),
      )}
    </div>
  );
}

// 富文本正文：经 DOMPurify 消毒后渲染，链接新开、图片按 showImages 屏蔽占位。
function EmailRichBody({ html, showImages }: { html: string; showImages: boolean }) {
  const clean = useMemo(() => sanitizeEmailHtml(html, showImages), [html, showImages]);
  return (
    <div
      className="email-rich-body"
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
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

const MONTH_NAMES = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

// 一封邮件的 (年, 月) 键：`YYYY-M`（0-based 月）。无法解析返回 null。
function monthKeyOf(m: EmailMeta): string | null {
  const d = parseDate(m.date);
  if (!d) return null;
  return `${d.getFullYear()}-${d.getMonth()}`;
}

// 聚合收件箱（邮件即笔记）— 桌面专属整页（左列表 + 右阅读），竖分隔线可拖动调整宽度。
// 账号配置在 设置 → 邮箱；这里只读已保存账号、拉取/阅读/转笔记。
export function EmailPanel() {
  const open = useEmailPanel((s) => s.open);
  const unread = useEmailPanel((s) => s.unread);
  const setUnread = useEmailPanel((s) => s.setUnread);
  const toggle = useEmailPanel((s) => s.toggle);
  const closePanel = useEmailPanel((s) => s.closePanel);
  const pageRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const listScrollRef = useRef<HTMLDivElement>(null);

  const [account, setAccount] = useState<EmailAccount | null>(null);
  const [list, setList] = useState<EmailMeta[]>([]);
  const [active, setActive] = useState<EmailMeta | null>(null);
  const [body, setBody] = useState("");
  const [html, setHtml] = useState("");
  const [useRich, setUseRich] = useState(true);
  const [showImages, setShowImages] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingBody, setLoadingBody] = useState(false);
  const [listW, setListW] = useState<number>(() => Math.round(window.innerWidth * 0.3));
  // 列表列宽：发件人/主题 可通过列表头拖拽调节；主题列弹性适应左栏宽度。
  const [fromW, setFromW] = useState(110);
  const [subjectW, setSubjectW] = useState(160);
  const resizeRef = useRef<{ startX: number; startW: number; col: "from" | "subject" } | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState<number>(new Date().getFullYear());
  const pickerRef = useRef<HTMLDivElement>(null);
  // 发信（回复/转发）撰写弹窗。
  const [compose, setCompose] = useState<{ mode: "reply" | "forward"; to: string; subject: string; body: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [folders, setFolders] = useState<string[]>(["INBOX"]);
  const [allFolders, setAllFolders] = useState<string[]>([]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  // 过滤：发件人多选下拉 + 标题关键字（数据库视图同款：空格=与、逗号=或）。纯前端内存过滤。
  const [senderSet, setSenderSet] = useState<Set<string>>(new Set());
  const [senderSearch, setSenderSearch] = useState("");
  const [senderPickerOpen, setSenderPickerOpen] = useState(false);
  const senderPickerRef = useRef<HTMLDivElement>(null);
  const [subjectFilter, setSubjectFilter] = useState("");

  // 当前列表里的去重发件人（供下拉选项）。
  const senders = useMemo(() => [...new Set(list.map((m) => m.from))].sort((a, b) => a.localeCompare(b, "zh")), [list]);

  // 标题过滤：逗号=或(OR)组，组内空格=与(AND)，与数据库视图一致。
  const subjectGroups = useMemo(() => {
    const key = subjectFilter.trim().toLowerCase();
    if (!key) return [];
    return key
      .split(/[，,]/)
      .map((g) => g.split(/\s+/).filter(Boolean))
      .filter((g) => g.length);
  }, [subjectFilter]);

  const filteredList = useMemo(() => {
    const senderMatch = (m: EmailMeta) => senderSet.size === 0 || senderSet.has(m.from);
    const subjectMatch = (m: EmailMeta) => {
      if (subjectGroups.length === 0) return true;
      const t = m.subject.toLowerCase();
      return subjectGroups.some((g) => g.every((k) => t.includes(k)));
    };
    return list.filter((m) => senderMatch(m) && subjectMatch(m));
  }, [list, senderSet, subjectGroups]);

  const toggleSender = (from: string) => {
    setSenderSet((prev) => {
      const n = new Set(prev);
      if (n.has(from)) n.delete(from);
      else n.add(from);
      return n;
    });
  };

  const clearSenders = () => setSenderSet(new Set());

  // 每封邮件 → 其所在 (年,月)，并给每个月记录最新一封（列表顶部的第一封）。
  const monthIndex = useMemo(() => {
    const firstUid = new Map<string, number>();
    const years = new Set<number>();
    for (const m of list) {
      const k = monthKeyOf(m);
      if (!k) continue;
      const y = Number(k.split("-")[0]);
      years.add(y);
      if (!firstUid.has(k)) firstUid.set(k, m.uid);
    }
    const ys = [...years].sort((a, b) => b - a); // 倒序，最新年份在前
    return { firstUid, years: ys };
  }, [list]);

  // 打开时默认左右均分：把列表宽度设为分栏容器的一半。
  useEffect(() => {
    if (!open) return;
    const el = splitRef.current;
    if (el) {
      const w = Math.round(el.getBoundingClientRect().width / 2);
      if (w > 240) setListW(w);
    }
  }, [open]);

  // 挂载时读一次已保存账号（供角标/定时收取用；不依赖面板是否打开）。
  useEffect(() => {
    api
      .emailGetAccount()
      .then((a) => {
        if (a) setAccount(toAccount(a));
      })
      .catch(() => {});
  }, []);

  // 账号可用后列出所有文件夹，并保证默认选「收件箱」。
  useEffect(() => {
    if (!account) return;
    api
      .emailListFolders(account)
      .then((fs) => {
        const list = fs.length ? fs : ["INBOX"];
        setAllFolders(list);
        setFolders((prev) => (prev.some((f) => list.includes(f)) ? prev : ["INBOX"]));
      })
      .catch(() => setAllFolders(["INBOX"]));
  }, [account]);

  // 打开时：用已保存账号拉取收件箱；顺带根据 `seen` 刷新未读角标。
  useEffect(() => {
    if (!open) return;
    setErr("");
    if (!account) {
      api
        .emailGetAccount()
        .then((a) => {
          if (!a) {
            setErr("请先在 设置 → 邮箱 配置 IMAP 账号");
            return;
          }
          const acc = toAccount(a);
          setAccount(acc);
          void fetchInbox(acc);
        })
        .catch((e) => setErr(String(e)));
      return;
    }
    void fetchInbox(account);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fetchInbox = async (acc: EmailAccount = account!, fs: string[] = folders) => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.emailFetchInbox(acc, fs);
      const newestFirst = [...r].reverse();
      setList(newestFirst);
      setUnread(newestFirst.filter((m) => !m.seen).length);
      if (newestFirst.length === 0) {
        setErr("未拉到邮件（检查账号 / 认证）");
      } else if (newestFirst.some((m) => m.uid === active?.uid)) {
        // 保持当前阅读的邮件选中，不打扰。
      } else {
        void selectEmail(newestFirst[0], acc);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectEmail = async (m: EmailMeta, acc: EmailAccount = account!) => {
    setActive(m);
    setLoadingBody(true);
    setErr("");
    setShowImages(false);
    try {
      // 超时保护：避免正文拉取卡住导致无限“加载正文…”。
      const [bodyText, htmlText] = await Promise.all([
        api.emailGetBody(acc, m.uid, m.folder),
        api.emailGetHtml(acc, m.uid, m.folder).catch(() => ""),
      ]);
      setBody(bodyText);
      setHtml(htmlText);
    } catch (e) {
      setErr(String(e));
      setBody("");
      setHtml("");
    } finally {
      setLoadingBody(false);
    }
  };

  const refresh = async () => {    if (!account) return;
    await fetchInbox(account, folders);
  };

  const saveUid = async (uid: number) => {
    if (!account || !active) return;
    setErr("");
    setBusy(true);
    try {
      await api.emailSaveUid(account, uid, active.folder);
      setErr("已存为笔记 ✓");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 定时收取：Rust 后台按 interval_minutes 轮询未读数，通过 `email-unread` 事件或
  // 即时拉取更新侧边栏角标。轮询次数控制放在后端（WebView 最小化会节流 JS timer），
  // 前端只负责接收事件 + 打开面板时同步一次角标。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    platform.event
      .listen<number>("email-unread", (e) => setUnread(e.payload))
      .then((off) => {
        unlisten = off;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, [setUnread]);

  // 打开面板时同步一次当前未读数（不等下一次轮询）。
  useEffect(() => {
    if (!account?.auto_fetch || !open) return;
    api
      .emailUnseenCount(account)
      .then((n) => setUnread(n))
      .catch(() => {});
  }, [account, open, setUnread]);

  const toggleChecked = (uid: number) => {
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(uid)) n.delete(uid);
      else n.add(uid);
      return n;
    });
  };

  const toggleStarred = async (m: EmailMeta) => {
    if (!account) return;
    const next = !m.flagged;
    // 乐观更新列表里的星标状态。
    setList((prev) => prev.map((x) => (x.uid === m.uid ? { ...x, flagged: next } : x)));
    try {
      await api.emailSetFlag(account, m.uid, m.folder, next);
    } catch (e) {
      setErr(String(e));
      // 失败回滚。
      setList((prev) => prev.map((x) => (x.uid === m.uid ? { ...x, flagged: m.flagged } : x)));
    }
  };

  const markRead = async (m: EmailMeta, read: boolean) => {
    if (!account) return;
    const updated = list.map((x) => (x.uid === m.uid ? { ...x, seen: read } : x));
    setList(updated);
    setUnread(updated.filter((x) => !x.seen).length);
    try {
      await api.emailMarkRead(account, m.uid, m.folder, read);
    } catch (e) {
      setErr(String(e));
      const rolled = list.map((x) => (x.uid === m.uid ? { ...x, seen: m.seen } : x));
      setList(rolled);
      setUnread(rolled.filter((x) => !x.seen).length);
    }
  };

  const deleteEmail = async (m: EmailMeta) => {
    if (!account) return;
    setErr("");
    setBusy(true);
    try {
      await api.emailMoveToTrash(account, m.uid, m.folder);
      setList((prev) => prev.filter((x) => x.uid !== m.uid));
      if (active?.uid === m.uid) {
        setActive(null);
        setBody("");
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 批量删除选中的邮件（勾选框选中），按文件夹分组分别调用后端。
  const deleteSelected = async () => {
    if (!account || checked.size === 0) return;
    const target = list.filter((m) => checked.has(m.uid));
    if (target.length === 0) return;
    if (!window.confirm(`确定把选中的 ${target.length} 封邮件移到已删除？`)) return;
    setErr("");
    setBusy(true);
    try {
      // 按文件夹分组，每组一次连接。
      const byFolder = new Map<string, number[]>();
      for (const m of target) {
        const arr = byFolder.get(m.folder) ?? [];
        arr.push(m.uid);
        byFolder.set(m.folder, arr);
      }
      let moved = 0;
      for (const [folder, uids] of byFolder) {
        moved += await api.emailMoveManyToTrash(account, uids, folder);
      }
      setList((prev) => prev.filter((x) => !checked.has(x.uid)));
      setChecked(new Set());
      if (active && checked.has(active.uid)) {
        setActive(null);
        setBody("");
      }
      setErr(`已删除 ${moved} 封 ✓`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 打开回复/转发撰写弹窗：预填收件人与主题，正文带上引用。
  const openCompose = (mode: "reply" | "forward") => {
    if (!active) return;
    const fwd = mode === "forward";
    const subject = fwd
      ? (active.subject.startsWith("Fwd:") || active.subject.startsWith("Fw:") ? active.subject : `Fwd: ${active.subject}`)
      : (active.subject.startsWith("Re:") ? active.subject : `Re: ${active.subject}`);
    const quoted = `${active.subject}\n${active.from}\n${active.date}\n\n${"─".repeat(40)}\n\n${body}`;
    setCompose({
      mode,
      to: fwd ? "" : stripEmail(active.from),
      subject,
      body: fwd ? `\n\n${quoted}` : `\n\n${quoted}`,
    });
  };

  const sendCompose = async () => {
    if (!account || !compose) return;
    if (!compose.to.trim()) {
      setErr("收件人不能为空");
      return;
    }
    setSending(true);
    setErr("");
    try {
      await api.emailSend(account, compose.to.trim(), compose.subject || "(无主题)", compose.body);
      setCompose(null);
      setErr("邮件已发送 ✓");
    } catch (e) {
      setErr(String(e));
    } finally {
      setSending(false);
    }
  };

  // 月份选择：跳到该月最新一封邮件（列表顶部）。
  const scrollToMonth = (year: number, month0: number) => {
    const uid = monthIndex.firstUid.get(`${year}-${month0}`);
    if (uid == null) return;
    const el = rowRefs.current.get(uid);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setActive(list.find((m) => m.uid === uid) ?? null);
    }
    setPickerOpen(false);
  };

  // 点击月份选择器外部关闭。
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (pickerRef.current?.contains(t)) return;
      setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

  // 选中「共 N 封」打开月份选择器时，年份默认定位到含邮件的最近年份。
  const openPicker = () => {
    if (!pickerOpen) {
      const newest = monthIndex.years[0];
      if (newest != null) setPickerYear(newest);
    }
    setPickerOpen((v) => !v);
  };

  // 文件夹多选：切换某文件夹后重新拉取（至少保留一个）。
  const toggleFolder = (name: string) => {
    setFolders((prev) => {
      let next: string[];
      if (prev.includes(name)) {
        next = prev.filter((f) => f !== name);
      } else {
        next = [...prev, name];
      }
      if (next.length === 0) next = ["INBOX"];
      void fetchInbox(account!, next);
      return next;
    });
  };

  // 点击文件夹选择器外部关闭。
  useEffect(() => {
    if (!folderPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (folderPickerRef.current?.contains(t)) return;
      setFolderPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [folderPickerOpen]);

  // 点击发件人下拉外部关闭。
  useEffect(() => {
    if (!senderPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (senderPickerRef.current?.contains(t)) return;
      setSenderPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [senderPickerOpen]);

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

  // 列宽拖拽：发件人 / 主题 列头分隔处可拖动调节宽度。
  const onColResizeDown = (col: "from" | "subject") => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { startX: e.clientX, startW: col === "from" ? fromW : subjectW, col };
    const onMove = (ev: MouseEvent) => {
      const d = resizeRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      if (d.col === "from") {
        setFromW(Math.max(56, Math.min(320, d.startW + dx)));
      } else {
        setSubjectW(Math.max(64, Math.min(600, d.startW + dx)));
      }
    };
    const onUp = () => {
      resizeRef.current = null;
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

  const sections = groupEmails(filteredList);
  const provider = account ? providerLabel(account.username) : "";
  const colTemplate = `26px ${fromW}px minmax(${subjectW}px, 1fr) minmax(72px, max-content) 24px`;

  return (
    <>
      <button ref={btnRef} className="btn-sync" onClick={toggle} title="邮箱（聚合收件箱） · Ctrl+Shift+E">
        <InboxIcon width={14} height={14} />
        <span>邮箱</span>
        {unread > 0 && (
          <span className="email-unread-badge" aria-label={`${unread} 封未读`}>{unread > 99 ? "99+" : unread}</span>
        )}
      </button>

      {open &&
        createPortal(
          <div ref={pageRef} className="email-page" role="dialog" aria-label="邮箱">
            <header className="email-page-head">
              <div className="email-page-title">
                <span className="email-page-title-text">邮箱</span>
                <span className="email-page-sub">聚合收件箱 · 邮件即笔记（桌面版）</span>
              </div>
              <div className="email-page-actions">
                <div className="email-folder-wrap" ref={folderPickerRef}>
                  <button className="sync-btn ghost" onClick={() => setFolderPickerOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={folderPickerOpen}>
                    {folders.length === 1 ? folderDisplay(folders[0]) : `已选 ${folders.length} 文件夹`}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                  {folderPickerOpen && (
                    <div className="email-folder-menu" role="listbox" aria-label="选择文件夹">
                      {allFolders.map((name) => (
                        <label key={name} className={`email-folder-item${folders.includes(name) ? " is-on" : ""}`}>
                          <input
                            type="checkbox"
                            checked={folders.includes(name)}
                            onChange={() => toggleFolder(name)}
                          />
                          <span className="email-folder-check">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          </span>
                          <span className="email-folder-name">{folderDisplay(name)}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                <button className="sync-btn ghost" disabled={busy || !account} onClick={() => void refresh()}>
                  <RefreshIcon width={14} height={14} /> 拉取
                </button>
                <button
                  className="sync-btn ghost"
                  onClick={() => {
                    closePanel();
                    useEditorStore.getState().openSettings("email");
                  }}
                >
                  <SettingsIcon width={14} height={14} /> 设置
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
                  <div className="email-pane-list" style={{ width: listW }} ref={listScrollRef}>
                    <div className="email-list-head">
                      <span className="email-list-head-title">邮件{provider ? ` · ${provider}` : ""}</span>
                      {checked.size > 0 && (
                        <button className="email-list-head-delete" disabled={busy} onClick={() => void deleteSelected()}>
                          <TrashIcon width={12} height={12} /> 删除选中（{checked.size}）
                        </button>
                      )}
                      <button
                        className="email-list-head-count"
                        onClick={openPicker}
                        aria-haspopup="dialog"
                        aria-expanded={pickerOpen}
                      >
                        共 {filteredList.length} 封
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                      {pickerOpen && (
                        <div className="email-month-picker" ref={pickerRef} role="dialog" aria-label="选择月份">
                          <div className="email-month-picker-head">
                            <span className="email-month-picker-year">{pickerYear}年</span>
                            <div className="email-month-picker-nav">
                              <button aria-label="上一年" onClick={() => setPickerYear((y) => y - 1)}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="m18 15-6-6-6 6" />
                                </svg>
                              </button>
                              <button aria-label="下一年" onClick={() => setPickerYear((y) => y + 1)}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="m6 9 6 6 6-6" />
                                </svg>
                              </button>
                            </div>
                          </div>
                          <div className="email-month-picker-grid">
                            {MONTH_NAMES.map((name, m) => {
                              const has = monthIndex.firstUid.has(`${pickerYear}-${m}`);
                              return (
                                <button
                                  key={name}
                                  className={`email-month-cell${has ? " is-avail" : ""}`}
                                  disabled={!has}
                                  onClick={() => scrollToMonth(pickerYear, m)}
                                >
                                  {name}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="email-filter-bar">
                      <div className="email-sender-wrap" ref={senderPickerRef}>
                        <button
                          className="email-sender-trigger"
                          onClick={() => setSenderPickerOpen((v) => !v)}
                          aria-haspopup="listbox"
                          aria-expanded={senderPickerOpen}
                        >
                          <span className={`email-sender-label${senderSet.size ? " is-on" : ""}`}>
                            {senderSet.size === 0 ? "发件人" : `发件人 · ${senderSet.size}`}
                          </span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        </button>
                        {senderPickerOpen && (
                          <div className="email-sender-menu" role="listbox" aria-label="选择发件人">
                            <input
                              className="email-sender-search"
                              placeholder="搜索发件人…"
                              value={senderSearch}
                              onChange={(e) => setSenderSearch(e.target.value)}
                              autoFocus
                            />
                            <div className="email-sender-list">
                              <label className={`email-sender-item${senderSet.size === 0 ? " is-on" : ""}`}>
                                <input
                                  type="checkbox"
                                  checked={senderSet.size === 0}
                                  onChange={clearSenders}
                                />
                                <span className="email-sender-check">
                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M20 6 9 17l-5-5" />
                                  </svg>
                                </span>
                                <span className="email-sender-name">全部</span>
                              </label>
                              {senders
                                .filter((f) => f.toLowerCase().includes(senderSearch.trim().toLowerCase()))
                                .map((f) => (
                                  <label key={f} className={`email-sender-item${senderSet.has(f) ? " is-on" : ""}`}>
                                    <input
                                      type="checkbox"
                                      checked={senderSet.has(f)}
                                      onChange={() => toggleSender(f)}
                                    />
                                    <span className="email-sender-check">
                                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M20 6 9 17l-5-5" />
                                      </svg>
                                    </span>
                                    <span className="email-sender-name">{f}</span>
                                  </label>
                                ))}
                              {senders.length === 0 && <div className="email-sender-empty">暂无发件人</div>}
                            </div>
                            {senderSet.size > 0 && (
                              <button className="email-sender-clear" onClick={clearSenders}>清空选择</button>
                            )}
                          </div>
                        )}
                      </div>
                      <input
                        className="email-filter-input"
                        placeholder="按邮件标题过滤…（空格=与，逗号=或）"
                        title="空格=与(都含)，逗号=或(任一含)"
                        value={subjectFilter}
                        onChange={(e) => setSubjectFilter(e.target.value)}
                        aria-label="按标题过滤"
                      />
                    </div>
                    <div className="email-col-head" style={{ gridTemplateColumns: colTemplate }}>
                      <span className="email-col-check" aria-hidden />
                      <span className="email-col-from">发件人<span className="email-col-resizer" onMouseDown={onColResizeDown("from")} /></span>
                      <span className="email-col-subject">主题<span className="email-col-resizer" onMouseDown={onColResizeDown("subject")} /></span>
                      <span className="email-col-date">日期</span>
                      <span className="email-col-star" aria-hidden />
                    </div>
                    {filteredList.length === 0 && <div className="email-page-empty">
                      {list.length === 0 ? "暂无邮件，点「拉取收件箱」。" : "没有匹配的邮件（调整关键字试试）。"}
                    </div>}
                    {sections.map((s) => (
                      <div key={s.label} className="email-section">
                        <div className="email-section-label">{s.label}（{s.items.length}封）</div>
                        {s.items.map((m) => (
                          <div
                            key={m.uid}
                            ref={(el) => {
                              if (el) rowRefs.current.set(m.uid, el);
                              else rowRefs.current.delete(m.uid);
                            }}
                            className={`email-item${active?.uid === m.uid ? " is-selected" : ""}`}
                            style={{ gridTemplateColumns: colTemplate }}
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
                              className={`email-item-star${m.flagged ? " is-starred" : ""}`}
                              role="button"
                              tabIndex={-1}
                              onClick={(e) => {
                                e.stopPropagation();
                                void toggleStarred(m);
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
                      <button
                        className="sync-btn ghost"
                        disabled={busy || !active}
                        onClick={() => active && void saveUid(active.uid)}
                      >
                        <BookmarkIcon width={14} height={14} /> 存为笔记
                      </button>
                      <button className="sync-btn ghost" disabled={busy || !active} onClick={() => openCompose("reply")}>
                        <SendIcon width={14} height={14} /> 回复
                      </button>
                      <button className="sync-btn ghost" disabled={busy || !active} onClick={() => openCompose("forward")}>
                        <SendIcon width={14} height={14} /> 转发
                      </button>
                      <button
                        className={`sync-btn ghost${active?.seen ? "" : " is-active"}`}
                        disabled={busy || !active}
                        onClick={() => active && void markRead(active, !active.seen)}
                      >
                        {active?.seen ? "标为未读" : "标为已读"}
                      </button>
                      <button
                        className="sync-btn ghost"
                        disabled={busy || !active}
                        onClick={() => {
                          if (!active) return;
                          if (window.confirm("确定把该邮件移到已删除？")) void deleteEmail(active);
                        }}
                      >
                        <TrashIcon width={14} height={14} /> 删除
                      </button>
                      <span className="email-read-toolbar-spacer" />
                      {useRich && html && (
                        <button className="sync-btn ghost" disabled={!active} onClick={() => setShowImages((v) => !v)}>
                          {showImages ? "屏蔽图片" : "显示图片"}
                        </button>
                      )}
                      <button className="sync-btn ghost" disabled={!active} onClick={() => setUseRich((v) => !v)}>
                        {useRich ? "纯文本" : "富文本"}
                      </button>
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
                        </div>
                        <div className="email-read-body">
                          {loadingBody
                            ? "加载正文…"
                            : useRich && html
                              ? <EmailRichBody html={html} showImages={showImages} />
                              : body
                                ? <EmailBody text={body} />
                                : err
                                  ? ""
                                  : "（正文为空）"}
                        </div>
                      </>
                    ) : (
                      <div className="email-page-empty">在左侧选择一封邮件阅读。</div>
                    )}
                  </div>
                </div>
              )}

              {err && <div className="sync-status is-progress is-err"><div className="sync-status-text">{err}</div></div>}

              {compose && (
                <div className="email-compose-backdrop" onMouseDown={() => !sending && setCompose(null)}>
                  <div className="email-compose" onMouseDown={(e) => e.stopPropagation()}>
                    <div className="email-compose-head">
                      <span className="email-compose-title">{compose.mode === "forward" ? "转发邮件" : "回复邮件"}</span>
                      <button className="sync-btn ghost" disabled={sending} onClick={() => setCompose(null)} aria-label="关闭">✕</button>
                    </div>
                    <div className="email-compose-field">
                      <label htmlFor="email-to">收件人</label>
                      <input id="email-to" className="set-input" placeholder="对方邮箱地址" value={compose.to} onChange={(e) => setCompose({ ...compose, to: e.target.value })} />
                    </div>
                    <div className="email-compose-field">
                      <label htmlFor="email-subject">主题</label>
                      <input id="email-subject" className="set-input" value={compose.subject} onChange={(e) => setCompose({ ...compose, subject: e.target.value })} />
                    </div>
                    <div className="email-compose-field email-compose-body">
                      <label htmlFor="email-body">正文</label>
                      <textarea id="email-body" className="set-input" value={compose.body} onChange={(e) => setCompose({ ...compose, body: e.target.value })} />
                    </div>
                    <div className="email-compose-actions">
                      <span className="email-compose-hint">
                        {compose.mode === "forward" ? "转发需手动填写收件人；引用原文已附上。" : "回复默认给原发件人。请先在 设置→邮箱 填好 SMTP 发信信息。"}
                      </span>
                      <button className="sync-btn primary" disabled={sending || !compose.to.trim()} onClick={() => void sendCompose()}>
                        {sending ? "发送中…" : "发送"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.querySelector(".main") ?? document.body,
        )}
    </>
  );
}
