/**
 * App 自身崩掉时的整屏兜底（挂在 `main.tsx` 的最外层）。
 *
 * 为什么必须有：1.85.1 之前，根部没有边界，任何一处渲染期抛错都会让 React 卸载整棵树——
 * 用户看到的是**纯白屏**，既没有错误文本、也没有恢复入口，只能猜是不是自己点坏了什么。
 * 这个屏幕做三件事：说清出了什么错、给一个「重新加载」、把错误码留在控制台。
 *
 * 刻意用内联样式：它要在**样式表本身可能没加载好/被改坏**的情况下也能显示（与
 * `main.tsx` 里启动失败面板同样的理由）。
 */
export function AppCrashScreen({ error }: { error: Error | null }) {
  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#151a2c",
        color: "#fff",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 560 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#ffb3b3", marginBottom: 10 }}>
          界面出错了
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.7, color: "rgba(255,255,255,.85)", wordBreak: "break-all" }}>
          {String(error?.message || error || "未知错误")}
        </div>
        <div style={{ marginTop: 16, fontSize: 12, color: "rgba(255,255,255,.6)", lineHeight: 1.7 }}>
          你的笔记没有受影响（内容仍在本地）。重新加载即可回到正常界面；
          如果每次都这样，请把这个错误文本截图反馈。
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 16,
            padding: "8px 16px",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,.28)",
            background: "transparent",
            color: "#fff",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          重新加载
        </button>
      </div>
    </div>
  );
}
