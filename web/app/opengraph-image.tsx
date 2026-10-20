import { ImageResponse } from "next/og";
import { installValue } from "@/app/lib/installValues";
import { siteName } from "@/app/lib/siteName";

// The social-share card (1200×630) for og:image + twitter:image. Dark brand look matching the app
// shell (deep navy gradient, accent #99c1f1 wordmark). No external fonts, so it never depends on a
// network font fetch; the default sans is fine here.
// Drawn at request time from this install's values (one image serves every install, so nothing
// may be drawn during `next build`). `alt` is read when this module first loads on a running
// server — after instrumentation.ts has published the install values.
export const dynamic = "force-dynamic";
export const alt = installValue("site.description") ? `${siteName()} — ${installValue("site.description")}` : siteName();

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  // The wordmark: a domain-shaped name keeps its last label in the accent colour ("name" + ".tld").
  const NAME = siteName();
  const DOT = NAME.lastIndexOf(".");
  const [WORD, TLD] = DOT > 0 ? [NAME.slice(0, DOT), NAME.slice(DOT)] : [NAME, ""];
  // The line under the name (install key site.tagline); unset = a neutral line.
  const TAGLINE = installValue("site.tagline") || "A live stream and its community — chat unified across every platform, in one place.";
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "90px",
          background:
            "radial-gradient(ellipse 140% 90% at 50% 0%, #1a2340 0%, #0c1020 55%, #08080a 100%)",
          color: "#ffffff",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <span style={{ fontSize: 108, fontWeight: 800, letterSpacing: "-0.03em", color: "#fafafa" }}>
            {WORD}
          </span>
          <span style={{ fontSize: 108, fontWeight: 800, letterSpacing: "-0.03em", color: "#99c1f1" }}>
            {TLD}
          </span>
        </div>
        <div
          style={{
            marginTop: 28,
            fontSize: 40,
            lineHeight: 1.3,
            color: "#a1a1aa",
            maxWidth: 900,
          }}
        >
          {TAGLINE}
        </div>
        <div
          style={{
            marginTop: 56,
            display: "flex",
            alignItems: "center",
            fontSize: 28,
            fontWeight: 600,
            color: "#99c1f1",
          }}
        >
          Watch · chat · belong
        </div>
      </div>
    ),
    { ...size },
  );
}
