import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,

  // -------------------------------------------------------------------------
  // src/ — full strict type-aware checking
  // -------------------------------------------------------------------------
  {
    files: ["src/**/*.ts"],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Prefer explicit return types on exported functions
      "@typescript-eslint/explicit-module-boundary-types": "warn",
      // Allow void returns in callbacks
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // tests/ — type-aware but relaxed (no project reference needed for safety)
  // -------------------------------------------------------------------------
  {
    files: ["tests/**/*.ts"],
    extends: [...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },

  // -------------------------------------------------------------------------
  // Ignored paths
  // -------------------------------------------------------------------------
  {
    ignores: [
      "dist/**",
      "docs/**",
      "coverage/**",
      "examples/**",
      "*.config.ts",
      "*.config.mjs",
    ],
  },
);
