/// <reference types="vite/client" />

// sql.js ships no type declarations; we type the small surface we use inline
// (see sqljs-types.ts) and declare the module here so `import("sql.js")` resolves.
declare module "sql.js";
