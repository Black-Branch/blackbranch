import js from "@eslint/js";
import globals from "globals";

// stream-ingest is ESM Node ("type": "module"). Same rule set as stream-api's
// config, and deliberately so: a rule name must mean the same thing in both
// backends, or "zero warnings" means two different things depending on which
// package is being linted.
//
// vendor/ is excluded because it is a third-party copy kept as upstream. Nothing
// else is excluded — scripts/ and tools/ are first-party and run against production.

export default [
  {
    ignores: ["node_modules/**", "config/**", "vendor/**"],
  },
  js.configs.recommended,
  {
    // An unused suppression is an error, not a warning: a stale disable comment hides the next
    // real finding on its line. See stream-api/eslint.config.mjs.
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // See stream-api/eslint.config.mjs for why the underscore convention is
      // configured rather than disabled at each site.
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
  {
    // These two files are Node, but parts of them are NOT: the bodies passed to Playwright's
    // page.evaluate() / addInitScript() are serialised and executed inside the browser, where
    // `document`, `window`, `Node` and `MutationObserver` are the correct globals and `require`
    // is not. eslint sees one file and one scope, so it cannot tell the two halves apart.
    //
    // Scoped to the two files that actually drive a browser rather than added package-wide: in
    // every other file a reference to `document` IS a bug, and that is the reading worth keeping.
    files: ["platforms/youtube.js", "platforms/kick.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
];
