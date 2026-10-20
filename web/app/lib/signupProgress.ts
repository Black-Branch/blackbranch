// Where a person is in the sign-up steps: one row in site.signup_answers, key
// 'step', so progress roams between devices and a skipped or finished flow
// never re-prompts. Keys are whitelisted here; optional questions add theirs
// when they are chosen. A factory (house pattern): the route hands it the real
// pool, the test a fake.
/** @test-only the whitelist of keys this table may hold; the test pins it so a new question adds its key here first. */
export const SIGNUP_KEYS = ["step"] as const;

export type SignupStep = 2 | 3 | 4 | 5 | 6 | "done";
const STEPS: readonly SignupStep[] = [2, 3, 4, 5, 6, "done"];

export function parseStep(v: unknown): SignupStep | null {
  if (v === "done") return "done";
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d$/.test(v) ? Number(v) : NaN;
  return (STEPS as readonly unknown[]).includes(n) ? (n as SignupStep) : null;
}

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: { value: string }[] }> };

export function createSignupProgress({ pool }: { pool: Pool }) {
  return {
    async read(matrixId: string): Promise<SignupStep | null> {
      const { rows } = await pool.query(
        "SELECT value FROM site.signup_answers WHERE matrix_id = $1 AND key = 'step'",
        [matrixId]
      );
      return rows[0] ? parseStep(rows[0].value) : null;
    },
    async write(matrixId: string, step: SignupStep): Promise<void> {
      await pool.query(
        `INSERT INTO site.signup_answers (matrix_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (matrix_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [matrixId, "step", String(step)]
      );
    },
  };
}
