import { AiSettingsForm } from "./AiSettingsForm";

// AI 助手面板里的独立配置对话框：只负责遮罩 + 容器，表单本体在
// `AiSettingsForm`（与设置中心「AI」页共用同一份实现）。
export function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="ai-settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ai-settings">
        <div className="ai-settings-title">AI 设置</div>
        <AiSettingsForm onDone={onClose} />
      </div>
    </div>
  );
}
