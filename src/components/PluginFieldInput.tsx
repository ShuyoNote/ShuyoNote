import type { PluginCommandParam } from "../types";

/**
 * 按**声明**渲染一个输入控件。
 *
 * 为什么抽出来：命令参数表单（命令面板）与插件设置表单（插件管理）是同一个活儿——
 * 「作者声明了什么类型，就渲染什么控件」。写两份的下场很具体：将来加一种类型
 * （比如多行文本）时只会改到其中一处，另一处静默不认、退回文本框，而没人会立刻发现。
 */
export function PluginFieldInput({
  field,
  value,
  onChange,
  onSubmit,
}: {
  field: PluginCommandParam;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
  /** 在文本框里回车时触发（表单提交用；设置里是"保存这一项"）。 */
  onSubmit?: () => void;
}) {
  if (field.type === "boolean") {
    return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (field.type === "select") {
    return (
      <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
        <option value="">（不指定）</option>
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label || o.value}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type={field.type === "number" ? "number" : "text"}
      placeholder={field.placeholder}
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onSubmit) {
          e.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}
