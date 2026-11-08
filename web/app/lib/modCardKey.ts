// The key a moderator's chat asks /api/mod/identity/resolve for when a tip card wears no account
// (ADR 0145): `card:<row id>`. Shared by the client (modIdentity.ts) and the server
// (modCardSender.ts), so it imports nothing.
const PREFIX = "card:";

export function cardSenderKey(rowId: number): string {
  return `${PREFIX}${rowId}`;
}

export function parseCardSenderKey(key: string): number | null {
  if (!key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  if (!/^[1-9][0-9]{0,15}$/.test(rest)) return null;
  const n = Number(rest);
  return Number.isSafeInteger(n) ? n : null;
}
