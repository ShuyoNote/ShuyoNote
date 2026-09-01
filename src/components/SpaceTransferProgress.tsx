import { useSpaceTransfer } from "../store/spaceTransfer";

// 空间导出/导入的全局进度条：固定在窗口底部，与哪个面板开着无关——
// 迁移一个大空间可能几十秒，用户关掉设置后仍应看得到进度。
export function SpaceTransferProgress() {
  const progress = useSpaceTransfer((s) => s.progress);
  if (!progress) return null;
  const pct = Math.min(100, Math.round((progress.done / Math.max(1, progress.total)) * 100));
  return (
    <div className="space-export-overlay">
      <div className="space-export-progress">
        <div className="space-export-progress-label">
          <span>{progress.message}</span>
          <span>{pct}%</span>
        </div>
        <div className="space-export-progress-track">
          <div className="space-export-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
