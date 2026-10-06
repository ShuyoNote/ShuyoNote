// 语音输入那条**接线**（Rust 无涉、平台无涉 ✓）：话筒按钮 ⇄ Lexical 编辑器。
//
// 三条口径（都由 owner 2026-10-06 那句「点话筒按钮后说话自动转成文字插到笔记当前位置」定 ✓）：
//   ① **只插"定稿"的那半截** ✓（`isFinal` ⇒ 才写进笔记 ✓）—— 中间反复变化的结果如果直接插，
//      用户会看到正文里出现一段"改了又改"的鬼影 ✗；
//   ② 插在**当前光标处** ✓（没有光标 ⇒ 退到文末 ✓，并触发一次聚焦 ✓ —— 不然用户会以为没生效 ✗）；
//   ③ 出任何事都**出声** ✓（不支持 / 权限被拒 / 没听到 / 服务连不上 ⇒ 各说各的一句话 ✓）。
import { useCallback, useEffect, useRef, useState } from "react";
import { $getRoot, $isRangeSelection, $getSelection } from "lexical";
import { toast } from "../store/toast";
import { useEditorStore } from "../store/editor";
import { createSpeechInput, speechInputSupported, speechErrorMessage, caretAnchor, type SpeechRecognitionLike } from "../lib/speechInput";

export interface SpeechInputHandle {
  /** 这台机器/这个外壳支不支持 ✓（不支持时按钮仍在，但点了会**如实**说一句 ✓）。 */
  supported: boolean;
  /** 正在听 ✓（按钮用它高亮 ✓）。 */
  listening: boolean;
  /** ⭐ 半截话（还没定稿那句 ✓）—— 界面上**只显示、不插正文** ✓（见文件头 ① 与 owner 那句「实时显示文字」✓）。 */
  interim: string;
  /** 半截话该浮在哪（跟着光标 ✓；拿不到光标就是 `null` ⇒ 调用方退到话筒按钮那儿 ✓）。 */
  interimAnchor: { left: number; top: number } | null;
  /** 点一下开始 / 再点一下停 ✓。 */
  toggle: () => void;
}

/** 把一段文字插到**当前光标处**（没有光标 ⇒ 文末 ✓）。 */
export function insertTextAtCaret(text: string): boolean {
  const editor = useEditorStore.getState().editor;
  if (!editor) return false;
  const body = text.trim();
  if (!body) return false;
  editor.focus();
  editor.update(() => {
    const sel = $getSelection();
    if ($isRangeSelection(sel)) {
      sel.insertText(body);
      return;
    }
    // 没有选区（编辑器还没被点过 ✓）⇒ 退到文末：⛔ 不许静默什么都不做 ✗
    const root = $getRoot();
    root.selectEnd();
    const end = $getSelection();
    if ($isRangeSelection(end)) end.insertText(body);
  });
  return true;
}

export function useSpeechInput(): SpeechInputHandle {
  const supported = useRef(speechInputSupported()).current;
  const [listening, setListening] = useState(false);
  // ⭐ 2026-10-06（owner 附图：「语音录入时，实时显示文字」✓）：半截话只**显示**、不插正文 ✓。
  const [interim, setInterim] = useState("");
  const [interimAnchor, setInterimAnchor] = useState<{ left: number; top: number } | null>(null);
  const handleRef = useRef<ReturnType<typeof createSpeechInput> | null>(null);

  const clearInterim = useCallback(() => {
    setInterim("");
    setInterimAnchor(null);
  }, []);

  // 组件走的时候把麦关掉 ✓（不然会一直听 ✗）
  useEffect(
    () => () => {
      handleRef.current?.stop();
    },
    [],
  );

  const toggle = useCallback(() => {
    if (!supported) {
      // 如实说话：这套 API 在有些 WebView 里整条不存在 ✓（⛔ 不是静默没反应 ✗）
      toast(speechErrorMessage("service-not-allowed"), "error");
      return;
    }
    if (handleRef.current?.listening()) {
      handleRef.current.stop();
      setListening(false);
      clearInterim();
      toast("已停止语音输入", "info");
      return;
    }
    handleRef.current = createSpeechInput({
      events: {
        onText: (text, isFinal) => {
          // ① **半截话**（isFinal=false）：只浮在光标旁边让你看见 ✓，⛔ 不插正文 ✗
          //    —— 它随时会改，插进去会留下"改了又改"的鬼影 ✗（文件头 ① 那条口径 ✓）。
          if (!isFinal) {
            setInterim(text.trim());
            setInterimAnchor(caretAnchor());
            return;
          }
          // ② 定稿 ⇒ 清掉气泡、把这段插到光标处 ✓
          clearInterim();
          if (!insertTextAtCaret(text)) toast(`收到一段语音，但编辑器没接住：「${text.trim()}」`, "error");
        },
        onError: (_code, message) => {
          toast(message, "error");
          setListening(false);
          clearInterim();
        },
        onEnd: () => {
          setListening(false);
          clearInterim();
        },
      },
    });
    handleRef.current.start();
    setListening(true);
    toast("开始听写 —— 说话时半截话会浮在光标旁，定稿后插进正文（再点一下话筒停止）", "success");
  }, [supported, clearInterim]);

  return { supported, listening, interim, interimAnchor, toggle };
}

/** 供判据用：假的识别器构造函数（真机没有这个 API ⇒ 判据必须在假件上跑 ✓）。 */
export type { SpeechRecognitionLike };
