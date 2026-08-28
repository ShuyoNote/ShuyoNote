// Minimal polyfills for newer built-ins used by dependencies (pdf.js 6 uses
// Map.prototype.getOrInsertComputed / getOrInsert, which older Chromium/WebView2
// engines lack). Import this module FIRST at app bootstrap so the methods exist
// before any dependency (pdf.js) observes them.
type MapLike<K, V> = Map<K, V> & Record<string, unknown>;

const proto = Map.prototype as unknown as MapLike<unknown, unknown>;

if (typeof proto.getOrInsertComputed !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (proto as any).getOrInsertComputed = function getOrInsertComputed<K, V>(this: Map<K, V>, key: K, cb: (k: K) => V): V {
    if (this.has(key)) return this.get(key) as V;
    const value = cb(key);
    this.set(key, value);
    return value;
  };
}

if (typeof proto.getOrInsert !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (proto as any).getOrInsert = function getOrInsert<K, V>(this: Map<K, V>, key: K, value: V): V {
    if (this.has(key)) return this.get(key) as V;
    this.set(key, value);
    return value;
  };
}

export {};
