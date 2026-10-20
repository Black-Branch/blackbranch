// Pure classifier for /billing/return, pulled out of page.tsx's inline
// ternary. Retires the "unknown" branch's false reassurance.
export type ReturnStatus = "complete" | "open" | "expired" | "unknown";

export function classifyReturn(
  status: ReturnStatus,
  paymentStatus: string | null // Checkout.Session.payment_status; meaningful only when status === "complete"
): { heading: string; body: string } {
  if (status === "complete") {
    if (paymentStatus === "unpaid") {
      return { heading: "Processing", body: "This payment is still confirming. Your support lands once it does." };
    }
    return {
      heading: "Payment received — thank you! \u{1F499}",
      body: "You're all set. Your support lands in chat and on your account within a few seconds.",
    };
  }
  if (status === "open") {
    return {
      heading: "Payment not completed",
      body: "The payment was cancelled or didn't go through. You can head back and try again — nothing was charged.",
    };
  }
  if (status === "expired") {
    return { heading: "This checkout expired", body: "This checkout session is no longer valid. Head back and start a fresh one." };
  }
  return {
    heading: "Payment status unknown",
    body:
      "We couldn't look this payment up right now. If it went through, your support card shows in " +
      "chat and on your account within a few minutes; if it didn't, nothing was taken.",
  };
}
