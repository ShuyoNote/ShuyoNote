/**
 * 相对时间（移动端多处要用：首页「最近笔记」／搜索结果的元信息行 ✓）。
 *
 * ⚠️ 出处：原来是 `src/components/MobileHome.tsx` 里的**局部函数**（当时注释写着
 * 「哪天第二处要用，再抽到 `src/lib/` ✓（别现在造抽象 ✗）」）。2026-10-10 做 **03 搜索屏**
 * 时出现了**第二处**（结果卡的「12 分钟前」档 ✓）⇒ 按那句话抽到这里 ✓ ——
 * 两处各留一份就会漂（同一句话在两张屏上显示成不同的写法 ✗）。
 *
 * 效果图 `01-home.svg` / `03-search.svg` 用到的三档：`12 分钟前` / `昨天 21:40` / `10 月 6 日` ✓。
 * ⚠️ 入参是**毫秒时间戳**（`PageMeta.updated_at` ✓，与 `types.ts` 一致 ✓）。
 */
export function timeAgo(ms: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const min = 60_000;
  if (diff < min) return "刚刚";
  if (diff < 60 * min) return `${Math.floor(diff / min)} 分钟前`;
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return `今天 ${hhmm}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (y.toDateString() === d.toDateString()) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
