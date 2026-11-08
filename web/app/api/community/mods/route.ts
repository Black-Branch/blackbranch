import pool from "@/lib/db";
import { auth } from "@/auth";
import { requireAdmin } from "@/app/lib/admin";
import { staffMatrixIds } from "@/app/lib/staff";
import { feedEnv } from "@/app/lib/community/desiredServer";
import { communityModsResponse } from "@/app/lib/community/modsAnswer";

// The admin's mod list plus, for every signed-in member, the community ladder: app/lib/community/modsAnswer.ts.
export async function GET() {
  return communityModsResponse({
    viewer: async () => {
      const id = (await auth())?.user?.id;
      return id ? { id, admin: (await requireAdmin()) === id } : null;
    },
    db: pool,
    env: feedEnv,
    keepIds: staffMatrixIds,
  });
}
