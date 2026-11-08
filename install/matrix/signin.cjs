'use strict';
// The sign-in provider settings (signin.*), read for the HOST when it renders the sign-in service's
// config (host-settings.cjs: as stream-api resolves them, the client secrets decrypted with its own
// key). Prints KEY=value lines on stdout for the host: per slot its switch, its provider id
// (signinProviderId: the schema's fixed `upstreamId`, or for the OpenID slot one derived from its
// issuer — empty while it has no usable one), that id as the uuid the sign-in service stores it under
// (the doctor asks the service's own table for it), and its credentials.

const { INSTANCE_KEYS, resolveKeys, runReader, signinProviderId } = require('./host-settings.cjs');

const SLOTS = ['google', 'discord', 'twitch', 'oidc'];
/** schema field → the render's name for it (after MX_SIGNIN_<SLOT>_). install/signin.test.mjs holds the set. */
const FIELDS = { enabled: 'ON', clientId: 'CLIENT_ID', clientSecret: 'CLIENT_SECRET', issuer: 'ISSUER', humanName: 'NAME' };
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID as a uuid: its 128 bits in hex. */
function uuidOf(ulid) {
  let n = 0n;
  for (const c of ulid) n = n * 32n + BigInt(CROCKFORD.indexOf(c));
  const h = n.toString(16).padStart(32, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

runReader(async () => {
  const keys = INSTANCE_KEYS.map((e) => e.key).filter((k) => /^signin\.[a-z]+\.[A-Za-z]+$/.test(k) && SLOTS.includes(k.split('.')[1]));
  const v = await resolveKeys(keys, 'sign-in');
  const out = [];
  for (const slot of SLOTS) {
    const P = `MX_SIGNIN_${slot.toUpperCase()}`;
    if (!INSTANCE_KEYS.some((e) => e.key === `signin.${slot}.enabled`)) throw new Error(`this release's schema lacks the ${slot} sign-in slot`);
    const id = signinProviderId(slot, v[`signin.${slot}.issuer`]);
    if (slot !== 'oidc' && !id) throw new Error(`this release's schema has no provider id for the ${slot} sign-in slot`);
    out.push(`${P}_ID=${id ?? ''}`, `${P}_UUID=${id ? uuidOf(id) : ''}`);
    for (const k of keys.filter((x) => x.split('.')[1] === slot)) {
      const name = FIELDS[k.split('.')[2]];
      if (!name) throw new Error(`${k}: not a sign-in field this host knows`);
      out.push(`${P}_${name}=${name === 'ON' ? String(v[k] === 'true') : v[k]}`);
    }
  }
  return out;
});
