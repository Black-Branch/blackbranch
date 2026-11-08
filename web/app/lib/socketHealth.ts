// Chat socket health for the device-health report, this page session. Written by useChatSocket,
// read by DeviceHealthReporter.
//  · reconnects — every close that schedules a retry, INCLUDING attempts that never opened, so a
//    browser that cannot reach the socket's host at all climbs about twice a minute (backoff cap 30 s);
//  · opens — connections that really opened. reconnects high with opens low = chat could not
//    connect; both high = a connection that kept dropping.
export const socketHealth = { reconnects: 0, opens: 0 };
