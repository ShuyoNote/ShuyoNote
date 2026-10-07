// 第 5 招的判据（裁定 A ✓）：**默认全显** ＋ 一个「隐藏高级项」的个人偏好 —— 纯规则 ✓。
//   ⚠️ 只用单引号字符串、中文引用用「」。
import { describe, expect, it } from 'vitest';
import { HIDE_ADVANCED_KEY, readHideAdvanced, visibleGroups, writeHideAdvanced } from './settingsNavPref';

const ALL = ['basic', 'collab', 'ai', 'system'] as const;
const ADVANCED = ['collab', 'ai', 'system'] as const;

/** 最小 storage 替身（只实现用到的那几个 ✓）。 */
function fakeStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

describe('「隐藏高级项」偏好（裁定 A：默认全显 ✓）', () => {
  it('★ 没设过 ⇒ **一个组都不藏**（⛔ 不许默认藏 ✗ —— 默认藏就是默认找不到 ✓）', () => {
    expect(visibleGroups(ALL, false, ADVANCED)).toEqual([...ALL]);
  });

  it('★ 打开「隐藏高级项」⇒ **只留基础组** ✓（其余整体不渲染 ✓）', () => {
    expect(visibleGroups(ALL, true, ADVANCED)).toEqual(['basic']);
  });

  it('★ 读不到 / 没设过 / 读抛错 ⇒ 一律当"不藏" ✓（读失败绝不等于藏起来 ✗）', () => {
    expect(readHideAdvanced(fakeStorage())).toBe(false);
    expect(readHideAdvanced(fakeStorage({ [HIDE_ADVANCED_KEY]: '0' }))).toBe(false);
    expect(
      readHideAdvanced({
        getItem: () => {
          throw new Error('存储坏了');
        },
      }),
    ).toBe(false);
  });

  it('★ 写进去能读回来；关掉时**把键删掉**（不是写 0，少一种状态 ✓）', () => {
    const s = fakeStorage();
    writeHideAdvanced(true, s);
    expect(readHideAdvanced(s)).toBe(true);
    expect(s.dump()[HIDE_ADVANCED_KEY]).toBe('1');
    writeHideAdvanced(false, s);
    expect(readHideAdvanced(s)).toBe(false);
    expect(Object.keys(s.dump())).toEqual([]);
  });

  it('★ 写失败不炸（存不下只是下次不记得 ✓，⛔ 不影响本次界面 ✓）', () => {
    expect(() =>
      writeHideAdvanced(true, {
        setItem: () => {
          throw new Error('配额满了');
        },
      }),
    ).not.toThrow();
  });
});
