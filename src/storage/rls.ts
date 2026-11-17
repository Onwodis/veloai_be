/**
 * Runs queries as the signed-in user under Postgres row-level security.
 *
 * Inside the transaction the session switches to the `app_rls` role (no
 * BYPASSRLS) and records who is asking. The policies in migration 002 then
 * decide, in the database, which rows exist for this caller: a user sees and
 * writes only their own likeness, creations, storage and purchases; a super
 * admin sees everyone's; nobody else can read the credential vault. An
 * application bug that forgets a WHERE user_id = … still can't leak rows.
 */
import type { AuthContext } from '../middleware/authenticate.js';
import { sql, type Tx } from '../studio/sql.js';

export async function withUser<T>(auth: Pick<AuthContext, 'userId' | 'role'>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    // One round trip: who is asking + the role switch (set_config('role', …, true) is SET LOCAL ROLE;
    // verified to reset at commit exactly like it).
    await tx`SELECT set_config('app.user_id', ${auth.userId}, true), set_config('app.role', ${auth.role}, true), set_config('role', 'app_rls', true)`;
    return fn(tx);
  }) as Promise<T>;
}
