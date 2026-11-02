// ⭐ B2：属性值类型化展示的**纯函数**（面板只负责渲染，这里负责格式/省略/时区/相对时间）。
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 来源之类 URL：无协议补 `https://`；展示时**省略中段**；复制保留原始输入。 */
export function formatUrl(raw: unknown): { href: string; display: string; copyText: string } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  const href = SCHEME.test(text) ? text : `https://${text}`;
  try {
    new URL(href);
  } catch {
    return null;
  }
  const display = displayMiddle(text, 48);
  return { href, display, copyText: text };
}

/** 中段省略：`前 24 + … + 后 20`（短串原样）。 */
export function displayMiddle(s: string, max = 48): string {
  if (s.length <= max) return s;
  const head = Math.max(8, Math.ceil((max - 1) * 0.55));
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

const TZ = "Asia/Shanghai";
/** 固定展示 +08:00（产品当前只面向中国区；要全球化时这里改成按 locale）。 */
export const DISPLAY_TZ = "+08:00";

function parseDate(value: string): Date | null {
  const s = value.trim();
  if (!s) return null;
  // 「YYYY-MM-DD HH:mm[:ss]」（无时区）按 +08:00 解释，避免被宿主时区带偏。
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se ?? "00"}+08:00`);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `date` / `datetime`：绝对到**分钟**（Asia/Shanghai）＋ `+08:00` ＋ 相对时间。
 * `now` 可注入（判据不靠真实时钟）。
 */
export function formatDateTime(
  value: unknown,
  now: number = Date.now(),
): { absolute: string; relative: string; timezone: string; iso: string } | null {
  if (typeof value !== "string") return null;
  const d = parseDate(value);
  if (!d) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const absolute = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  const diffMin = Math.round((d.getTime() - now) / 60000);
  let relative: string;
  if (Math.abs(diffMin) < 1) relative = "刚刚";
  else if (diffMin > 0) {
    if (diffMin < 60) relative = `${diffMin} 分钟后`;
    else if (diffMin < 1440) relative = `${Math.round(diffMin / 60)} 小时后`;
    else relative = `${Math.round(diffMin / 1440)} 天后`;
  } else {
    const ago = -diffMin;
    if (ago < 60) relative = `${ago} 分钟前`;
    else if (ago < 1440) relative = `${Math.round(ago / 60)} 小时前`;
    else relative = `${Math.round(ago / 1440)} 天前`;
  }
  return { absolute, relative, timezone: DISPLAY_TZ, iso: d.toISOString() };
}

/** 作者类属性：person chip 的标签/首字。 */
export function formatPerson(value: unknown): { label: string; initial: string } | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label) return null;
  return { label, initial: Array.from(label)[0] ?? "?" };
}
