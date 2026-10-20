// TEST SUPPORT — import FIRST (before any module that reads installValues.ts) in a test that
// needs the install values a running server holds. A server gets them from its environment at
// boot (instrumentation.ts → installValuesServer.ts); `node --test` boots no server, so without
// this every install value reads "".
//
// Neutral example values on purpose: a test that needs THIS install's real origin is testing a
// hardcoded literal, which is what the settings layer removed. A value already set (a test
// setting its own INSTALL_VALUES) is left alone.
process.env.INSTALL_VALUES ??= JSON.stringify({
  "site.name": "Example Stream",
  "site.origin": "https://example.tv",
  "site.apiOrigin": "https://api.example.tv",
  "site.apiWsOrigin": "wss://api.example.tv",
  "matrix.serverName": "example.tv",
  "matrix.baseUrl": "https://matrix.example.tv",
  "matrix.oauth.issuer": "https://matrix.example.tv/auth/",
  "matrix.oauth.clientId": "01EXAMPLECLIENT",
  "discordBridge.usernameTemplate": "discord_{{.}}",
  "discordBridge.displaynameTemplate": "{{or .GlobalName .Username}}{{if .Bot}} (bot){{end}} (Discord)",
});
