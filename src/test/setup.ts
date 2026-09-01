// Vitest setup: provide the minimal browser globals that some imported modules
// touch at module load time (e.g. store/view.ts reads localStorage during store
// creation). Kept tiny — only shims that are needed by unit-tested pure functions
// and their transitive imports, not a full DOM.
if (typeof globalThis.localStorage === "undefined") {
  const backing = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => Array.from(backing.keys())[i] ?? null,
    get length() {
      return backing.size;
    },
  } as Storage;
}
