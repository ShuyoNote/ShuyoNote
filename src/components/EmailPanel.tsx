import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import { createPortal } from "react-dom";
import { api, type EmailAccount, type EmailMeta } from "../lib/api";
import { useAiStore } from "../store/ai";
import { emailHtmlToLexical } from "../lib/emailRichNote";
import { platform } from "../lib/platform";
import { useEmailPanel } from "../store/emailPanel";
import { useEditorStore } from "../store/editor";
import { useNotes } from "../store/notes";
import { toast } from "../store/toast";
import { InboxIcon, SendIcon, RefreshIcon, TrashIcon, SettingsIcon, BookmarkIcon } from "./icons";

type Section = { label: string; items: EmailMeta[] };

// 邮件正文内存缓存：key = `${account.username}|${folder}|${uid}`。
// 会话级，避免点同一封再走一次 IMAP 拉取+解析。
const bodyCache = new Map<string, { text: string; html: string }>();
const bodyCacheKey = (acc: EmailAccount, folder: string, uid: number) =>
  `${acc.username}|${acc.host}|${folder}|${uid}`;

const AVATAR_COLORS = ["#4f7cff", "#7b61ff", "#2f9e67", "#e0a13a", "#d05b8b", "#1591b0", "#c2493b", "#8a6fde"];

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// 头像淡背景：把主题色混入大量白，得到浅色底（配深色字）。
function avatarBg(name: string): string {
  const c = avatarColor(name);
  const hex = c.replace("#", "");
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (ch: number) => Math.round(ch + (255 - ch) * 0.82);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
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

// 头像首字母：优先取显示名称（< 之前的部分），否则取邮箱地址首字符。
function senderInitial(v: string): string {
  const name = v.split("<")[0].trim();
  const src = name || v;
  return (src.trim().charAt(0) || "?").toUpperCase();
}

// 发件人显示名：取 `Name <email>` 中的 Name；无 Name 时回退为邮箱地址。
function senderNameOf(v: string): string {
  const name = v.split("<")[0].trim();
  return name || v;
}

// HTML 转义（用于把纯文本正文包进 <p> 后交给 Lexical 导入，避免被当成 HTML）。
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 从邮箱地址（含 "Name <a@b.c>" 形式）提取域名，如 "a@qq.com" → "qq.com"、"a@netbird.io" → "netbird.io"。
function emailDomainOf(v: string): string {
  const m = v.match(/<([^>]+)>/);
  const addr = (m ? m[1] : v).trim();
  const at = addr.lastIndexOf("@");
  if (at < 0) return addr.toLowerCase();
  return addr.slice(at + 1).trim().toLowerCase();
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
    trusted_domains: a.trusted_domains ?? [],
    auto_trust_senders: a.auto_trust_senders ?? true,
  };
}

// 账号唯一键（与后端 account_key 一致：host|username，均小写）。聚合流里用 meta.account 据此定位所属账号。
function accountKey(a: EmailAccount): string {
  return `${a.host.toLowerCase()}|${a.username.toLowerCase()}`;
}

// 一封邮件的稳定标识：账号标注(host|username) + 文件夹 + uid。
// 聚合流下不同账号的 uid 可能相同，单用 uid 会误匹配，故用复合键。
function emailKey(m: EmailMeta): string {
  return `${m.account ?? ""}|${m.folder}|${m.uid}`;
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

// 用 DOMPurify 白名单消毒邮件 HTML（去 script/iframe/事件属性/javascript: 协议等）。
// 图片策略（用户选择 A）：保留 `<img>`（富排版），但默认把 `src` 移到 `data-src` 使浏览器不加载；
// 用户点「显示图片」后再以 showImages=true 重新渲染，把 src 补回才加载（保留追踪防护，安全靠消毒+用户授权）。
function sanitizeEmailHtml(html: string, showImages: boolean): string {
  const config = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["iframe", "script", "object", "embed", "form", "input", "style", "link", "meta", "base", "svg", "math"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "formaction", "xlink:href", "srcset", "background"],
    ADD_ATTR: ["target", "rel"],
    ALLOW_DATA_ATTR: true,
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

  // 移除背景图/样式里的 url()（追踪/泄露风险）。
  clean = clean.replace(/url\s*\(\s*["']?[^"')]+["']?\s*\)/gi, "");

  if (!showImages) {
    // 默认不加载：把 <img src=...> 改成 <img data-src=...>（保留 tag 与尺寸，浏览器不请求 src）。
    clean = clean.replace(/<img\b[^>]*>/gi, (tag) => {
      const srcM = /src=["']([^"']*)["']/.exec(tag);
      if (!srcM) return tag;
      const src = srcM[1];
      if (!(src.startsWith("http:") || src.startsWith("https:") || src.startsWith("//"))) return tag;
      const withoutSrc = tag.replace(/src=["'][^"']*["']/, "");
      return `${withoutSrc} data-src="${src}"`;
    });
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

// 富文本正文：经 DOMPurify 消毒后渲染；远程图片默认不加载（src→data-src），点「显示图片」才加载。
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
  const dragTouched = useRef(false);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const listScrollRef = useRef<HTMLDivElement>(null);

  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  // 当前「账号筛选」范围：null = 全部账号（聚合视图）；否则为该单账号的 key（host|username，小写）。
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const [list, setList] = useState<EmailMeta[]>([]);
  const [active, setActive] = useState<EmailMeta | null>(null);
  const [body, setBody] = useState("");
  const [html, setHtml] = useState("");
  const [aiSummary, setAiSummary] = useState("");
  const [aiSummaryBusy, setAiSummaryBusy] = useState(false);
  const [useRich, setUseRich] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingBody, setLoadingBody] = useState(false);
  const [listW, setListW] = useState<number>(() => Math.round(window.innerWidth / 3));
  // 列表列宽：发件人/主题 可通过列表头拖拽调节；主题列弹性适应左栏宽度。
  const [fromW, setFromW] = useState(90);
  const [subjectW, setSubjectW] = useState(160);
  const resizeRef = useRef<{ startX: number; startW: number; col: "from" | "subject" } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState<number>(new Date().getFullYear());
  // 收件箱里所有含邮件的月份（含未加载历史），供月份选择器启用对应月份。
  const [allMonths, setAllMonths] = useState<Set<string>>(new Set());
  const pickerRef = useRef<HTMLDivElement>(null);
  // 发信（回复/转发）撰写弹窗。
  const [compose, setCompose] = useState<{ mode: "reply" | "forward"; to: string; subject: string; body: string; quote: string; includeQuote: boolean } | null>(null);
  const composeBodyRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [folders, setFolders] = useState<string[]>(["INBOX"]);
  const [allFolders, setAllFolders] = useState<string[]>([]);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const folderPickerRef = useRef<HTMLDivElement>(null);
  // 存为笔记的目标父级（文件夹/页面）；null = 根目录。
  const [saveParentId, setSaveParentId] = useState<"root" | string>("root");
  const [saveParentOpen, setSaveParentOpen] = useState(false);
  const saveParentRef = useRef<HTMLDivElement>(null);
  const [saveCandidates, setSaveCandidates] = useState<{ id: string; title: string; kind: string; parent_id: string | null }[]>([]);
  // 关键词搜索：发件人/主题 子串匹配（统一搜索入口）。
  const [searchQuery, setSearchQuery] = useState("");
  // 懒加载分页：每页条数 + 是否还有更多。
  const PAGE_SIZE = 200;
  const [hasMore, setHasMore] = useState(false);

  // 当前筛选范围对应的单账号（scopeKey 命中 accounts 里的一个）；null = 全部账号聚合。
  const scopeAccount = useMemo(
    () => (scopeKey ? accounts.find((a) => accountKey(a) === scopeKey) ?? null : null),
    [scopeKey, accounts],
  );
  const isAggregate = scopeKey === null;
  // 代表账号：单账号筛选用该账号；聚合视图的文件夹/月份选择仍以首个账号为准（后端聚合按相同文件夹名遍历各账号）。
  const repAccount = scopeAccount ?? accounts[0] ?? null;

  // 按一封邮件的 meta.account（host|username）定位其所属 EmailAccount（聚合流）。
  // 单账号命令返回的 meta.account 为空 → 回退到当前筛选账号；都未命中再回退到首个账号。
  const accountFor = (m: EmailMeta | null | undefined): EmailAccount | null => {
    if (!m) return null;
    const k = m.account;
    if (k) {
      const hit = accounts.find((a) => accountKey(a) === k);
      if (hit) return hit;
    }
    return scopeAccount ?? accounts[0] ?? null;
  };

  // 把某个账号的改动同步回 accounts 列表（如信任发件人后更新 trusted_domains）。
  const patchAccount = (updated: EmailAccount) => {
    const k = accountKey(updated);
    setAccounts((prev) => prev.map((a) => (accountKey(a) === k ? updated : a)));
  };

  // 按增量调整角标（避免用「当前一页」的未读数覆盖聚合/全量的真实值）。
  const adjustUnread = (delta: number) => {
    setUnread(Math.max(0, useEmailPanel.getState().unread + delta));
  };

  // 列表行内的来源账号小标（仅聚合视图显示）：彩色圆点 + 账号短名，便于区分多账号。
  const renderAccountChip = (m: EmailMeta) => {
    const a = accountFor(m);
    if (!a) return null;
    const label = a.username.split("@")[0] || a.username;
    return (
      <span className="email-account-chip" title={a.username}>
        <span className="email-account-chip-dot" style={{ background: avatarColor(a.username) }} />
        {label}
      </span>
    );
  };

  // 富文本远程图：默认不加载，用户点「显示图片」才加载（data-src→src）。
  const [showImages, setShowImages] = useState(false);
  // 阅读区工具栏宽度检测：较窄时把次要按钮收进「更多」。
  const readToolbarRef = useRef<HTMLDivElement>(null);
  const readPaneRef = useRef<HTMLDivElement>(null);
  const [toolbarW, setToolbarW] = useState(9999);
  const [moreOpen, setMoreOpen] = useState(false);
  // 逐级收纳阈值：按按钮组实际宽度测量，而不是固定常量，避免控制条缩窄时横向溢出。
  const measureCoreRef = useRef<HTMLDivElement>(null);
  const measureActionRef = useRef<HTMLDivElement>(null);
  const measureRightRef = useRef<HTMLDivElement>(null);
  const measureMoreRef = useRef<HTMLDivElement>(null);
  const [need, setNeed] = useState({ full: 9999, coreAction: 9999 });
  // 顶部标题栏的逐级收纳阈值同样按实测宽度（而非固定 720/560）。
  const measureHeadTitleRef = useRef<HTMLSpanElement>(null);
  const measureHeadSubRef = useRef<HTMLSpanElement>(null);
  const measureHeadActionsRef = useRef<HTMLDivElement>(null);
  const [headNeed, setHeadNeed] = useState({ sub: 9999, tool: 9999 });
  // 顶部标题栏宽度检测：窄时隐藏说明 + 把工具按钮收进「更多」。
  const pageHeadRef = useRef<HTMLDivElement>(null);
  const [headW, setHeadW] = useState(9999);
  const [headMoreOpen, setHeadMoreOpen] = useState(false);

  // 当前列表里的去重发件人（供下拉选项）。
  const filteredList = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((m) => m.from.toLowerCase().includes(q) || m.subject.toLowerCase().includes(q));
  }, [list, searchQuery]);

  // 打开时默认左右均分：把列表宽度设为分栏容器的一半。
  useEffect(() => {
    if (!open) return;
    const el = splitRef.current;
    if (el) {
      const w = Math.round(el.getBoundingClientRect().width / 2);
      if (w > 240) setListW(w);
    }
  }, [open]);

  // 挂载时读一次已保存账号列表（供角标/定时收取/标签用；不依赖面板是否打开）。
  useEffect(() => {
    api
      .emailListAccounts()
      .then((list) => {
        setAccounts(list.map((a) => toAccount(a)));
      })
      .catch(() => {});
  }, []);

  // 有账号后列出文件夹，并保证默认选「收件箱」；顺带拉取所有月份。
  useEffect(() => {
    if (!repAccount) return;
    api
      .emailListFolders(repAccount)
      .then((fs) => {
        const list = fs.length ? fs : ["INBOX"];
        setAllFolders(list);
        setFolders((prev) => (prev.some((f) => list.includes(f)) ? prev : ["INBOX"]));
      })
      .catch(() => setAllFolders(["INBOX"]));
    void loadMonths(repAccount);
    void loadSaveCandidates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repAccount, accounts]);

  // 检测阅读区宽度：放不下时把按钮收进「更多」。用工具栏自身可用宽（clientWidth）
  // 而非 readPane.clientWidth（后者含左右 padding，会高估可用宽度约 48px 导致轻微溢出）。
  useEffect(() => {
    const el = readToolbarRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => setToolbarW(el.clientWidth);
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    measure();
    raf = requestAnimationFrame(measure);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [open]);

  // 顶部标题栏宽度检测：窄时隐藏说明 + 把工具按钮收进「更多」。
  useEffect(() => {
    const el = pageHeadRef.current;
    if (!el) return;
    const measure = () => setHeadW(el.clientWidth);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [open]);

  // 点击标题栏「更多」下拉外部关闭。
  useEffect(() => {
    if (!headMoreOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && pageHeadRef.current?.contains(t)) return;
      setHeadMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [headMoreOpen]);

  // 默认左右 1:2：左栏占 split 容器宽度的 1/3（正文视图默认占 2/3）。
  useEffect(() => {
    if (!open) return;
    const el = splitRef.current;
    if (!el || dragTouched.current) return;
    const w = Math.round(el.getBoundingClientRect().width / 3);
    if (w > 240) setListW(w);
    // 仅设置一次默认，之后交给用户拖拽。
  }, [open]);

  // 点击「更多」下拉外部关闭。
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && readToolbarRef.current?.contains(t)) return;
      setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [moreOpen]);

  // 打开时：按当前筛选范围拉取收件箱（聚合 / 单账号）。
  useEffect(() => {
    if (!open) return;
    setErr("");
    if (accounts.length === 0) {
      setErr("请先在 设置 → 邮箱 配置 IMAP 账号");
      return;
    }
    void fetchInbox(scopeAccount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 切换账号筛选：key = null 表示「全部账号」（聚合）；否则为该单账号 key。
  const switchScope = async (key: string | null) => {
    setScopeKey(key);
    setList([]);
    setActive(null);
    setBody("");
    setHtml("");
    setChecked(new Set());
    const acc = key ? accounts.find((a) => accountKey(a) === key) ?? null : null;
    await fetchInbox(acc);
  };

  // 拉取列表（聚合 = emailFetchAll(limit/offset)；单账号 = emailFetchInbox）。
  const fetchInbox = async (acc: EmailAccount | null, fs: string[] = folders, offset = 0) => {
    setBusy(true);
    setErr("");
    try {
      if (acc) {
        const r = await api.emailFetchInbox(acc, fs, PAGE_SIZE, offset);
        setList(r);
        setUnread(r.filter((m) => !m.seen).length);
        // 拉满一页说明后面可能还有更多。
        setHasMore(r.length >= PAGE_SIZE);
        if (r.length === 0) {
          setErr("未拉到邮件（检查账号 / 认证）");
        } else if (r.some((m) => (active ? emailKey(m) === emailKey(active) : false))) {
          // 保持当前阅读的邮件选中，不打扰。
        } else {
          void selectEmail(r[0], acc);
        }
      } else {
        const agg = await api.emailFetchAll(fs, PAGE_SIZE, offset);
        setList(agg.emails);
        // 聚合角标用后端汇总的 unread（跨所有账号），而非当前页列表统计。
        setUnread(agg.unread);
        setHasMore(agg.emails.length >= PAGE_SIZE);
        if (agg.emails.length === 0) {
          setErr("未拉到邮件（检查账号 / 认证）");
        } else if (agg.emails.some((m) => (active ? emailKey(m) === emailKey(active) : false))) {
        } else {
          void selectEmail(agg.emails[0]);
        }
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 滚动到底时按 offset 真正加载下一页，追加到列表末尾。
  const fetchMore = async () => {
    if (busy || !hasMore) return;
    setBusy(true);
    try {
      if (scopeAccount) {
        const r = await api.emailFetchInbox(scopeAccount, folders, PAGE_SIZE, list.length);
        if (r.length > 0) setList((prev) => [...prev, ...r]);
        setHasMore(r.length >= PAGE_SIZE);
      } else {
        const agg = await api.emailFetchAll(folders, PAGE_SIZE, list.length);
        if (agg.emails.length > 0) setList((prev) => [...prev, ...agg.emails]);
        setHasMore(agg.emails.length >= PAGE_SIZE);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 按月份从后端拉取该月区间邮件（直接替换列表），用于月份选择器「直达某月」。
  const fetchMonth = async (year: number, month0: number) => {
    if (!repAccount) return;
    const from = `${year}-${String(month0 + 1).padStart(2, "0")}-01`;
    // IMAP SEARCH `BEFORE` 是严格小于，且不接受「当月最后一天」作为日期（30 天月传 31 无效）。
    // 用「下月 1 日」才能覆盖当月全部（含月末当天）；12 月跨年到次年 1 月。
    const nextM = month0 + 1; // 当月 (1-12)
    const toYear = nextM === 12 ? year + 1 : year;
    const toMonth = nextM === 12 ? 1 : nextM + 1;
    const to = `${toYear}-${String(toMonth).padStart(2, "0")}-01`;
    setBusy(true);
    setErr("");
    try {
      const r = await api.emailFetchInbox(repAccount, folders, 0, 0, from, to);
      setList(r);
      setUnread(r.filter((m) => !m.seen).length);
      setHasMore(false);
      if (r.length === 0) {
        setErr(`${year} 年 ${month0 + 1} 月没有邮件`);
      } else {
        void selectEmail(r[0], repAccount);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 拉取所有含邮件的月份（含未加载历史），供月份选择器启用。
  const loadMonths = async (acc: EmailAccount, fs: string[] = folders) => {
    try {
      const months = await api.emailListMonths(acc, fs);
      setAllMonths(new Set(months));
    } catch {
      // 列出月份失败不致命，月份网格回退到仅当前已加载列表。
    }
  };

  // 加载「存为笔记」的候选父级（文件夹/页面），供目标位置选择器用。
  const loadSaveCandidates = async () => {
    try {
      const pages = await api.listPages();
      setSaveCandidates(pages.map((p) => ({ id: p.id, title: p.title, kind: p.kind, parent_id: p.parent_id })));
    } catch {
      setSaveCandidates([]);
    }
  };

  // 目录树：按 parent_id 建 children 映射，父级选择器据此渲染层级树（B1）。
  const parentTree = useMemo(() => {
    type P = { id: string; title: string; kind: string; parent_id: string | null };
    const children = new Map<string, P[]>();
    for (const p of saveCandidates) {
      const key = p.parent_id ?? "root";
      const arr = children.get(key) ?? [];
      arr.push(p);
      children.set(key, arr);
    }
    for (const arr of children.values()) arr.sort((a, b) => a.title.localeCompare(b.title));
    return children;
  }, [saveCandidates]);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set(["root"]));
  const toggleExpanded = (id: string) =>
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // 递归渲染保存位置树：文件夹可展开/折叠，页面/文件夹均可选。
  const renderSaveTree = (pid: string, depth: number) => {
    const items = parentTree.get(pid) ?? [];
    if (!items.length) return null;
    const open = expandedParents.has(pid);
    const out: React.ReactNode[] = [];
    for (const p of items) {
      const hasKids = (parentTree.get(p.id) ?? []).length > 0;
      out.push(
        <label
          key={p.id}
          className={`email-save-parent-item${saveParentId === p.id ? " is-on" : ""}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          role="option"
        >
          {p.kind === "folder" ? (
            <span
              className="email-save-parent-toggle"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleExpanded(p.id); }}
            >
              {hasKids ? (open ? "▾" : "▸") : "·"}
            </span>
          ) : (
            <span className="email-save-parent-toggle" style={{ visibility: "hidden" }}>·</span>
          )}
          <input
            type="checkbox"
            checked={saveParentId === p.id}
            onChange={() => { setSaveParentId(p.id); setSaveParentOpen(false); }}
          />
          <span className="email-save-parent-name">{p.kind === "folder" ? "🗀 " : "📄 "}{p.title || "(无标题)"}</span>
        </label>,
      );
      if (p.kind === "folder" && open) out.push(...(renderSaveTree(p.id, depth + 1) ?? []));
    }
    return out;
  };

  // 列表滚动接近底部时加载下一页。
  const onListScroll = () => {
    const el = listScrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      void fetchMore();
    }
  };

  const selectEmail = async (m: EmailMeta, acc?: EmailAccount | null) => {
    const a = acc ?? accountFor(m);
    if (!a) {
      setActive(m);
      setErr("找不到这封邮件的账号");
      return;
    }
    setActive(m);
    setLoadingBody(true);
    setErr("");
    setShowImages(false);
    const key = bodyCacheKey(a, m.folder, m.uid);
    const hit = bodyCache.get(key);
    if (hit) {
      setBody(hit.text);
      setHtml(hit.html);
      setLoadingBody(false);
    } else {
      try {
        // 一次拉取同时拿纯文本 + HTML（此前并发两次，浪费一半连接/拉取/解析）。
        const parts = await api.emailGetMessage(a, m.uid, m.folder);
        setBody(parts.text);
        setHtml(parts.html);
        bodyCache.set(key, { text: parts.text, html: parts.html });
      } catch (e) {
        setErr(String(e));
        setBody("");
        setHtml("");
      } finally {
        setLoadingBody(false);
      }
    }
    // 自动可信（可在设置关闭）：打开一封邮件即把其发件人域名加入可信（下次自动放行图片）。
    if (a.auto_trust_senders ?? true) {
      void autoTrust(m, a);
    }
  };

  // 把发件人域名加入可信集合（内存 + 持久化）。已有则忽略。
  const autoTrust = async (m: EmailMeta, acc: EmailAccount) => {
    const dom = emailDomainOf(m.from);
    if (!dom) return;
    const cur = acc.trusted_domains ?? [];
    if (cur.includes(dom)) return;
    const next = [...new Set([...cur, dom])];
    const updated = { ...acc, trusted_domains: next };
    patchAccount(updated);
    try {
      await api.emailSaveAccount(updated);
    } catch {
      // 保存失败不阻塞，图片放行逻辑仍基于内存中的 updated。
    }
  };

  const refresh = async () => {
    await fetchInbox(scopeAccount, folders);
    if (repAccount) void loadMonths(repAccount, folders);
  };

  // AI 总结邮件要点/行动项（A1）：复用已配置的 AI provider（store/ai.ts）。
  const summarizeEmail = async () => {
    if (!active) return;
    const cfg = useAiStore.getState().config;
    if (!cfg?.enabled) {
      toast("请先在 设置 → AI 里配置模型", "info");
      return;
    }
    setAiSummaryBusy(true);
    setErr("");
    try {
      const text = (body || "").trim();
      if (!text) { setErr("正文为空，无法总结"); return; }
      const resp = await api.aiComplete({
        provider: cfg.provider,
        base_url: cfg.baseUrl,
        model: cfg.model,
        api_key: cfg.apiKey || undefined,
        messages: [
          { role: "system", content: "你是邮件摘要助手，用中文输出【要点】与【行动项】两个小节。" },
          { role: "user", content: `请总结这封邮件：\n发件人: ${active.from}\n主题: ${active.subject}\n正文:\n${text.slice(0, 4000)}` },
        ],
      });
      setAiSummary((resp as { content?: string })?.content?.trim() || "（无输出）");
    } catch (e) {
      setErr(String(e));
    } finally {
      setAiSummaryBusy(false);
    }
  };

  const saveUid = async (uid: number) => {
    const acc = accountFor(active);
    if (!acc || !active) return;
    setErr("");
    setBusy(true);
    try {
      // 富文本存笔记：拉取邮件 HTML（纯文本兜底），前端转 Lexical JSON，再建页。
      const target = saveParentId === "root" ? null : saveParentId;
      let pageId: string | null = null;
      let content: { content_json: string; content_text: string };
      const parts = await api.emailGetMessage(acc, uid, active.folder).catch(() => null);
      if (parts && parts.html.trim()) {
        content = emailHtmlToLexical(parts.html);
      } else if (parts) {
        content = emailHtmlToLexical(`<p>${escapeHtml(parts.text)}</p>`);
      } else {
        content = emailHtmlToLexical(`<p>${escapeHtml(body)}</p>`);
      }
      // 邮件附件 → 以内容寻址引用节点追加到正文（B2：附件进笔记）。
      try {
        const attaches = await api.emailGetAttachments(acc, uid, active.folder).catch(() => []);
        if (attaches.length) {
          const lex = JSON.parse(content.content_json) as { root?: { children?: unknown[] } };
          const children = lex?.root?.children;
          if (Array.isArray(children)) {
            for (const a of attaches) {
              children.push({
                type: "attachment-ref",
                version: 1,
                attachmentId: a.id,
                name: a.name,
                size: a.size,
                mime: a.mime,
                hash: a.hash,
                path: a.path,
              });
            }
            content.content_json = JSON.stringify(lex);
          }
        }
      } catch { /* 附件插入失败不阻塞存为笔记 */ }
      const title = active.subject || "(无主题)";
      // 去重：同标题已有笔记时提示「继续新建」还是「打开已有（合并）」。取消 = 不存。
      try {
        const existing = await api.listPages();
        const dup = existing.find((p) => p.title === title && p.kind === "page");
        if (dup) {
          const goNew = window.confirm(`已存在同标题笔记「${title}」。\n点「确定」仍新建一份；点「取消」打开已有笔记（不新建）。`);
          if (!goNew) {
            useNotes.getState().openPage(dup.id);
            setErr("");
            return;
          }
        }
      } catch { /* 去重检查失败不阻塞 */ }
      pageId = await useNotes.getState().createPage(target, {
        title,
        content_json: content.content_json,
        content_text: content.content_text,
      });
      if (pageId) {
        // 邮件字段 → 页面属性（发件人/收件人/主题/日期），可在数据库视图筛选。
        await writeEmailProps(pageId, active);
        // A2 标签映射：把发件人作为标签挂到笔记（addTag 按 name 幂等），便于按发件人筛选。
        await api.addTag(pageId, senderNameOf(active.from)).catch(() => {});
      }
      setErr("");
      toast("已存为笔记", "success");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 给页面写入邮件属性：查找或新建对应 attr，再 set_page_prop。失败不阻塞存笔记。
  const writeEmailProps = async (pageId: string, m: EmailMeta) => {
    const defs = await api.listAttrDefs().catch(() => []);
    const getOrCreate = async (name: string, value: string) => {
      const v = value.trim();
      if (!v) return;
      const existing = defs.find((d) => d.name === name);
      const attrId = existing ? existing.id : (await api.createAttr({ name, attr_type: "text" }).catch(() => null))?.id;
      if (!attrId) return;
      await api.setPageProp({ page_id: pageId, attr_id: attrId, value: v }).catch(() => {});
    };
    const from = stripEmail(m.from);
    await getOrCreate("发件人", from);
    await getOrCreate("主题", m.subject);
    await getOrCreate("邮件日期", m.date);
  };

  // 邮件 → 任务：建页 + 写「截止日期」属性（默认明天）+ 一个待办块。
  // 邮件 → 任务：建页 + 写「截止日期」属性（默认明天）+ 一个待办块。
  const saveAsTask = async () => {
    const acc = accountFor(active);
    if (!acc || !active) return;
    setErr("");
    setBusy(true);
    try {
      const target = saveParentId === "root" ? null : saveParentId;
      const parts = await api.emailGetMessage(acc, active.uid, active.folder).catch(() => null);
      const text = parts ? parts.text : body;
      const title = active.subject || "(无主题)";
      // 待办块正文：拆成一行为一项，或用整个邮件正文。
      const todoText = text.trim() ? text.trim().split(/\n/).slice(0, 12).join("\n") : "处理此邮件";
      const content = emailHtmlToLexical(`<p>[ ] ${escapeHtml(todoText)}</p>`);
      const pageId = await useNotes.getState().createPage(target, {
        title: `[任务] ${title}`,
        content_json: content.content_json,
        content_text: content.content_text,
      });
      if (pageId) {
        const defs = await api.listAttrDefs().catch(() => []);
        let due = defs.find((d) => d.name === "截止日期");
        let dueId = due?.id;
        if (!dueId) dueId = (await api.createAttr({ name: "截止日期", attr_type: "date" }).catch(() => null))?.id;
        if (dueId) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const iso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
          await api.setPageProp({ page_id: pageId, attr_id: dueId, value: iso }).catch(() => {});
        }
        await writeEmailProps(pageId, active);
      }
      setErr("");
      toast("已存为任务（截止：明天）", "success");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 识别并保存邮件的附件到内容寻址附件库（同名/同内容自动去重）。
  const saveAttachments = async () => {
    const acc = accountFor(active);
    if (!acc || !active) return;
    setErr("");
    setBusy(true);
    try {
      const atts = await api.emailGetAttachments(acc, active.uid, active.folder);
      if (atts.length === 0) {
        toast("这封邮件没有附件", "info");
      } else {
        toast(`已保存 ${atts.length} 个附件`, "success");
        // 打开附件所在页面/库的入口提示（附件已入库，可插入笔记/文件库引用）。
        setErr(`附件已入库：${atts.map((a) => a.name).join("、")}`);
      }
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

  // 打开面板时同步一次当前未读数（不等下一次轮询）。仅单账号筛选可用（聚合无单账号计数）。
  useEffect(() => {
    if (!open || !scopeAccount?.auto_fetch) return;
    api
      .emailUnseenCount(scopeAccount)
      .then((n) => setUnread(n))
      .catch(() => {});
  }, [scopeAccount, open, setUnread]);

  const toggleChecked = (key: string) => {
    setChecked((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };

  const toggleStarred = async (m: EmailMeta) => {
    const acc = accountFor(m);
    if (!acc) return;
    const next = !m.flagged;
    // 乐观更新列表里的星标状态。
    setList((prev) => prev.map((x) => (emailKey(x) === emailKey(m) ? { ...x, flagged: next } : x)));
    try {
      await api.emailSetFlag(acc, m.uid, m.folder, next);
    } catch (e) {
      setErr(String(e));
      // 失败回滚。
      setList((prev) => prev.map((x) => (emailKey(x) === emailKey(m) ? { ...x, flagged: m.flagged } : x)));
    }
  };

  const markRead = async (m: EmailMeta, read: boolean) => {
    const acc = accountFor(m);
    if (!acc) return;
    const delta = m.seen === read ? 0 : (read ? -1 : 1);
    const updated = list.map((x) => (emailKey(x) === emailKey(m) ? { ...x, seen: read } : x));
    setList(updated);
    adjustUnread(delta);
    try {
      await api.emailMarkRead(acc, m.uid, m.folder, read);
    } catch (e) {
      setErr(String(e));
      const rolled = list.map((x) => (emailKey(x) === emailKey(m) ? { ...x, seen: m.seen } : x));
      setList(rolled);
      adjustUnread(-delta);
    }
  };

  const deleteEmail = async (m: EmailMeta) => {
    const acc = accountFor(m);
    if (!acc) return;
    setErr("");
    setBusy(true);
    try {
      await api.emailMoveToTrash(acc, m.uid, m.folder);
      bodyCache.delete(bodyCacheKey(acc, m.folder, m.uid));
      // 计算删除后要显示的下一条：当前选中项的下一条（最新在前 → 往后一条是较旧的）。
      const idx = list.findIndex((x) => emailKey(x) === emailKey(m));
      const next = idx >= 0 ? list[idx + 1] : undefined;
      const remaining = list.filter((x) => emailKey(x) !== emailKey(m));
      setList(remaining);
      adjustUnread(m.seen ? 0 : -1);
      if (next) {
        void selectEmail(next);
      } else {
        // 没有下一条：若删的是当前项则清空正文。
        if (active && emailKey(active) === emailKey(m)) {
          setActive(null);
          setBody("");
        }
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 批量删除选中的邮件（勾选框选中），按「账号 + 文件夹」分组分别调用后端。
  const deleteSelected = async () => {
    if (checked.size === 0) return;
    const target = list.filter((m) => checked.has(emailKey(m)));
    if (target.length === 0) return;
    if (!window.confirm(`确定把选中的 ${target.length} 封邮件移到已删除？`)) return;
    setErr("");
    setBusy(true);
    try {
      // 按「账号 + 文件夹」分组（聚合流下不同账号可能同名文件夹或相同 uid），每组一次连接。
      const byGroup = new Map<string, { acc: EmailAccount; folder: string; uids: number[] }>();
      for (const m of target) {
        const a = accountFor(m);
        if (!a) continue;
        const gk = `${accountKey(a)}|${m.folder}`;
        let g = byGroup.get(gk);
        if (!g) { g = { acc: a, folder: m.folder, uids: [] }; byGroup.set(gk, g); }
        g.uids.push(m.uid);
      }
      let moved = 0;
      for (const g of byGroup.values()) {
        moved += await api.emailMoveManyToTrash(g.acc, g.uids, g.folder);
      }
      for (const m of target) { const a = accountFor(m); if (a) bodyCache.delete(bodyCacheKey(a, m.folder, m.uid)); }
      adjustUnread(-target.filter((x) => !x.seen).length);
      setList((prev) => prev.filter((x) => !checked.has(emailKey(x))));
      setChecked(new Set());
      if (active && checked.has(emailKey(active))) {
        setActive(null);
        setBody("");
      }
      setErr("");
      toast(`已删除 ${moved} 封`, "success");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 批量标记已读/未读（勾选选中），按「账号 + 文件夹」分组调用一次后端。
  const markSelectedRead = async (read: boolean) => {
    if (checked.size === 0) return;
    const target = list.filter((m) => checked.has(emailKey(m)));
    if (target.length === 0) return;
    setErr("");
    setBusy(true);
    try {
      const byGroup = new Map<string, { acc: EmailAccount; folder: string; uids: number[] }>();
      for (const m of target) {
        const a = accountFor(m);
        if (!a) continue;
        const gk = `${accountKey(a)}|${m.folder}`;
        let g = byGroup.get(gk);
        if (!g) { g = { acc: a, folder: m.folder, uids: [] }; byGroup.set(gk, g); }
        g.uids.push(m.uid);
      }
      let done = 0;
      for (const g of byGroup.values()) {
        done += await api.emailMarkManyRead(g.acc, g.uids, g.folder, read);
      }
      const updated = list.map((x) => checked.has(emailKey(x)) ? { ...x, seen: read } : x);
      adjustUnread(target.reduce((acc, x) => acc + (x.seen === read ? 0 : (read ? -1 : 1)), 0));
      setList(updated);
      setChecked(new Set());
      toast(`${read ? "已读" : "未读"} ${done} 封`, "success");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 批量存为笔记：对勾选的每封拉 HTML → 转 Lexical → 建页（侧边栏自动刷新）。
  const saveSelectedAsNotes = async () => {
    if (checked.size === 0) return;
    const target = list.filter((m) => checked.has(emailKey(m)));
    if (target.length === 0) return;
    setErr("");
    setBusy(true);
    try {
      let saved = 0;
      for (const m of target) {
        const a = accountFor(m);
        if (!a) continue;
        const html = await api.emailGetHtml(a, m.uid, m.folder).catch(() => "");
        let content: { content_json: string; content_text: string };
        if (html.trim()) content = emailHtmlToLexical(html);
        else content = emailHtmlToLexical(`<p>${escapeHtml(body)}</p>`);
        await useNotes.getState().createPage(null, { title: m.subject || "(无主题)", content_json: content.content_json, content_text: content.content_text });
        saved++;
      }
      setChecked(new Set());
      toast(`已存为笔记 ${saved} 封`, "success");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 打开回复/转发撰写：预填收件人与主题，正文默认带引用（可取消）。
  const openCompose = (mode: "reply" | "forward") => {
    if (!active) return;
    const fwd = mode === "forward";
    const subject = fwd
      ? (active.subject.startsWith("Fwd:") || active.subject.startsWith("Fw:") ? active.subject : `Fwd: ${active.subject}`)
      : (active.subject.startsWith("Re:") ? active.subject : `Re: ${active.subject}`);
    const quote = `\n\n${active.subject}\n${active.from}\n${active.date}\n\n${"─".repeat(40)}\n\n${body}`;
    setCompose({
      mode,
      to: fwd ? "" : stripEmail(active.from),
      subject,
      body: quote,
      quote,
      includeQuote: true,
    });
  };

  const sendCompose = async () => {
    const acc = accountFor(active);
    if (!acc || !compose) return;
    if (!compose.to.trim()) {
      setErr("收件人不能为空");
      return;
    }
    setSending(true);
    setErr("");
    try {
      await api.emailSend(acc, compose.to.trim(), compose.subject || "(无主题)", compose.body);
      setCompose(null);
      setErr("");
      toast("邮件已发送", "success");
    } catch (e) {
      setErr(String(e));
    } finally {
      setSending(false);
    }
  };

  // 展开回复/转发后自动聚焦正文，并把光标移到末尾（引用之后）。
  useEffect(() => {
    if (!compose) return;
    const el = composeBodyRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, [compose]);

  // 月份选择：从后端拉取该月区间邮件（直达某月），关掉选择器。
  const scrollToMonth = (year: number, month0: number) => {
    setPickerOpen(false);
    void fetchMonth(year, month0);
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
      const years = [...allMonths].map((k) => Number(k.split("-")[0])).filter((y) => !Number.isNaN(y));
      const newest = years.sort((a, b) => b - a)[0];
      if (newest != null) setPickerYear(newest);
    }
    setPickerOpen((v) => !v);
  };

  // 文件夹多选：切换某文件夹后重新拉取（至少保留一个）。
  // 切换所选文件夹：按新文件夹重拉列表与月份（「根据当前选择的文件夹拉取」）。
  const toggleFolder = (name: string) => {
    const next = folders.includes(name) ? folders.filter((f) => f !== name) : [...folders, name];
    const final = next.length ? next : ["INBOX"];
    setFolders(final);
    void fetchInbox(scopeAccount, final);
    if (repAccount) void loadMonths(repAccount, final);
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

  // 点击「保存位置」选择器外部关闭。
  useEffect(() => {
    if (!saveParentOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (saveParentRef.current?.contains(t)) return;
      setSaveParentOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [saveParentOpen]);

  // 点击发件人下拉外部关闭。

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
    dragTouched.current = true;
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
  const provider = scopeAccount ? providerLabel(scopeAccount.username) : "全部账号";
  const activeAcc = accountFor(active);
  // 可信发件人：当前邮件发件人域名在 trusted_domains 内 → 自动放行远程图片。
  const isTrusted = !!active && !!activeAcc && activeAcc.trusted_domains.includes(emailDomainOf(active.from));
  const effectiveShowImages = showImages || isTrusted;

  // 测量工具栏各按钮组的实际宽度，用于逐级收纳（P+Q+R / P+Q+「更多」 / P+「更多」）。
  // 依赖按钮文本随 active/useRich/html/isTrusted/showImages 变化。
  useEffect(() => {
    const GAP = 4;
    const measure = () => {
      const cw = measureCoreRef.current?.getBoundingClientRect().width ?? 0;
      const aw = measureActionRef.current?.getBoundingClientRect().width ?? 0;
      const rw = measureRightRef.current?.getBoundingClientRect().width ?? 0;
      const mw = measureMoreRef.current?.getBoundingClientRect().width ?? 0;
      setNeed({
        full: Math.ceil(cw + aw + rw + GAP * 2),
        coreAction: Math.ceil(cw + aw + mw + GAP * 2),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (measureCoreRef.current) ro.observe(measureCoreRef.current);
    if (measureActionRef.current) ro.observe(measureActionRef.current);
    if (measureRightRef.current) ro.observe(measureRightRef.current);
    if (measureMoreRef.current) ro.observe(measureMoreRef.current);
    return () => ro.disconnect();
  }, [active, useRich, html, isTrusted, showImages]);

  // 测量顶部标题栏三组实际宽度：副标题是否隐藏（headSub）、工具是否收起（headTool），
  // 替代固定阈值 720/560。文案随 folders / 账号变化；30 = .email-page-head 左右 padding(16*2)。
  useEffect(() => {
    const GAP = 12; // .email-page-head gap
    const measure = () => {
      const tw = measureHeadTitleRef.current?.offsetWidth ?? 0;
      const sw = measureHeadSubRef.current?.offsetWidth ?? 0;
      const aw = measureHeadActionsRef.current?.offsetWidth ?? 0;
      setHeadNeed({
        sub: Math.ceil(tw + sw + aw + GAP * 2),
        tool: Math.ceil(tw + aw + GAP),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (measureHeadActionsRef.current) ro.observe(measureHeadActionsRef.current);
    if (measureHeadTitleRef.current) ro.observe(measureHeadTitleRef.current);
    return () => ro.disconnect();
  }, [folders, scopeAccount]);
  // 信任当前发件人域名：加入持久化配置并立即生效。
  const trustSender = async () => {
    const acc = accountFor(active);
    if (!acc || !active) return;
    const dom = emailDomainOf(active.from);
    if (!dom) return;
    const next = [...new Set([...(acc.trusted_domains ?? []), dom])];
    const updated = { ...acc, trusted_domains: next };
    patchAccount(updated);
    setShowImages(true);
    try {
      await api.emailSaveAccount(updated);
      toast(`已信任 ${dom}`, "success");
    } catch (e) {
      setErr(String(e));
    }
  };
  const colTemplate = `26px ${fromW}px minmax(${subjectW}px, 1fr) minmax(72px, max-content) 24px`;
  // 左侧栏较窄时改用两行布局（首行 发件人+时间，二行 主题），否则用三列网格。
  // 阈值按三列的实际最小需求（拖动列宽后仍准确），而非固定 380。
  const colMin = 26 + fromW + subjectW + 72 + 24 + 16;
  const narrow = listW < colMin;
  const colTemplateNarrow = "32px 1fr"; // 勾选 | 内容区(两行)；窄布局不显示星标
  // 阅读区工具栏逐级收纳（阈值按按钮组实测宽度，而非固定常量）：
  //   宽 → P+Q+R 全显；中 → R 收进「更多」（P+Q+更多）；窄 → Q 也收进「更多」（P+更多）。
  const toolbarNarrow = toolbarW < need.full;          // 放不下 P+Q+R → R 收紧进「更多」（出现「更多」按钮）
  const toolbarVeryNarrow = toolbarW < need.coreAction; // 放不下 P+Q+「更多」 → Q 也收紧进「更多」
  // 顶部标题栏逐级收纳（阈值按实测内容宽度，而非固定 720/560）：32 = .email-page-head 左右 padding。
  const headSubNarrow = headW < headNeed.sub + 32;
  const headToolNarrow = headW < headNeed.tool + 32;

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
            {accounts.length > 0 && (
              <div className="email-account-tabs">
                <button
                  className={`email-account-tab${scopeKey === null ? " is-active" : ""}`}
                  onClick={() => void switchScope(null)}
                  title="全部账号（聚合收件流）"
                >
                  全部账号
                </button>
                {accounts.map((a) => {
                  const key = accountKey(a);
                  const isOn = scopeKey === key;
                  const label = a.username.split("@")[0] || a.username;
                  return (
                    <button
                      key={`${a.host}|${a.username}`}
                      className={`email-account-tab${isOn ? " is-active" : ""}`}
                      onClick={() => void switchScope(key)}
                      title={`${a.username} · ${a.host}`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
            <header className="email-page-head" ref={pageHeadRef}>
              <div className="email-page-title">
                <span className="email-page-title-text">邮箱</span>
                {!headSubNarrow && <span className="email-page-sub">聚合收件箱 · 邮件即笔记（桌面版）</span>}
              </div>
              <div className="email-page-actions">
                {headToolNarrow ? (
                  <div className="email-head-more-wrap">
                    <button className="sync-btn ghost" onClick={() => setHeadMoreOpen((v) => !v)} aria-haspopup="menu" aria-expanded={headMoreOpen}>
                      更多
                    </button>
                    {headMoreOpen && (
                      <div className="email-read-more-menu" role="menu">
                        <button className="sync-btn ghost email-read-more-item" role="menuitem" onClick={() => { setFolderPickerOpen((v) => !v); setHeadMoreOpen(false); }}>
                          {folders.length === 1 ? folderDisplay(folders[0]) : `已选 ${folders.length} 文件夹`}
                        </button>
                        <button className="sync-btn ghost email-read-more-item" role="menuitem" disabled={busy || accounts.length === 0} onClick={() => { void refresh(); setHeadMoreOpen(false); }}>
                          <RefreshIcon width={14} height={14} /> 拉取
                        </button>
                        <button className="sync-btn ghost email-read-more-item" role="menuitem" onClick={() => { closePanel(); useEditorStore.getState().openSettings("email"); setHeadMoreOpen(false); }}>
                          <SettingsIcon width={14} height={14} /> 设置
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
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
                    <button className="sync-btn ghost" disabled={busy || accounts.length === 0} onClick={() => void refresh()}>
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
                  </>
                )}
                <button className="sync-btn ghost" onClick={closePanel} aria-label="关闭">✕</button>
              </div>
            </header>

            {/* 头部隐藏测量基准：量出标题/副标题/工具组实际宽度，供 headSub/headTool 收纳阈值使用（不占布局）。 */}
            <div className="email-read-measure" aria-hidden="true">
              <span ref={measureHeadTitleRef} className="email-page-title-text">邮箱</span>
              <span ref={measureHeadSubRef} className="email-page-sub" style={{ maxWidth: "none" }}>聚合收件箱 · 邮件即笔记（桌面版）</span>
              <div ref={measureHeadActionsRef} className="email-page-actions">
                <span className="sync-btn ghost">{folders.length === 1 ? folderDisplay(folders[0]) : `已选 ${folders.length} 文件夹`}</span>
                <span className="sync-btn ghost"><RefreshIcon width={14} height={14} /> 拉取</span>
                <span className="sync-btn ghost"><SettingsIcon width={14} height={14} /> 设置</span>
              </div>
            </div>

            <div className="email-page-body">
              {accounts.length === 0 && (
                <div className="email-page-empty">请先在 <b>设置 → 邮箱</b> 配置 IMAP 账号。</div>
              )}

              {accounts.length > 0 && (
                <div className="email-split" ref={splitRef}>
                  <div className="email-pane-list" style={{ width: listW }} ref={listScrollRef} onScroll={onListScroll}>
                    <div className="email-list-head">
                      <span className="email-list-head-title">邮件{provider ? ` · ${provider}` : ""}</span>
                      {checked.size > 0 && (
                        <>
                          <button className="email-list-head-delete" disabled={busy} onClick={() => void deleteSelected()}>
                            <TrashIcon width={12} height={12} /> 删除选中（{checked.size}）
                          </button>
                          <button className="email-list-head-op" disabled={busy} onClick={() => void markSelectedRead(true)}>
                            标为已读
                          </button>
                          <button className="email-list-head-op" disabled={busy} onClick={() => void markSelectedRead(false)}>
                            标为未读
                          </button>
                          <button className="email-list-head-op" disabled={busy} onClick={() => void saveSelectedAsNotes()}>
                            存为笔记
                          </button>
                        </>
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
                              const has = allMonths.has(`${pickerYear}-${m}`);
                              return (
                                <button
                                  key={name}
                                  className={`email-month-cell${has && !isAggregate ? " is-avail" : ""}`}
                                  disabled={!has || isAggregate}
                                  title={isAggregate ? "聚合视图下请先切到单账号再按月份直达" : ""}
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
                      <input
                        className="email-search-input"
                        placeholder="搜索发件人/主题…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        aria-label="搜索"
                      />
                    </div>
                    <div className="email-col-head" style={{ gridTemplateColumns: narrow ? colTemplateNarrow : colTemplate }}>
                      <span className="email-col-check" aria-hidden />
                      {narrow ? (
                        <span className="email-col-subject">收发件人 / 主题</span>
                      ) : (
                        <>
                          <span className="email-col-from">发件人<span className="email-col-resizer" onMouseDown={onColResizeDown("from")} /></span>
                          <span className="email-col-subject">主题<span className="email-col-resizer" onMouseDown={onColResizeDown("subject")} /></span>
                          <span className="email-col-date">日期</span>
                        </>
                      )}
                      {!narrow && <span className="email-col-star" aria-hidden />}
                    </div>
                    {filteredList.length === 0 && <div className="email-page-empty">
                      {list.length === 0 ? "暂无邮件，点「拉取收件箱」。" : "没有匹配的邮件（调整关键字试试）。"}
                    </div>}
                    {sections.map((s) => (
                      <div key={s.label} className="email-section">
                        <div className="email-section-label">{s.label}（{s.items.length}封）</div>
                        {s.items.map((m) => (
                          <div
                            key={emailKey(m)}
                            ref={(el) => {
                              if (el) rowRefs.current.set(emailKey(m), el);
                              else rowRefs.current.delete(emailKey(m));
                            }}
                            className={`email-item${active && emailKey(active) === emailKey(m) ? " is-selected" : ""}${narrow ? " is-narrow" : ""}${!m.seen ? " is-unread" : ""}`}
                            style={{ gridTemplateColumns: narrow ? colTemplateNarrow : colTemplate }}
                            onClick={() => void selectEmail(m)}
                          >
                            <span
                              className={`email-check${checked.has(emailKey(m)) ? " is-checked" : ""}`}
                              role="checkbox"
                              aria-checked={checked.has(emailKey(m))}
                              tabIndex={-1}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleChecked(emailKey(m));
                              }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            </span>
                            {narrow ? (
                              <div className="email-item-body">
                                <div className="email-item-line1">
                                  <span className="email-item-from" title={m.from}>{senderNameOf(m.from)}</span>
                                  <span className="email-item-date">{fmtListTime(m)}</span>
                                </div>
                                <div className="email-item-subject" title={m.subject}>{isAggregate && renderAccountChip(m)}<span className="email-item-subject-text">{m.subject || "(无主题)"}</span></div>
                              </div>
                            ) : (
                              <>
                                <span className="email-item-from" title={m.from}>{senderNameOf(m.from)}</span>
                                <span className="email-item-subject" title={m.subject}>{isAggregate && renderAccountChip(m)}<span className="email-item-subject-text">{m.subject || "(无主题)"}</span></span>
                                <span className="email-item-date">{fmtListTime(m)}</span>
                              </>
                            )}
                            {!narrow && (
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
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                    {hasMore && (
                      <div className="email-list-more">
                        {busy ? "加载中…" : "下拉加载更多"}
                      </div>
                    )}
                  </div>

                  <div className="email-divider" role="separator" aria-orientation="vertical" onMouseDown={onDividerDown}>
                    <span className="email-divider-grip" aria-hidden>⋮⋮</span>
                  </div>

                  <div className="email-pane-read" ref={readPaneRef}>
                    <div className="email-read-toolbar" ref={readToolbarRef}>
                      <div className="email-save-parent-wrap" ref={saveParentRef}>
                        <button className="sync-btn ghost" disabled={busy || !active} onClick={() => setSaveParentOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={saveParentOpen} title="选择保存位置">
                          <BookmarkIcon width={14} height={14} /> 保存到…
                        </button>
                        {saveParentOpen && (
                          <div className="email-save-parent-menu" role="listbox" aria-label="选择保存位置">
                            <label className={`email-save-parent-item${saveParentId === "root" ? " is-on" : ""}`}>
                              <input type="checkbox" checked={saveParentId === "root"} onChange={() => { setSaveParentId("root"); setSaveParentOpen(false); }} />
                              <span className="email-save-parent-name">根目录</span>
                            </label>
                            {renderSaveTree("root", 0)}
                          </div>
                        )}
                      </div>
                      <button
                        className="sync-btn ghost"
                        disabled={busy || !active}
                        onClick={() => active && void saveUid(active.uid)}
                      >
                        <BookmarkIcon width={14} height={14} /> 存为笔记
                      </button>
                      <button className="sync-btn ghost" disabled={busy || !active} onClick={() => void saveAsTask()}>
                        存为任务
                      </button>
                      <button className="sync-btn ghost" disabled={busy || !active} onClick={() => void saveAttachments()}>
                        存附件
                      </button>
                      {!toolbarVeryNarrow && (
                        <button className="sync-btn ghost" disabled={busy || !active} onClick={() => openCompose("reply")}>
                          <SendIcon width={14} height={14} /> 回复
                        </button>
                      )}
                      {!toolbarVeryNarrow && (
                        <button className="sync-btn ghost" disabled={busy || !active} onClick={() => openCompose("forward")}>
                          <SendIcon width={14} height={14} /> 转发
                        </button>
                      )}
                      {!toolbarVeryNarrow && (
                        <button
                          className={`sync-btn ghost${active?.seen ? "" : " is-active"}`}
                          disabled={busy || !active}
                          onClick={() => active && void markRead(active, !active.seen)}
                        >
                          {active?.seen ? "标为未读" : "标为已读"}
                        </button>
                      )}
                      {!toolbarVeryNarrow && (
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
                      )}
                      <span className="email-read-toolbar-spacer" />
                      {toolbarNarrow ? (
                        <div className="email-read-more-wrap">
                          <button className="sync-btn ghost" disabled={!active} onClick={() => setMoreOpen((v) => !v)} aria-haspopup="menu" aria-expanded={moreOpen}>
                            更多
                          </button>
                          {moreOpen && (
                            <div className="email-read-more-menu" role="menu">
                              {toolbarVeryNarrow && (
                                <>
                                  <button className="sync-btn ghost email-read-more-item" role="menuitem" disabled={!active} onClick={() => { openCompose("reply"); setMoreOpen(false); }}>
                                    <SendIcon width={14} height={14} /> 回复
                                  </button>
                                  <button className="sync-btn ghost email-read-more-item" role="menuitem" disabled={!active} onClick={() => { openCompose("forward"); setMoreOpen(false); }}>
                                    <SendIcon width={14} height={14} /> 转发
                                  </button>
                                  <button className="sync-btn ghost email-read-more-item" role="menuitem" disabled={!active} onClick={() => { active && void markRead(active, !active.seen); setMoreOpen(false); }}>
                                    {active?.seen ? "标为未读" : "标为已读"}
                                  </button>
                                  <button className="sync-btn ghost email-read-more-item" role="menuitem" disabled={!active} onClick={() => { if (active && window.confirm("确定把该邮件移到已删除？")) void deleteEmail(active); setMoreOpen(false); }}>
                                    <TrashIcon width={14} height={14} /> 删除
                                  </button>
                                </>
                              )}
                              {useRich && html && (
                                <button className="sync-btn ghost email-read-more-item" role="menuitem" disabled={!active} onClick={() => { setShowImages((v) => !v); setMoreOpen(false); }}>
                                  {showImages ? "屏蔽图片" : "显示图片"}
                                </button>
                              )}
                              <button className="sync-btn ghost email-read-more-item" role="menuitem" disabled={!active || isTrusted} onClick={() => { void trustSender(); setMoreOpen(false); }}>
                                {isTrusted ? "已信任" : "信任此发件人"}
                              </button>
                              <button className="sync-btn ghost email-read-more-item" role="menuitem" disabled={!active} onClick={() => { setUseRich((v) => !v); setMoreOpen(false); }}>
                                {useRich ? "纯文本" : "富文本"}
                              </button>
                            </div>
                          )}
                        </div>
                      ) : (
                        <>
                          {useRich && html && (
                            <button className="sync-btn ghost" disabled={!active} onClick={() => setShowImages((v) => !v)}>
                              {showImages ? "屏蔽图片" : "显示图片"}
                            </button>
                          )}
                          <button className="sync-btn ghost" disabled={!active || isTrusted} onClick={() => void trustSender()}>
                            {isTrusted ? "已信任" : "信任此发件人"}
                          </button>
                          <button className="sync-btn ghost" disabled={!active} onClick={() => setUseRich((v) => !v)}>
                            {useRich ? "纯文本" : "富文本"}
                          </button>
                        </>
                      )}
                    </div>

                    {/* 隐藏测量基准：反映当前按钮文本的真实宽度，供逐级收纳阈值使用（不参与布局/交互）。 */}
                    <div className="email-read-measure" aria-hidden="true">
                      <div ref={measureCoreRef} className="email-read-measure-row">
                        <span className="sync-btn ghost"><BookmarkIcon width={14} height={14} /> 保存到…</span>
                        <span className="sync-btn ghost"><BookmarkIcon width={14} height={14} /> 存为笔记</span>
                        <span className="sync-btn ghost">存为任务</span>
                        <span className="sync-btn ghost">存附件</span>
                      </div>
                      <div ref={measureActionRef} className="email-read-measure-row">
                        <span className="sync-btn ghost"><SendIcon width={14} height={14} /> 回复</span>
                        <span className="sync-btn ghost"><SendIcon width={14} height={14} /> 转发</span>
                        <span className="sync-btn ghost">{active?.seen ? "标为未读" : "标为已读"}</span>
                        <span className="sync-btn ghost"><TrashIcon width={14} height={14} /> 删除</span>
                      </div>
                      <div ref={measureRightRef} className="email-read-measure-row">
                        {useRich && html && <span className="sync-btn ghost">{showImages ? "屏蔽图片" : "显示图片"}</span>}
                        <span className="sync-btn ghost">{isTrusted ? "已信任" : "信任此发件人"}</span>
                        <span className="sync-btn ghost">{useRich ? "纯文本" : "富文本"}</span>
                      </div>
                      <div ref={measureMoreRef} className="email-read-measure-row">
                        <span className="sync-btn ghost">更多</span>
                      </div>
                    </div>
                    {active ? (
                      <>
                        <div className="email-read-subject">{active.subject || "(无主题)"}</div>
                        <div className="email-read-meta">
                          <span className="email-read-meta-avatar" aria-hidden>
                            <span className="email-read-meta-avatar-inner" style={{ background: avatarBg(active.from), color: avatarColor(active.from) }}>
                              {senderInitial(active.from)}
                            </span>
                          </span>
                          <span className="email-read-meta-main">
                            <span className="email-read-meta-from">{active.from}</span>
                            <span className="email-read-meta-sub">
                              <span>收件人：{activeAcc?.username ?? ""}</span>
                              <span>{active.date}</span>
                              <span>邮件类型：收件箱</span>
                            </span>
                          </span>
                        </div>
                        <div className="email-ai-summary">
                          {aiSummary ? (
                            <div className="email-ai-summary-block">
                              <div className="email-ai-summary-head">
                                <span>AI 总结</span>
                                <button className="sync-btn ghost" disabled={aiSummaryBusy} onClick={() => void summarizeEmail()}>
                                  {aiSummaryBusy ? "总结中…" : "重新总结"}
                                </button>
                              </div>
                              <div className="email-ai-summary-text">{aiSummary}</div>
                            </div>
                          ) : (
                            <button className="sync-btn ghost" disabled={aiSummaryBusy || !active} onClick={() => void summarizeEmail()}>
                              {aiSummaryBusy ? "总结中…" : "AI 总结"}
                            </button>
                          )}
                        </div>
                        <div className="email-read-body">
                          {loadingBody
                            ? "加载正文…"
                            : useRich && html
                              ? <EmailRichBody html={html} showImages={effectiveShowImages} />
                              : body
                                ? <EmailBody text={body} />
                                : err
                                  ? ""
                                  : "（正文为空）"}
                        </div>
                        {compose && (
                          <div className="email-compose-inline">
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
                              <textarea ref={composeBodyRef} id="email-body" className="set-input" value={compose.body} onChange={(e) => setCompose({ ...compose, body: e.target.value })} />
                            </div>
                            <label className="email-compose-quote">
                              <input
                                type="checkbox"
                                checked={compose.includeQuote}
                                onChange={(e) => {
                                  const on = e.target.checked;
                                  setCompose((c) => {
                                    if (!c) return c;
                                    // 切到不引用：去掉引用前缀；切回：重新加回。
                                    let body = c.body;
                                    const q = c.quote;
                                    if (on && !body.startsWith(q)) body = q + body;
                                    else if (!on && body.startsWith(q)) body = body.slice(q.length);
                                    return { ...c, includeQuote: on, body };
                                  });
                                }}
                              />
                              引用原文
                            </label>
                            <div className="email-compose-actions">
                              <span className="email-compose-hint">
                                {compose.mode === "forward" ? "转发需手动填写收件人；引用原文已附上。" : "回复默认给原发件人。请先在 设置→邮箱 填好 SMTP 发信信息。"}
                              </span>
                              <button className="sync-btn primary" disabled={sending || !compose.to.trim()} onClick={() => void sendCompose()}>
                                {sending ? "发送中…" : "发送"}
                              </button>
                            </div>
                          </div>
                        )}
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
