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
  ]),

  {
    // ── @next/next/no-img-element: OFF, deliberately ────────────────────────
    //
    // The policy here is zero standing warnings: every warning is either fixed or
    // switched off with the reason recorded. A permanent wall of advisories trains
    // everyone to ignore the linter, and then a real warning hides in the noise.
    //
    // This rule advises replacing <img> with next/image. Every <img> site here is
    // correctly a plain <img>, because the image sources are UNBOUNDED REMOTE
    // CONTENT we do not host and cannot enumerate:
    //
    //   emotes            Twitch / 7TV / BTTV CDNs        (EmoteCompletionList, ReactionPicker)
    //   avatars           four platforms' user CDNs       (Avatar, UserCard, BadgeSlots)
    //   link previews     og:image from ANY domain a user pastes   (LinkPreview, FeedPanel)
    //   Matrix media      any homeserver a user federates from     (MatrixAttachments, MatrixHtml)
    //   badges            mod-uploaded, arbitrary URLs             (BadgesSection)
    //
    // next/image requires an enumerable `images.remotePatterns` allowlist. No such
    // list can exist for "any URL a user pastes", and there is no images config at
    // all — so next/image would REJECT these outright rather than optimise them.
    // Routing them through the optimiser would also make the web server proxy
    // arbitrary third-party images: real bandwidth cost, plus an SSRF-flavoured
    // fetch surface. `unoptimized`/a custom loader would satisfy the rule while
    // behaving exactly like <img>, which is lint theatre.
    //
    // The only two LOCAL sources are also non-candidates: /streamplace.svg (SVG
    // gains nothing from the optimiser and would need `dangerouslyAllowSVG`) and
    // the currency icon (currency.icon — a small, already-optimised file).
    //
    // REVISIT IF: the app starts serving images it hosts itself (uploads on our
    // own domain, generated OG cards, a bundled asset set). Those SHOULD use
    // next/image, and at that point scope this off to the remote-content components
    // above rather than leaving it off globally.
    rules: {
      "@next/next/no-img-element": "off",
    },
  },
]);

export default eslintConfig;
