import { fromDatetimeLocalValue, toDatetimeLocalValue } from "../lib/dateTimeValue";

/**
 * 「时间」属性（`attr_type = "datetime"`）的编辑器：**一个原生日期时间控件，一个多余的按钮都没有**。
 *
 * ## 沿革（两次 owner 反馈，方向相反，别再来回翻）
 *
 * · 2026-09-21 owner：「时间咋回事？」——当时这一行**并排两个框**（原生选择器 ＋ 手输框），
 *   同一个时刻显示了两遍。那一轮的办法是：把原生框藏成 1px（**不能 `display:none`**，
 *   那样 `showPicker()` 会抛），只留手输框，右侧再挂一枚日历图标按钮去开原生选择器。
 * · 2026-09-22 owner：「页面时间属性的控件采用和日期一样风格的控件，不要再额外加按钮」
 *   —— 于是回到**原生控件本身**：`<input type="datetime-local" step="1">`。
 *   它和「日期」属性（`<input type="date">`）是同一个风格、同样没有额外按钮；
 *   数据库视图里那一列本来就是这么渲染的（`DatabaseView` 的 datetime 分支），现在两处一致。
 *
 * ⚠️ 这次取舍要记住：原生控件**不接受手输中文格式**（「2008年5月9日 15:30:00」，
 * 手输那条路是 2026-09-21 那次加上、这次按要求去掉的）。值层没有跟着删：
 * `lib/dateTimeValue` 里的容错解析（`parseDateTimeInput`）与显示格式化（`formatDateTimeDisplay`）
 * 都还在、也有单测 —— 哪天要恢复"手输框 + 点一下开选择器"那条路，解析不用重写。
 *
 * 清除语义与数据库视图一致：框被清空 ⇒ 写空串（**有意删除该属性值**），不是"非法值"。
 */
export function DatetimeValueEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="datetime-local"
      step="1"
      className="prop-value"
      title="选择日期与时刻（可精确到秒）"
      value={toDatetimeLocalValue(value)}
      onChange={(e) => onChange(fromDatetimeLocalValue(e.target.value) ?? "")}
    />
  );
}
