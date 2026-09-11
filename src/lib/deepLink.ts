// 深链（`shuyonote://`）解析 —— **纯函数**：不碰 DOM、不联网、不落库。
//
// 为什么单独一层：社区页面上那三个入口（存进笔记 / 导入配方 / 起一份草稿）最后都会变成
// 操作系统交给应用的一段字符串。而**外部内容触发的字符串必须先被判定，再交给有副作用的那一步**：
// 解析层只回答"这是什么动作、参数合不合法"，抓取与落库在别处。这样"失败要有话说"
// （方案第七节的三条硬约束之一）才可能被测试钉住——见 `deepLink.test.ts`。
//
// 与插件索引那条规则**故意不同**，理由要写清楚：
//   · 索引地址是**用户自己手填**的，所以允许 `http://127.0.0.1` 方便自托调试；
//   · 深链是**网页发出的**——一个用户恰好访问的页面就能让应用去 fetch 本机地址（SSRF 打自己）。
//     所以这里**不接受回环**：要本地调试就在应用里手填地址，不要给网页这个能力。
//     同理：只放行 https、只放行显式列出的主机、拒带凭据的 URL、拒非默认端口。

/** 社区主机（深链里允许的来源）。要加镜像域就在这一处**逐个列**，不用通配。 */
export const DEEP_LINK_HOSTS = ["community.shuyo.cn"];

/** 整条链接的长度上限：超过它基本可以断定是被截断过的（OS/浏览器对 URL 有实际上限）。 */
export const MAX_DEEP_LINK_LEN = 4096;

/** 标题上限（防"把整篇帖子塞进 title"）。 */
export const MAX_COMPOSE_TITLE = 200;

/**
 * 分享摘要上限（300 字）。
 *
 * 方案里定的是"只带摘要 + 原帖链接"：`compose` 的 `body` **不是正文**。整篇正文也不该走 URL——
 * 它会被静默截断，用户看到的是"内容莫名少了一半"。所以超过这个长度不是截断，而是**拒绝并说明**。
 *
 * 为什么是 300 而不是 500：一个汉字百分号编码后是 **9 个字符**（`%E6%8A%80`），
 * 300 字 ≈ 2700 字符，离整条链接 4096 的上限还有余量；500 字会先撞上"链接过长"，
 * 于是报的原因就成"链接太长"而不是"正文请留在原帖"——那对发链接的人没有指导意义。
 */
export const MAX_COMPOSE_BODY = 300;

export type DeepLinkAction =
  /** 应用内部链接：打开某一页（历史上 `DrawingEditorModal` 就是这么生成链接的）。 */
  | { kind: "page"; pageId: string }
  /** 把一篇社区帖子存成笔记：先抓取 → 弹预览 → 人确认后落库。 */
  | { kind: "save"; url: string }
  /** 导入配方 / 主题 / 模板：先给清单（是什么、来自谁、要什么权限）→ 确认后导入。 */
  | { kind: "import"; url: string }
  /** 在应用里起一份草稿：内容由人确认后再发。 */
  | { kind: "compose"; title: string; body: string };

export type DeepLinkResult = { ok: true; action: DeepLinkAction } | { ok: false; reason: string };

const ACTIONS = ["save", "import", "compose", "page"] as const;

/** 页面 id：非空、短、只含 URL 安全的字符（应用里的 id 是 uuid 形态）。 */
function isPageId(v: string): boolean {
  return v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
}

/**
 * 校验深链里的目标地址。
 *
 * 返回规范化后的 URL（去空白、`new URL().href`）或一句人话的原因。
 * 只看**字面**主机名，不做 DNS 解析——解析要在真正发请求的那一层做（那里才拿得到落点 IP）。
 */
function checkTargetUrl(raw: string, hosts: readonly string[]): { ok: true; url: string } | { ok: false; reason: string } {
  const value = raw.trim();
  if (!value) return { ok: false, reason: "链接里没有带上地址（`url` 参数是空的）" };
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, reason: `地址不是合法的 URL：${value.slice(0, 80)}` };
  }
  if (u.protocol !== "https:") {
    return { ok: false, reason: `只接受 https 地址（现在是 ${u.protocol.replace(":", "")}）` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: "地址里不能带账号密码" };
  }
  if (u.port && u.port !== "443") {
    return { ok: false, reason: `只接受默认端口（现在是 ${u.port}）` };
  }
  const host = u.hostname.toLowerCase();
  if (!hosts.includes(host)) {
    return { ok: false, reason: `只接受这些来源：${hosts.join("、")}（现在是 ${host}）` };
  }
  return { ok: true, url: u.href };
}

/**
 * 解析一段 `shuyonote://` 链接。
 *
 * 手写拆分而不是 `new URL`：自定义 scheme 在 WHATWG 解析里有一堆边界（`shuyonote:save?x=1`
 * 没有 `//`、`page/<id>` 的 id 落在 path 里），手写反而只有一条路径、便于逐条测。
 * 认两种写法：`shuyonote://save?url=…` 与 `shuyonote:save?url=…`。
 */
export function parseDeepLink(raw: string, hosts: readonly string[] = DEEP_LINK_HOSTS): DeepLinkResult {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "链接是空的" };
  if (text.length > MAX_DEEP_LINK_LEN) {
    return { ok: false, reason: `链接过长（${text.length} 字符，上限 ${MAX_DEEP_LINK_LEN}）` };
  }
  const m = /^shuyonote:(\/\/)?([^?#]*)(?:\?([^#]*))?/i.exec(text);
  if (!m) {
    return { ok: false, reason: "这不是 ShuyoNote 的链接（应以 shuyonote:// 开头）" };
  }
  const path = (m[2] ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  const params = new URLSearchParams(m[3] ?? "");
  const [nameRaw, ...rest] = path.split("/");
  const name = (nameRaw ?? "").toLowerCase();
  if (!name) return { ok: false, reason: `链接里没说要做什么（支持：${ACTIONS.join(" / ")}）` };

  switch (name) {
    case "page": {
      const id = rest.filter(Boolean).join("/");
      if (!isPageId(id)) return { ok: false, reason: `页面 id 不合法：${id.slice(0, 40) || "（空）"}` };
      return { ok: true, action: { kind: "page", pageId: id } };
    }
    case "save":
    case "import": {
      const target = checkTargetUrl(params.get("url") ?? "", hosts);
      if (!target.ok) return { ok: false, reason: target.reason };
      return { ok: true, action: { kind: name, url: target.url } };
    }
    case "compose": {
      const title = (params.get("title") ?? "").trim();
      const body = (params.get("body") ?? "").trim();
      if (!title && !body) return { ok: false, reason: "链接里既没有标题也没有摘要，起不了草稿" };
      if (title.length > MAX_COMPOSE_TITLE) {
        return { ok: false, reason: `标题过长（${title.length} 字，上限 ${MAX_COMPOSE_TITLE}）` };
      }
      if (body.length > MAX_COMPOSE_BODY) {
        return {
          ok: false,
          reason: `分享只带摘要（上限 ${MAX_COMPOSE_BODY} 字），正文请留在原帖——整篇正文走 URL 会被静默截断`,
        };
      }
      return { ok: true, action: { kind: "compose", title, body } };
    }
    default:
      return { ok: false, reason: `不认识的深链动作「${nameRaw}」（支持：${ACTIONS.join(" / ")}）` };
  }
}

/**
 * 一句话描述一个动作，给"确认框 / 提示条"用（措辞与插件安装保持一致：先说是什么、再说来自谁）。
 */
export function describeDeepLink(action: DeepLinkAction): string {
  switch (action.kind) {
    case "page":
      return "打开这一页";
    case "save":
      return `把这篇帖子存成笔记（来源：${new URL(action.url).hostname}）`;
    case "import":
      return `导入一个配方 / 主题 / 模板（来源：${new URL(action.url).hostname}）`;
    case "compose":
      return "起一份草稿（内容由你确认后再发）";
  }
}
