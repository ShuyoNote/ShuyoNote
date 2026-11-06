// **外部 .md「双击打开」在冷启动时的开预览时机**（2026-11-07 修）。
//
// 现象（owner 2026-11-07 报「双击打开 md 文档失效了」）：
//   · 应用**已经开着**时双击 .md ⇒ 预览正常打开 ✓
//   · 应用**没开**时双击 .md ⇒ 应用起来了，但预览没开（看起来"没反应"，只有主界面）✗
//
// 真因是**启动竞态**，不是文件关联坏了：
//   1. 冷启动：`main.rs` 把 `--import <md>` 入队 → `lib.rs .setup()` emit 叫醒（前端还没挂载，这次
//      叫醒没人听）→ 前端挂载时 `office_import_take` **drain 取走队列**，走 `onMarkdownRequest`
//      ⇒ `useFilePreview.openPath(path)` 开预览 ✓；
//   2. 但同一时刻 `notes.loadPages()` 正在恢复"上次打开的页面"，它 `await openPage(...)`，
//      而 **`openPage` 的第一行就是 `useFilePreview.getState().close()`**（`src/store/notes.ts`）
//      ⇒ 刚开的预览被这次恢复**关掉** ✗。
//   ⇒ 应用已开着时没有这段恢复（`startupSettled === true`）⇒ 所以只有冷启动坏。
//
// 修法：md 预览**等"启动那次打开哪一页"落定**（`useNotes.startupSettled`）之后再开；
// 落定信号没来（加载失败等）就给一个 2.5s 兜底，别让"打开文件"彻底没反应。
//
// ⚠️ 与 `filePreview` / `notes` 两个 store 的耦合**只放在这里**（`OfficeImportPanel` 只调本函数），
//    这样判据可以在**不起真 store** 的情况下验"冷启动会等、已就绪会立刻开、兜底会开"。
import { useFilePreview } from "../../store/filePreview";
import { useNotes } from "../../store/notes";

export interface MdPreviewDeps {
  /** 真的去开预览（生产 = `useFilePreview.getState().openPath`）。 */
  openPath: (path: string) => void;
  /** 启动那次"打开哪一页"是否已落定。 */
  isStartupSettled: () => boolean;
  /** 订阅 startupSettled 变化；返回反订阅函数。 */
  subscribeStartupSettled: (onChange: () => void) => () => void;
  /** 兜底定时器（注入是为判据；生产 = setTimeout）。 */
  scheduleFallback?: (cb: () => void, ms: number) => void;
}

export const STARTUP_FALLBACK_MS = 2500;

/** 生产依赖（⛔ 不在这里直接读 store 字段，判据要用假依赖）。 */
function realDeps(): MdPreviewDeps {
  return {
    openPath: (path) => useFilePreview.getState().openPath(path),
    isStartupSettled: () => useNotes.getState().startupSettled,
    subscribeStartupSettled: (onChange) => {
      let fired = false;
      const unsub = useNotes.subscribe((s) => {
        if (!fired && s.startupSettled) {
          fired = true;
          onChange();
        }
      });
      return () => {
        fired = true;
        unsub();
      };
    },
    scheduleFallback: (cb, ms) => {
      setTimeout(cb, ms);
    },
  };
}

/**
 * 打开外部 md 的只读预览；**冷启动时等启动页恢复落定再开**（否则会被 `openPage` 的
 * `filePreview.close()` 关掉）。应用已就绪时**同步立刻开**（不额外等一帧）。
 *
 * 返回 `true` 表示"已开或已排队等开"（调用方据此把这条路径标记为已处理）。
 */
export function openMarkdownPreviewAfterStartup(path: string, deps: MdPreviewDeps = realDeps()): boolean {
  const open = (): void => {
    try {
      deps.openPath(path);
    } catch (e) {
      // 开预览失败不该打断"导入/打开文件"整条链；如实记日志（与 requestBridge 的失败姿态一致）。
      console.error("[ShuyoNote] 外部 md 预览打开失败:", e);
    }
  };

  if (deps.isStartupSettled()) {
    open();
    return true;
  }

  let done = false;
  const fire = (): void => {
    if (done) return;
    done = true;
    open();
  };

  let unsubscribe: (() => void) | null = null;
  unsubscribe = deps.subscribeStartupSettled(() => {
    unsubscribe?.();
    fire();
  });
  // 兜底：启动落定信号没来（加载失败 / 极慢）⇒ 到点照开，别让双击彻底没反应。
  const fallback = deps.scheduleFallback;
  if (fallback) {
    fallback(() => {
      unsubscribe?.();
      fire();
    }, STARTUP_FALLBACK_MS);
  }
  return true;
}
