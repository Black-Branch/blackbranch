import { siteName } from "@/app/lib/siteName";

// The offline page (/offline.html) the service worker caches and shows when the network is gone,
// generated so it names THIS site. Request time: the site name is this install's, read when the
// server starts (nothing is prerendered). Self-contained on purpose (it can load nothing else when
// offline), with its font sizes on the text scale.
// public/sw.js precaches it by URL: bump its offline cache name if the SHAPE of this page changes.

export const dynamic = "force-dynamic";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function GET() {
  const name = escapeHtml(siteName());
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline — ${name}</title>
<style>
  /* Self-contained on purpose: this page is served from the service-worker
     cache when the network is GONE, so it can reference nothing else. */
  html { background: #131316; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, sans-serif; color: #d4d4d8; text-align: center;
  }
  main { padding: 2rem; max-width: 26rem; }
  h1 { font-size: 1.125rem; color: #fafafa; margin: 0 0 .5rem; }
  p { font-size: .875rem; line-height: 1.5; color: #a1a1aa; margin: 0 0 1.25rem; }
  button {
    font: inherit; font-size: .875rem; font-weight: 600; color: #131316;
    background: #99c1f1; border: 0; border-radius: .5rem; padding: .5rem 1.25rem; cursor: pointer;
  }
  button:hover { background: #b3d1f5; }
</style>
</head>
<body>
<main>
  <h1>You’re offline</h1>
  <p>${name} needs a connection for the stream and chat. This page will work again as soon as you’re back online.</p>
  <button onclick="location.reload()">Try again</button>
</main>
</body>
</html>
`;
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
