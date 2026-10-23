// 本机存卡的存储层（只存**卡文本**；私钥在 Rust 侧，⛔ 不进 localStorage）。
//
// 抽出来是为了让「许可证面板」与「中继面板的自动续租」用同一个键、同一套读写，
// ⛔ 不再各写一份 localStorage 访问（两份实现迟早漂移）。
export const CARDS_KEY = "shuyonote.license.cards";

export interface StoredCard {
  text: string;
}

export function readCards(): StoredCard[] {
  try {
    const raw = localStorage.getItem(CARDS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is StoredCard => typeof (x as StoredCard)?.text === "string");
  } catch {
    return [];
  }
}

export function writeCards(cards: StoredCard[]): void {
  try {
    localStorage.setItem(CARDS_KEY, JSON.stringify(cards.slice(-8)));
  } catch {
    // 存不进去不该炸界面；下次进来自会显示"没有卡"
  }
}
