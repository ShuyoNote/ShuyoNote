// ⭐ P3-3a 第二小步（task-52）：**dev-only 的 CRDT 影子看门**（不弹 UI、不改数据、不阻塞应用）。
//
// 行为：
// · 只在 `import.meta.env.DEV` 下执行（生产构建里这个条件为 false ⇒ 无定时器/无网络/无日志）；
// · 活动空间或页面列表变化后，**防抖一次**（默认 3s）再扫；只 `console.info("[crdt-shadow] …", summary)`；
// · 扫描失败也只 `console.info`（⛔ 不 toast、⛔ 不写库、⛔ 不影响渲染）。
import { useEffect, useRef } from "react";
import { shadowScanSpace, type ShadowScanApi } from "./crdtShadowScan";
import type { ShadowRowsResult } from "./crdtShadow";
import {
  SHADOW_HISTORY_KEY,
  parseShadowHistory,
  recordShadowDay,
  shadowDateKey,
} from "./crdtShadowHistory";
import { useSpaceStore } from "../store/space";

export interface CrdtShadowWatchDeps {
  /** 判据注入点；生产用 `shadowScanSpace` 默认实现。 */
  scan?: (spaceId: string) => Promise<ShadowRowsResult>;
  /** 防抖毫秒（默认 3000）。 */
  debounceMs?: number;
  /**
   * ⭐ 2026-11-11（owner 批 A）：**跨天检查**的轮询间隔（默认 5 分钟）。
   * 只查日期（`shadowDateKey`），不扫描；发现“今天还没记录”才补扫一次。
   */
  dailyCheckMs?: number;
  /** dev 判定（默认 `import.meta.env.DEV`；判据可显式传）。 */
  isDev?: boolean;
  /** 日志出口（默认 `console.info`；判据用假的）。 */
  consoleInfo?: (message: string, data: ShadowRowsResult) => void;
  /**
   * ⭐ task-67：历史存储（默认 `localStorage`；判据注入假实现）。
   * `null` ⇒ 不写（判据用来证明"没存储也能跑"）。
   */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** 当前时间（判据注入固定日期；默认 `new Date()`）。 */
  now?: () => Date;
}

const DEFAULT_DEBOUNCE_MS = 3000;
const DEFAULT_DAILY_CHECK_MS = 5 * 60 * 1000;

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
  const storageRef = useRef(deps.storage);
  storageRef.current =
    deps.storage === undefined
      ? typeof localStorage !== "undefined"
        ? localStorage
        : null
      : deps.storage;
  const nowRef = useRef(deps.now);
  nowRef.current = deps.now;

  const dailyCheckMs = deps.dailyCheckMs ?? DEFAULT_DAILY_CHECK_MS;

  useEffect(() => {
    if (!isDev || !activeSpaceId) return;
    let cancelled = false;
    const nowDate = () => (nowRef.current ?? (() => new Date()))();
    const logLine = (message: string, data: ShadowRowsResult) => {
      const log =
        infoRef.current ??
        ((m: string, d: ShadowRowsResult) => console.info(m, d));
      log(message, data);
    };
    /** ⭐ 一次扫描：只改本文件；调用方决定“为什么扫”（变化 / 跨天）。 */
    const runScan = (reason: "change" | "daily") => {
      const scan = scanRef.current ?? (shadowScanSpace as (id: string) => Promise<ShadowRowsResult>);
      void scan(activeSpaceId)
        .then((summary) => {
          if (cancelled) return;
          // ⚠️ 只打计数/差异页 id（summary 本身已脱敏）。
          logLine(`[crdt-shadow] ${activeSpaceId}${reason === "daily" ? "（每日）" : ""}`, summary);
          // ⭐ task-67：**dev 才写**近 7 天历史（生产 effect 在 `!isDev` 就 return）。
          //   ⚠️ 只存计数；同一天覆盖；坏 JSON ⇒ parse 给空表 ⇒ 重写为合法数组（重置）。
          //   ⚠️ 存储异常（隐私模式/配额）⇒ 只吞掉，⛔ 不影响扫描/应用。
          const storage = storageRef.current;
          if (storage) {
            try {
              const parsed = parseShadowHistory(storage.getItem(SHADOW_HISTORY_KEY));
              const next = recordShadowDay(parsed.records, summary, nowDate());
              storage.setItem(SHADOW_HISTORY_KEY, JSON.stringify(next));
            } catch {
              // 存储坏了/写不进 ⇒ 观测仍可用（下次再试）。
            }
          }
        })
        .catch((e) => {
          if (cancelled) return;
          logLine("[crdt-shadow] 扫描失败（不影响应用）", {
            total: 0,
            withState: 0,
            equal: 0,
            differ: 0,
            uncomparable: 0,
            differPageIds: [],
          });
          console.info("[crdt-shadow] 出错原因", e);
        });
    };
    /**
     * ⭐ 2026-11-11（owner 批 A）：**跨天补扫** —— 空闲日也要有一天一条记录。
     * 口径：只有“已有历史，但今天还没有记录”才补扫；**首次观测**（历史为空）仍由变化扫描负责，
     * 避免刚装上就凭空扫一次（那会把“还没开始观测”写成一条假记录）。
     */
    const checkDaily = () => {
      const storage = storageRef.current;
      if (!storage) return;
      let records: Array<{ date: string }> = [];
      try {
        records = parseShadowHistory(storage.getItem(SHADOW_HISTORY_KEY)).records;
      } catch {
        return; // 读不出来 ⇒ 这轮不补（下次再试），⛔ 不猜
      }
      if (records.length === 0) return;
      const today = shadowDateKey(nowDate());
      if (records.some((r) => r.date === today)) return;
      runScan("daily");
    };
    const changeTimer = setTimeout(() => runScan("change"), debounceMs);
    checkDaily(); // 启动时就查一次：昨天开过、今天还没记录 ⇒ 立刻补一条
    const dailyTimer = setInterval(checkDaily, dailyCheckMs);
    return () => {
      cancelled = true;
      clearTimeout(changeTimer);
      clearInterval(dailyTimer);
    };
  }, [activeSpaceId, pagesVersion, isDev, debounceMs, dailyCheckMs]);
}

/** 给判据/默认实现用：按注入 api 建一个扫描函数（生产默认直接用 `shadowScanSpace`）。 */
export function scanWith(api: ShadowScanApi): (spaceId: string) => Promise<ShadowRowsResult> {
  return (spaceId) => shadowScanSpace(spaceId, api);
}
