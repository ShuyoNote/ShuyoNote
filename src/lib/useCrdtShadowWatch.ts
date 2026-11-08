// ⭐ P3-3a 第二小步（task-52）：**dev-only 的 CRDT 影子看门**（不弹 UI、不改数据、不阻塞应用）。
//
// 行为：
// · 只在 `import.meta.env.DEV` 下执行（生产构建里这个条件为 false ⇒ 无定时器/无网络/无日志）；
// · 活动空间或页面列表变化后，**防抖一次**（默认 3s）再扫；只 `console.info("[crdt-shadow] …", summary)`；
// · 扫描失败也只 `console.info`（⛔ 不 toast、⛔ 不写库、⛔ 不影响渲染）。
import { useEffect, useRef } from "react";
import { shadowScanSpace, type ShadowScanApi } from "./crdtShadowScan";
import type { ShadowRowsResult } from "./crdtShadow";
import { useSpaceStore } from "../store/space";

export interface CrdtShadowWatchDeps {
  /** 判据注入点；生产用 `shadowScanSpace` 默认实现。 */
  scan?: (spaceId: string) => Promise<ShadowRowsResult>;
  /** 防抖毫秒（默认 3000）。 */
  debounceMs?: number;
  /** dev 判定（默认 `import.meta.env.DEV`；判据可显式传）。 */
  isDev?: boolean;
  /** 日志出口（默认 `console.info`；判据用假的）。 */
  consoleInfo?: (message: string, data: ShadowRowsResult) => void;
}

const DEFAULT_DEBOUNCE_MS = 3000;

/**
 * 挂载一次即可：读**当前活动空间**，在空间/页列表变化后防抖扫描一次。
 *
 * @param pagesVersion 页面列表的变化版本（App 用 `pages.length` 即可；⛔ 不需要内容版本）。
 */
export function useCrdtShadowWatch(
  pagesVersion: number,
  deps: CrdtShadowWatchDeps = {},
): void {
  const activeSpaceId = useSpaceStore((s) => s.activeId);
  const isDev = deps.isDev ?? import.meta.env.DEV;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  // 回调放 ref：deps 对象/函数每次渲染都是新引用，直接进依赖数组会让定时器永远重排。
  const scanRef = useRef(deps.scan);
  scanRef.current = deps.scan;
  const infoRef = useRef(deps.consoleInfo);
  infoRef.current = deps.consoleInfo;

  useEffect(() => {
    if (!isDev || !activeSpaceId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const scan = scanRef.current ?? (shadowScanSpace as (id: string) => Promise<ShadowRowsResult>);
      void scan(activeSpaceId)
        .then((summary) => {
          if (cancelled) return;
          const log =
            infoRef.current ??
            ((message: string, data: ShadowRowsResult) => console.info(message, data));
          // ⚠️ 只打计数/差异页 id（summary 本身已脱敏）。
          log(`[crdt-shadow] ${activeSpaceId}`, summary);
        })
        .catch((e) => {
          if (cancelled) return;
          const log =
            infoRef.current ??
            ((message: string, data: ShadowRowsResult) => console.info(message, data));
          log("[crdt-shadow] 扫描失败（不影响应用）", {
            total: 0,
            withState: 0,
            equal: 0,
            differ: 0,
            uncomparable: 0,
            differPageIds: [],
          });
          console.info("[crdt-shadow] 出错原因", e);
        });
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeSpaceId, pagesVersion, isDev, debounceMs]);
}

/** 给判据/默认实现用：按注入 api 建一个扫描函数（生产默认直接用 `shadowScanSpace`）。 */
export function scanWith(api: ShadowScanApi): (spaceId: string) => Promise<ShadowRowsResult> {
  return (spaceId) => shadowScanSpace(spaceId, api);
}
