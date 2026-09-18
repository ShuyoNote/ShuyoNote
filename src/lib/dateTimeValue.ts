/** 「时间」属性（`attr_type = "datetime"`）的**值层**：解析 / 校验 / 显示格式化。
 *
 * ## 为什么单独一个文件
 *
 * 这个类型要在**两处**用（`PropertiesPanel` 的页面属性、`DatabaseView` 的数据库列），
 * 且要**同时**支持"点选择器"与"手输中文格式"两条输入路径
 * ⇒ 解析与格式化必须是**一份实现**，否则两条路径迟早不一致。
 *
 * ## 存储形式（**规范形式**）
 *
 * `YYYY-MM-DD HH:mm:ss`（本地时间，无时区），例如 `2008-05-09 15:30:00`。
 * 选它的理由：
 * - 与现有 `date` 类型的 `YYYY-MM-DD` **同族** ⇒ 字符串排序 == 时间排序（筛选/分组不用特殊处理）；
 * - **不存 `ISO 的 T 形式/不存时区**：这是"用户填的一个时间点"，不是"某一瞬间"，
 *   带时区会把"2008年5月9日 15:30"在换机器/换时区后显示成别的时间。
 *
 * ## 输入容错（用户会怎么敲）
 *
 * - 中文：`2008年5月9日 15:30:00` / `2008年5月9日15:30` / `2008年5月9日`
 * - 数字：`2008-5-9 15:30` / `2008/05/09 15:30:00` / `2008.5.9`
 * - 规范：`2008-05-09 15:30:00`
 * - 只有日期 ⇒ 时间补 `00:00:00`；只有到分 ⇒ 秒补 `00`
 */

/** 规范存储形式的正则。 */
export const DATETIME_STORE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 该年该月有多少天（含闰年）。用于挡住 `2008-02-30` 这类"月份对但日子不存在"。 */
function daysInMonth(year: number, month1to12: number): number {
  // 第 0 天 = 上个月最后一天
  return new Date(year, month1to12, 0).getDate();
}

/** 组件是否构成一个真实存在的时刻（含闰年与月末校验）。 */
function isRealDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  return true;
}

/**
 * 解析用户输入 → 规范存储串；**解析不出或不是真实时刻就返回 `null`**
 * （调用方据此提示"格式不对/日期不存在"，而不是静默存一个坏值）。
 */
export function parseDateTimeInput(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  // ① 中文：2008年5月9日 [15:30[:00]]
  const cn = s.match(
    /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:(\d{1,2})\s*[:：]\s*(\d{1,2})(?:\s*[:：]\s*(\d{1,2}))?)?$/,
  );
  // ② 数字：2008-5-9 / 2008/5/9 / 2008.5.9 [15:30[:00]]
  const num = cn
    ? null
    : s.match(
        /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2})\s*[:：]\s*(\d{1,2})(?:\s*[:：]\s*(\d{1,2}))?)?$/,
      );
  const m = cn ?? num;
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // 只给到日期或到分时，缺的部分补 0（`2008年5月9日` ⇒ 00:00:00）
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);

  if (!isRealDateTime(year, month, day, hour, minute, second)) return null;
  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

/** 是不是**规范存储形式**（读旧数据/外部写入时用；不负责容错，只管"合不合法"）。 */
export function isValidDateTime(store: string): boolean {
  if (!DATETIME_STORE_RE.test(store ?? "")) return false;
  return parseDateTimeInput(store) === store;
}

/**
 * 规范存储串 → 给人看的显示形式：`2008年5月9日 15:30:00`。
 *
 * 注意**月/日不补零、时分秒补零**（与用户给的样例一致）。非法输入原样返回，
 * 避免"把坏数据显示成看起来正常的东西"（那会让问题更难发现）。
 */
export function formatDateTimeDisplay(store: string): string {
  const m = (store ?? "").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return store ?? "";
  const [, y, mo, d, h, mi, se] = m;
  return `${Number(y)}年${Number(mo)}月${Number(d)}日 ${h}:${mi}:${se}`;
}

/**
 * 规范存储串 → `<input type="datetime-local">` 的 `value`（`YYYY-MM-DDTHH:mm:ss`）。
 * 供"选择器"那条输入路径用；与 [`parseDateTimeInput`] 互为反向。
 */
export function toDatetimeLocalValue(store: string): string {
  return isValidDateTime(store) ? store.replace(" ", "T") : "";
}

/** `<input type="datetime-local">` 的 `value` → 规范存储串（选择器改完回写用）。 */
export function fromDatetimeLocalValue(value: string): string | null {
  return parseDateTimeInput((value ?? "").replace("T", " "));
}
