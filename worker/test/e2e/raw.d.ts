// Vite `?raw` imports (file contents as a string) — used by rbac-matrix.test.ts
// to read the explicit sweep table out of test/rbac.test.ts.
declare module '*?raw' {
  const content: string;
  export default content;
}
