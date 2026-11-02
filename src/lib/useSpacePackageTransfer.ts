// 空间包（.shuyospace）导出/导入的**逻辑**（不含按钮长相）：
// ⭐ 2026-10-31（owner 选 A）：这两个入口从「文件管理」工具栏搬走——
//    · 导出的对象是**当前空间**、导入的产物是**一个新空间** ⇒ 都属于「设置 → 空间」的空间级操作；
//    · 文件管理页只留「面包屑 / 计数 / 搜索 / 视图」，不再被两个低频大按钮占首屏。
// 判据在 `SpacePackageTransfer.test.tsx`（成功/失败/取消、warnings、切换新空间）。
import { useCallback, useState } from "react";
import { toast } from "../store/toast";
import { useSpaceStore } from "../store/space";
import {
  exportWorkspaceAsSpacePackage,
  importSpacePackageFromDialog,
  type TransferOutcome,
} from "./docSpacePackTransfer";

export interface SpacePackageTransfer {
  busy: boolean;
  warnings: string[];
  exportSpace: () => Promise<void>;
  importSpace: () => Promise<void>;
  clearWarnings: () => void;
}

export function useSpacePackageTransfer(): SpacePackageTransfer {
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const run = useCallback(async (fn: () => Promise<TransferOutcome>) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fn();
      if (r.cancelled) {
        setWarnings([]);
        return;
      }
      setWarnings(r.warnings ?? []);
      toast(r.message, r.ok ? "success" : "error");
      // 导入会**新开一个空间** ⇒ 重新拉空间列表并切过去（否则用户看不到导入结果）。
      if (r.ok && r.spaceId) {
        await useSpaceStore.getState().load();
        await useSpaceStore.getState().switchTo(r.spaceId);
      }
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const exportSpace = useCallback(() => run(exportWorkspaceAsSpacePackage), [run]);
  const importSpace = useCallback(() => run(importSpacePackageFromDialog), [run]);
  const clearWarnings = useCallback(() => setWarnings([]), []);

  return { busy, warnings, exportSpace, importSpace, clearWarnings };
}
