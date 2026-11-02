// 手写声明：`scripts/gen-css-tokens.mjs` 是 JS 生成器，`src/lib/cssTokens.test.ts` 会 import 它
// 做「生成物逐字节一致」判据。TS 在 `allowJs: false` 下需要这份声明（否则 TS7016）。
export interface CssTokens {
  fontSize?: Record<string, string>;
}

export function loadTokens(): CssTokens;
export function renderCss(tokens?: CssTokens): string;
export function renderDts(tokens?: CssTokens): string;
