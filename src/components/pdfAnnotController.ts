// 方案 B — 顶部批注工具栏与当前页之间的控制器接口。
// 每页 PdfAnnotationCanvas 挂载时通过 registerController 注册自己的句柄，
// 卸载时注销；顶部工具栏作用于 currentPage 对应的句柄。
import type { PdfAnnotation } from "../lib/pdfAnnotation";

export type AnnotTool = "select" | "highlight" | "ink" | "sticky";

/** 当前页句柄暴露给顶部工具栏的只读快照（用于渲染选中区按钮/禁用态）。 */
export interface PdfPageState {
  /** 当前选中标注的 id（无则为 null）。 */
  selected: string | null;
  /** 选中标注的类型（便签/高亮…），用于决定是否显示「编辑便签」。 */
  selectedType: PdfAnnotation["type"] | null;
  /** 本页批注数量（导出按钮禁用态）。 */
  annotationsCount: number;
  /** 是否有可撤销的历史。 */
  canUndo: boolean;
  /** 是否有文本层（状态条 + OCR 按钮可见性）。 */
  hasTextLayer: boolean;
  /** OCR 识别进行中（按钮加载态）。 */
  ocrBusy: boolean;
  /** AI 帮读进行中。 */
  aiBusy: boolean;
}

/** 当前页句柄：顶部工具栏调用这些方法（作用于当前活动页）。 */
export interface PdfPageController {
  /** 拉取最新状态快照。 */
  getState(): PdfPageState;
  setTool(t: AnnotTool): void;
  undo(): void;
  exportAnnotations(): void;
  deleteSelected(): void;
  excerpt(): void;
  aiRead(): void;
  copyRef(): void;
  editSticky(): void;
  runOcr(): void;
  /** 本页状态变化时通知顶部工具栏刷新（由页内组件触发）。 */
  notify(): void;
}

export const TOOLS: { id: AnnotTool; label: string; hint: string }[] = [
  { id: "select", label: "选择", hint: "点击选中已有标注" },
  { id: "highlight", label: "高亮", hint: "拖选文字/区域高亮（有文本层会精确划词）" },
  { id: "ink", label: "画笔", hint: "自由手绘标注" },
  { id: "sticky", label: "便签", hint: "在页面任意处添加便签" },
];
