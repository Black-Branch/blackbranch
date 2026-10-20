# web/ — the site

The site itself: native + cross-platform chat, the embedded Matrix community client, Stripe and
PayPal billing and supporter perks, mod tools, the points economy, settings and themes, VODs, the
setup pages, the Admin Panel and the doctor, and the installable app (PWA).

Not a scaffold, and **not a Vercel app**: an install builds and serves it inside the bundle
(`../install/`).

## Getting started

```bash
npm run dev     # localhost:3000
```

Routes live under `app/(main)/`, `app/chat/`, `app/popout/`, `app/billing/`, `app/about/`,
`app/legal/`, `app/oauth/`, plus the route handlers under `app/api/`. **There is no `app/page.tsx`** —
the root route is `app/(main)/page.tsx`.

Requires `.env.local` (not in git; `.env.example` lists every value). The app connects
**directly** to Postgres — reads from `stream.*`, writes only to `site.*` — and consumes the
stream-api WebSocket for live chat.

## Build

```bash
npm run build   # runs `npm run check:all` (12 gates) then `next build`
npm run lint
npm run check:types   # tsc --noEmit alone — `next build` does NOT typecheck test files
npm test              # node --test "app/**/*.test.ts"
```

The twelve gates, any one of which fails the build:

| Gate | Catches |
|---|---|
| `check-prepaint` | `settingsRegistry.ts` ⇄ `app/layout.tsx` prepaint-mirror drift |
| `check-tokens` | raw `zinc-*` / `text-white` / bare chat-font multipliers |
| `check-structure` | dependency direction + feature encapsulation |
| `check-layering` | `globals.css` is unlayered, so it silently beats Tailwind utilities |
| `check-device-queries` | media-query shape |
| `check-orphans` | unreferenced exports in `app/lib/**`, `lib/**`, `app/features/**`, `app/components/**` (tag `@parked`/`@test-only` + a reason, in the definition's own docblock). References are counted with comments stripped — a mention is not a call site. |
| `check-chrome` | tab / bar / window chrome rendered anywhere but `app/components/chrome/` — `role="tab"`, a direct import of a chrome internal, or a retired chrome class |
| `check-owner-literals` | a NEW literal that belongs to one install or one person — a private-network address, a home folder, a personal email address, a live key (`tools/literals.json`), plus an install owner's own names where that owner keeps a private pattern file: a ratchet against `tools/owner-literals.baseline.json`; a file's count may only go down, a new file must be zero. Comments count. Shared with the backends (`../tools/check-owner-literals.mjs`). |
| `check-owner-seam` | product code importing an install's owner folder `app/(owner)/` anywhere but the one seam, `app/lib/plugins/` (`@owner/…`) — the product must build without that folder. Shared with the backends (`../tools/check-owner-seam.mjs`). |
| `check-instance-schema` | `app/lib/instanceSchema.generated.mjs` drifted from `config/instance-schema.mjs` (the one settings schema; regenerate with `node tools/gen-instance-schema.mjs`, never hand-edit). Shared with the backends. |
| `tsc --noEmit` | types, including test files |
| `eslint` | lint errors (warnings do not fail) |

`app/lib/ciGates.test.ts` asserts this set stays in sync between `package.json` and CI — if you
add a gate, update that test and this table together.

## Deploy

The site is one image for every install (`install/Dockerfile`, target `web`): nothing of an install
is built into it — its name, addresses and the rest are read from the environment when the server
starts (`app/lib/installValues.ts`), and every page is rendered at request time. A release pulls the
image by digest — see `../install/README.md` (`blackbranch set`, and updates).

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · Auth.js v5 · `pg` pool (direct Postgres) ·
matrix-js-sdk · Stripe

Next.js 16 has breaking changes from earlier versions — read the relevant guide in
`node_modules/next/dist/docs/` before writing App Router code, and heed deprecation notices.
