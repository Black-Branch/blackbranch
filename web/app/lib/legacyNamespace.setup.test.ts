// Test setup, imported FIRST by the suites that pin read-both behaviour: makes this process a build
// whose homeserver holds data under a legacy prefix (the install key matrix.legacyNamespace —
// matrixNamespace.ts). ESM evaluates imports in order, so this runs before installValues.ts parses
// INSTALL_VALUES. Any other install value already set is kept. No tests of its own.
process.env.INSTALL_VALUES = JSON.stringify({
  ...(JSON.parse(process.env.INSTALL_VALUES || "{}") as Record<string, string>),
  "matrix.legacyNamespace": "net.prior",
});

export {};
