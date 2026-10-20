import js from "@eslint/js";
import globals from "globals";

// stream-api is CommonJS Node. Everything here runs on the server; there is no
// bundler, no JSX and no TypeScript, so the rule set is deliberately small:
// eslint's own `recommended`, which is the set that catches mistakes rather
// than the set that expresses opinions.
//
// This is a .mjs file on purpose: the deploy copies the top-level `*.js`, so a
// `.js` config would be copied onto the runtime box as application code.

export default [
  {
    ignores: ["node_modules/**", "sounds/**"],
  },
  js.configs.recommended,
  {
    // A suppression that no longer suppresses anything reads as a considered decision while doing
    // nothing. eslint's default for this is "warn", and a warning that does not fail the run is a
    // standing warning, so it is an error here.
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // The default `no-unused-vars` reports a caught error even when the
      // point of the catch is to ignore it, and the leading params of a
      // callback whose last param is the one used. Both shapes are legitimate
      // here, so a leading underscore marks the name as deliberately unused.
      "no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
];
