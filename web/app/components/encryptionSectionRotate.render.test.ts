// Settings › Encryption on a verified device, RENDERED: the recovery-key button follows the
// SERVER's secret storage, never this device's local backup state (encryption audit 2026-09-20,
// finding B — "Generate a recovery key" on a device that merely had not loaded the backup invited
// people to replace a backup full of history), and the reset says what it costs.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/encryptionSectionRotate.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../lib/testDom.ts";
import { installResizeObserverStub } from "../lib/testTsx.ts";

installResizeObserverStub();
const { EncryptionSection } = await import("./MatrixSettings/EncryptionSection.tsx");
const { createRoot } = await import("react-dom/client");

const noop = () => {};
const anoop = async () => {};
function props(over: Record<string, unknown>) {
  return {
    status: "ready", retry: noop, crossSigningOk: true, hasCrossSigningKeys: true, flowState: "verified",
    backupActive: true, fourSExists: true, verifyPending: false, restoreResult: null,
    showRecoveryKey: false, setShowRecoveryKey: noop, recoveryKeyInput: "", setRecoveryKeyInput: noop,
    recoveryKeyVisible: false, setRecoveryKeyVisible: noop, restoring: false, restoreProgress: null,
    restoreError: null, setRestoreError: noop, restoreNeedsFreshDevice: false, startDeviceOver: anoop,
    applyRecoveryKey: anoop, dismissRecoveryKey: noop, startFreshFromKeyError: noop,
    showSetupFlow: false, setShowSetupFlow: noop, setupStep: null, generatedKey: "", setupError: null,
    setSetupError: noop, keyCopied: false, keyVisible: false, setKeyVisible: noop,
    generateAndSetupEncryption: anoop, rotateRecoveryKey: anoop, finishSetup: anoop, copyKey: anoop,
    resetApprovalUrl: null, dismissResetApproval: noop,
    ...over,
  };
}

function render(over: Record<string, unknown>) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(EncryptionSection, props(over) as never)));
  const text = host.textContent ?? "";
  act(() => root.unmount());
  host.remove();
  return text;
}

test("backupActive false still reads 'Rotate recovery key →' while the account has a recovery key", () => {
  const t = render({ backupActive: false, fourSExists: true });
  assert.match(t, /Rotate recovery key →/);
  assert.doesNotMatch(t, /Generate a recovery key/);
  assert.doesNotMatch(t, /No recovery key saved/);
});

test("an account with no recovery key at all is offered one (vacuity: the label does switch)", () => {
  const t = render({ backupActive: false, fourSExists: false });
  assert.match(t, /Generate a recovery key →/);
});

test("the rotate step says the history stays", () => {
  const t = render({ showSetupFlow: true });
  assert.match(t, /message history/i);
  assert.doesNotMatch(t, /Generate a recovery key/);
});

test("the reset says what it costs", () => {
  const t = render({ crossSigningOk: false, flowState: "orphaned" });
  assert.match(t, /Messages older than this can't be read on new devices/);
});
