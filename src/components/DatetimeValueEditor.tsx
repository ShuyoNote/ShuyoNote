import { useEffect, useRef, useState } from "react";
import {
  formatDateTimeDisplay,
  fromDatetimeLocalValue,
  parseDateTimeInput,
  toDatetimeLocalValue,
} from "../lib/dateTimeValue";

/**
 * 「时间」属性（`attr_type = "datetime"`）的编辑器：**一行只有一个可见的输入框**。
 *
 * ## 为什么不再是"两个框"
 * 这个编辑器原来在**同一行并排**摆了两个装着同一时刻的输入框 —— 原生选择器
 * （`<input type="datetime-local">`）＋ 手输框（认「2008年5月9日 15:30:00」）。
 * 两条输入路径本身都是要的（见 `lib/dateTimeValue` 头注：点选择器 / 手输中文格式），
 * 但**并排两个框看起来像出了 bug** —— owner 2026-09-21 的原话就是「时间咋回事？」
 * （截图里「发布于」一行两个时间控件，同一个值显示了两遍）。
 *
 * 现在：可见的那个框 = **手输框**（显示"给人看的形态"，例如 `2026年9月20日 11:29:02`，
 * 可直接改，失焦或回车解析）；右侧一枚**日历图标按钮**打开**原生选择器**
 * （2026-09-21 从 `📅` emoji 换成与属性行里那三个图标按钮同一套画法的 SVG：emoji 的尺寸
 * 由字体行高决定，跟 13×13 的线性图标既不搭、也跟那三个 18×18 的方框对不齐）。
 * 原生那枚被藏成 1px（**不能 `display:none`**：那样 `showPicker()` 会抛），
 * 不支持 `showPicker()` 的老 WebView 退化成"聚焦隐藏输入框"，**手输那条路始终可用**,
 * 所以没有任何环境会因为这次改动失去输入能力。
 *
 * 两个刻意的取舍保留：
 * 1. **手输框显示的是「给人看的形态」**，而不是存储形态（`2008-05-09 15:30:00`）；
 * 2. **非法输入不写库**：只在框上加 `is-invalid` 提示，不把坏值静默存进去
 *    （存进去的话，列表/排序/导出都会带着它，事后很难查）。
 */
export function DatetimeValueEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const shown = value ? formatDateTimeDisplay(value) : "";
  const [draft, setDraft] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);
  // 外部值变化（切换页面、别的入口改了同一属性）时同步回输入框，并清掉错误态。
  useEffect(() => {
    setDraft(value ? formatDateTimeDisplay(value) : "");
    setInvalid(false);
  }, [value]);

  const commit = (raw: string) => {
    if (!raw.trim()) {
      // 清空 = 有意删除该属性值（不走"非法"提示）。
      setInvalid(false);
      onChange("");
      return;
    }
    const parsed = parseDateTimeInput(raw);
    if (parsed) {
      setInvalid(false);
      onChange(parsed);
    } else {
      setInvalid(true);
    }
  };

  const openPicker = () => {
    const el = pickerRef.current as (HTMLInputElement & { showPicker?: () => void }) | null;
    if (!el) return;
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
        return;
      } catch {
        // 环境不允许（权限/未渲染）→ 落回聚焦，手输那条路不受影响。
      }
    }
    el.focus();
  };

  return (
    <div className="prop-datetime">
      <input
        type="text"
        className={"prop-value" + (invalid ? " is-invalid" : "")}
        placeholder="2008年5月9日 15:30:00"
        title="可以直接输入：2008年5月9日 15:30:00（或 2008-5-9 15:30）"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <button
        type="button"
        className="prop-datetime-pick"
        title="打开日期选择器（可到秒）"
        aria-label="打开日期选择器（可到秒）"
        onClick={openPicker}
      >
        {/* 图标与属性行里那三个（上移/下移/移除）**同一套画法**：`prop-ico` ＋ 13×13 ＋
            stroke 1.8 ＋ round 拐角。原来这里是一枚 `📅` emoji —— emoji 的字号/行高是字体决定的，
            在按钮里既对不齐那三个 18×18 的方框，观感也和线性 SVG 不是一家（owner 2026-09-21）。 */}
        <svg
          className="prop-ico"
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="18" height="16" rx="2.5" />
          <path d="M8 3v4M16 3v4M3 11h18" />
        </svg>
      </button>
      {/* 原生选择器：**必须在布局里**（1px + 透明），`display:none` 会让 showPicker() 抛 */}
      <input
        ref={pickerRef}
        type="datetime-local"
        step="1"
        tabIndex={-1}
        aria-hidden="true"
        className="prop-datetime-picker"
        value={toDatetimeLocalValue(value)}
        onChange={(e) => {
          const parsed = fromDatetimeLocalValue(e.target.value);
          if (parsed) onChange(parsed);
        }}
      />
      {invalid && (
        <span className="prop-invalid" title="格式或日期不合法（例如 2月30日），未保存">
          !
        </span>
      )}
    </div>
  );
}
