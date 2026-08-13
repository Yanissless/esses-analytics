import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The dev server's own build dir (NEXT_DIST_DIR, set by `run.cmd dev` so a build can't
    // break a running dev — see next.config.ts). Not covered by the defaults above, and
    // without it `lint` reports thousands of errors from generated chunks.
    ".next-dev/**",
  ]),
]);

export default eslintConfig;
