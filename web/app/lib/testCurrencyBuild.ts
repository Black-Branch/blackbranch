// TEST SUPPORT — import FIRST in a test that needs an install's OWN currency words, the way a
// running server publishes them (instrumentation.ts → INSTALL_VALUES). A mass noun on purpose
// (singular = plural, one-letter symbol): the shape that must render exactly as an install's own
// words. Neutral example words — never an owner's.
process.env.INSTALL_VALUES ??= JSON.stringify({
  "site.name": "Example Stream",
  "currency.name": "Credit",
  "currency.namePlural": "Credit",
  "currency.symbol": "c",
  "currency.icon": "/example-icon.webp",
  "community.scoreName": "Street cred",
});
