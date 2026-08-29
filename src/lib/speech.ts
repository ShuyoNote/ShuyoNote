// 系统朗读（Web Speech API）：零配置、离线、免费。中文用 zh-CN。简单播放/停止。

export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/** 朗读一段中文文本。返回 true=已开始；false=不可用或无中文语音。 */
export function speak(text: string, lang = "zh-CN"): boolean {
  if (!isSpeechSupported() || !text.trim()) return false;
  stopSpeech();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 1;
  u.pitch = 1;
  u.volume = 1;
  window.speechSynthesis.speak(u);
  return true;
}

/** 停止朗读。 */
export function stopSpeech(): void {
  if (isSpeechSupported()) window.speechSynthesis.cancel();
}

/** 是否正在朗读（用于按钮切换 朗读/停止）。 */
export function isSpeaking(): boolean {
  return isSpeechSupported() && window.speechSynthesis.speaking;
}
