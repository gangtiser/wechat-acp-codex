// Minimal, surgical lint: only the async-correctness rules this codebase
// actually needs — it hand-manages many fire-and-forget promises, which is
// exactly the bug class no-floating-promises / no-misused-promises catch.
// Style remains "match the surrounding code", not lint-enforced.
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["src/**/*.ts", "bin/**/*.ts"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
  },
});
