'use strict';
// The outgoing-mail settings, read for the HOST when it renders the sign-in service's config
// (host-settings.cjs: as stream-api resolves them, the password decrypted with its own key).
// Prints KEY=value lines on stdout for the host.

const { resolveKeys, runReader } = require('./host-settings.cjs');

/** schema key → the render's name for it. install/mail.test.mjs checks it covers every mail.* key. */
const OUT = {
  'mail.smtp.host': 'MX_SMTP_HOST',
  'mail.smtp.port': 'MX_SMTP_PORT',
  'mail.smtp.mode': 'MX_SMTP_MODE',
  'mail.smtp.username': 'MX_SMTP_USERNAME',
  'mail.smtp.password': 'MX_SMTP_PASSWORD',
  'mail.from': 'MX_MAIL_FROM_SET',
};

runReader(async () => {
  const v = await resolveKeys(Object.keys(OUT), 'mail');
  return Object.entries(OUT).map(([k, name]) => `${name}=${v[k]}`);
});
