import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "coverage/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "no-control-regex": "off",
      "no-unexpected-multiline": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // These fixtures execute in Node; only the two named Playwright callbacks
    // below also reference another JavaScript realm. Keep no-undef enabled.
    files: [
      "src/tools/computer-history/win/native/tests/integration/browser-smoke.mjs",
      "src/tools/computer-history/win/native/tests/integration/electron-text-smoke.mjs",
      "tests/fixtures/external-browser-actions-live.mjs",
      "tests/fixtures/teaching-browser-basics-live.mjs",
      "tests/fixtures/teaching-browser-integrity-live.mjs",
    ],
    languageOptions: {
      globals: {
        process: "readonly", console: "readonly", URL: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly",
      },
    },
  },
  {
    files: ["tests/fixtures/external-browser-actions-live.mjs"],
    languageOptions: { globals: { window: "readonly" } },
  },
  {
    files: ["tests/fixtures/teaching-browser-integrity-live.mjs"],
    languageOptions: { globals: { chrome: "readonly" } },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        URL: "readonly",
      },
    },
  },
  {
    // The office skill scripts are executable Node assets copied into the
    // packaged agent. They are intentionally JavaScript utilities rather than
    // TypeScript application modules; keep syntax checking while supplying the
    // Node globals and avoiding style-only failures in imported third-party
    // helpers.
    files: ["src/skills/**/scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        Blob: "readonly",
        FormData: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        AbortController: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        structuredClone: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-useless-escape": "off",
      "no-control-regex": "off",
      "prefer-const": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
      },
    },
  },
);
