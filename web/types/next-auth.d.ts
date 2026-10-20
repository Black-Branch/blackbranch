import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
    /** The site.user_sessions row this cookie is bound to — set only while that row is live. */
    sessionId?: string;
    /** Why the cookie authenticated nothing (siteSession.ts); absent when it did. */
    authState?: "revoked" | "unavailable" | "refused";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    sub?: string;
    provider?: "mas" | "federated";
    sessionId?: string;
  }
}
