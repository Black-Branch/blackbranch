// Chat socket health for the device-health report: how many times the shared chat socket dropped
// and scheduled a reconnect this page session. Written by useChatSocket's onclose (the reconnecting
// path only), read by DeviceHealthReporter.
export const socketHealth = { reconnects: 0 };
