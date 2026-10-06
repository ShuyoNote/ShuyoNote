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
import { createSpeechInput, speechInputSupported, speechErrorMessage, type SpeechRecognitionLike } from "../lib/speechInput";

export interface SpeechInputHandle {
  /** 这台机器/这个外壳支不支持 ✓（不支持时按钮仍在，但点了会**如实**说一句 ✓）。 */
  supported: boolean;
  /** 正在听 ✓（按钮用它高亮 ✓）。 */
  listening: boolean;
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
  const handleRef = useRef<ReturnType<typeof createSpeechInput> | null>(null);

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
      toast("已停止语音输入", "info");
      return;
    }
    handleRef.current = createSpeechInput({
      events: {
        onText: (text, isFinal) => {
          // ① 只把**定稿**写进笔记 ✓（中间结果会变 ⇒ 不插 ✗）
          if (!isFinal) return;
          if (!insertTextAtCaret(text)) toast(`收到一段语音，但编辑器没接住：「${text.trim()}」`, "error");
        },
        onError: (_code, message) => {
          toast(message, "error");
          setListening(false);
        },
        onEnd: () => {
          setListening(false);
        },
      },
    });
    handleRef.current.start();
    setListening(true);
    toast("开始听写 —— 说话就会插到光标处（再点一下话筒停止）", "success");
  }, [supported]);

  return { supported, listening, toggle };
}

/** 供判据用：假的识别器构造函数（真机没有这个 API ⇒ 判据必须在假件上跑 ✓）。 */
export type { SpeechRecognitionLike };
