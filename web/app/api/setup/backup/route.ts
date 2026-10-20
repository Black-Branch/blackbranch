// Setup step 8, backups. POST { target, repository, region, accessKeyId, secretAccessKey } — save
// where backups go and ask the host for a test (a backup, then a verify of it); POST { key: true } —
// ask the host for the SFTP key; GET — the test's answer, whether it passed, the key's public half.
import { backupTestStatus, requestBackupKey, startBackupTest } from "@/app/lib/setup/setupServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = body.key === true ? await requestBackupKey(req) : await startBackupTest(req, body);
  return Response.json(r.body, { status: r.status });
}

export async function GET(req: Request) {
  const r = await backupTestStatus(req);
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
