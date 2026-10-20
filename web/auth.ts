import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { sessionFromToken } from "./app/lib/siteSession";
import { consumeLoginHandoff } from "./app/lib/loginHandoff";

// All sign-in flows (both native MAS and federated) go through custom OAuth
// routes (/api/auth/mas-initiate+callback, /api/auth/matrix-initiate+callback)
// that handle device ID scoping and DB upserts, then hand off here via a
// short-lived one-time token, redeemable only by the browser that holds the
// hand-off's cookie (loginHandoff.ts). This provider creates the Auth.js
// session cookie; the user's sessionId is carried through the JWT below.
const federatedCompletionProvider = Credentials({
  id: "federated-completion",
  credentials: { token: {} },
  async authorize(credentials, request) {
    return consumeLoginHandoff(credentials?.token, request.headers.get("cookie"));
  },
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [federatedCompletionProvider],
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 90 },
  callbacks: {
    async jwt({ token, user, account }) {
      if (account?.provider === "federated-completion") {
        token.sub = user?.id;
        token.provider = "federated";
        token.sessionId = (user as { sessionId?: string } | null)?.sessionId;
        return token;
      }
      return token;
    },
    // Every auth(): the cookie names a user only while its site.user_sessions row lives and the
    // account is not deleted, so a logged-out or revoked cookie's copy authorizes nothing
    // (siteSession.ts).
    async session({ session, token }) {
      return sessionFromToken(session, token);
    },
  },
  pages: {
    signIn: "/auth/signin",
  },
});
