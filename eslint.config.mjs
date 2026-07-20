import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });
const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Route payloads and imported backup/PDF records are intentionally dynamic.
      "@typescript-eslint/no-explicit-any": "off",
      // The backup endpoint is a file download, not client-side navigation.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
];

export default config;
