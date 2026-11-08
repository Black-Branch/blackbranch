// An encrypted picture holds the picture's box while its blob is fetched and decrypted (client
// polish Task 11, Step 1b's bar: a decrypt changes what is shown, never the layout). It used to be
// one line of "🔒 decrypting image…", so every line above it jumped by the picture's height on the
// pair (+130 px at 390) once the picture arrived.
// Mounts the real MatrixImage, encrypted and plain, from the same event info, and compares boxes.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/components/matrixImagePending.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../lib/testDom.ts";
import "../lib/testTsx.ts";

// The ciphertext download never answers: the picture stays pending for the whole test.
(globalThis as unknown as { fetch: unknown }).fetch = () => new Promise(() => {});
const { MatrixImage } = await import("./MatrixAttachments.tsx");
const { createRoot } = await import("react-dom/client");

const info = { w: 480, h: 320, mimetype: "image/png" };
const file = { url: "mxc://site.test/enc", key: { k: "x", alg: "A256CTR", ext: true, key_ops: ["decrypt"], kty: "oct" }, iv: "AAAA", hashes: { sha256: "x" }, v: "v2" };

async function mount(content: Record<string, unknown>) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(MatrixImage, { content })); });
  return { host, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

const box = (el: HTMLElement) => ({ width: el.style.width, aspect: el.style.aspectRatio, maxWidth: el.style.maxWidth, mt: el.classList.contains("mt-1") });

test("the pending encrypted picture has the plain picture's box", async () => {
  const plain = await mount({ msgtype: "m.image", body: "cat.png", url: "mxc://site.test/plain", info });
  const img = plain.host.querySelector("img") as HTMLElement;
  assert.ok(img, "the plain picture renders an <img>");
  const enc = await mount({ msgtype: "m.image", body: "cat.png", file, info });
  const pending = enc.host.querySelector("[data-image-pending]") as HTMLElement;
  assert.ok(pending, "the encrypted one is pending (its blob never arrives here)");
  assert.match(pending.textContent ?? "", /decrypting image/);
  assert.deepEqual(box(pending), box(img), "same width, aspect ratio, cap and top margin");
  assert.equal(box(pending).width, "480px");
  assert.equal(box(pending).aspect, "480 / 320");
  // A block, so the aspect ratio gives it the height (an inline span would ignore it).
  assert.ok(pending.classList.contains("flex"));
  await plain.unmount();
  await enc.unmount();
});

test("an encrypted picture with no usable size keeps the one-line placeholder (there is no box to hold)", async () => {
  const enc = await mount({ msgtype: "m.image", body: "cat.png", file, info: { mimetype: "image/png" } });
  const pending = enc.host.querySelector("[data-image-pending]") as HTMLElement;
  assert.ok(pending);
  assert.equal(pending.style.aspectRatio, "");
  await enc.unmount();
});
