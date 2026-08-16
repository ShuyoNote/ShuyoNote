// Deterministic category-color assignment for tags / board columns.
// Maps a tag name (stable hash) to one of the 8 category color pairs from the
// design system, so the same tag always gets the same color across views.

const PALETTE: ReadonlyArray<readonly [string, string]> = [
  ["--cat-blue", "--cat-blue-soft"],
  ["--cat-green", "--cat-green-soft"],
  ["--cat-orange", "--cat-orange-soft"],
  ["--cat-red", "--cat-red-soft"],
  ["--cat-purple", "--cat-purple-soft"],
  ["--cat-cyan", "--cat-cyan-soft"],
  ["--cat-yellow", "--cat-yellow-soft"],
  ["--cat-gray", "--cat-gray-soft"],
];

export interface TagColor {
  solid: string; // e.g. "var(--cat-blue)"
  soft: string; // e.g. "var(--cat-blue-soft)"
}

export function tagColor(name: string): TagColor {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  const [solid, soft] = PALETTE[h % PALETTE.length];
  return { solid: `var(${solid})`, soft: `var(${soft})` };
}
