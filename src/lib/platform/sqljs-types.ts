// Minimal typings for the sql.js WASM SQLite API surface we use. sql.js ships
// no .d.ts, so we declare the small subset here.
export type SqlValue = number | string | Uint8Array | null;

export interface Statement {
  bind(values: SqlValue[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, SqlValue>;
  free(): void;
}

export interface Database {
  run(sql: string, params?: SqlValue[]): void;
  prepare(sql: string): Statement;
  exec(sql: string): { columns: string[]; values: SqlValue[][] }[];
  export(): Uint8Array;
  close(): void;
}

// sql.js's init function returns a module whose `Database` is a constructor that
// optionally accepts exported bytes to open an existing database.
export interface SqlJsModule {
  Database: new (data?: Uint8Array) => Database;
}
