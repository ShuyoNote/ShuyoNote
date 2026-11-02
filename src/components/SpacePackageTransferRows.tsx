// 设置 → 空间：「备份与迁移」里的空间包（.shuyospace）两组入口。
// 为什么在这里：导出的是**当前空间**、导入的是**另一个空间**（新建），都不是"文件"操作。
// 文案必须说清"导入 = 新建空间，不合并到当前空间"（owner 口径，⛔ 不许让用户以为会覆盖）。
// ⚠️ 与下面「快速搬家（.zip）」的区别要写出来：空间包带 checksums、企业版可直接读。
import { useSpacePackageTransfer } from "../lib/useSpacePackageTransfer";

export function SpacePackageTransferRows() {
  const { busy, warnings, exportSpace, importSpace } = useSpacePackageTransfer();

  return (
    <div data-testid="set-space-transfer">
      <p className="set-hint">
        空间包（<code>.shuyospace</code>）：带校验和、企业版可直接读，适合跨机器/交付；与下面「快速搬家（.zip）」不是同一种格式。
      </p>
      <div className="set-row">
        <div className="set-row-text">
          <div className="set-row-name">导出这个空间为空间包…</div>
          <div className="set-row-sub">把当前空间（页面树 + 附件）打成 .shuyospace，可在另一台机器导入。</div>
        </div>
        <button
          className="set-btn"
          data-testid="space-package-export"
          disabled={busy}
          title="导出当前空间为 .shuyospace"
          onClick={() => void exportSpace()}
        >
          {busy ? "处理中…" : "导出…"}
        </button>
      </div>
      <div className="set-row">
        <div className="set-row-text">
          <div className="set-row-name">导入空间包…</div>
          <div className="set-row-sub">
            从 .shuyospace 文件新建一个空间并切换过去；同名也新建，不会合并到当前空间。
          </div>
        </div>
        <button
          className="set-btn"
          data-testid="space-package-import"
          disabled={busy}
          title="从 .shuyospace 导入到新空间"
          onClick={() => void importSpace()}
        >
          {busy ? "处理中…" : "导入…"}
        </button>
      </div>
      {warnings.length > 0 ? (
        <div className="set-hint" role="status" data-testid="space-package-warnings">
          {warnings.map((w) => (
            <div key={w}>⚠ {w}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
