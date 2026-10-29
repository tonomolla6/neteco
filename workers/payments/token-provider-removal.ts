import { z } from 'zod'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { PaymentTokenError } from './token-removal'
/** Adapter must make repeated calls with the same idempotencyKey safe. */
export interface TokenDeletionProvider {
  remove(input: { providerToken: string; idempotencyKey: string }): Promise<'deleted' | 'already_deleted' | 'pending'>
}
type TokenRow = {
  status: string
  version: number
  providerToken: string | null
  removalProof: number
  providerProof: number
}
async function read(db: D1Database, id: string) {
  return db
    .prepare(
      `SELECT t.status,t.version,t.provider_token AS providerToken,
    EXISTS(SELECT 1 FROM payment_token_commands c JOIN payment_token_audit a
      ON a.customer_id=c.customer_id AND a.command_id=c.command_id AND a.token_id=c.token_id
      AND a.version=c.version AND a.created_at=c.created_at AND a.action='removal_requested'
      WHERE c.token_id=t.id AND c.customer_id=t.customer_id AND c.version=t.version) AS removalProof,
    EXISTS(SELECT 1 FROM payment_token_provider_audit p WHERE p.token_id=t.id AND p.version=t.version) AS providerProof
    FROM payment_saved_tokens t WHERE t.id=?`
    )
    .bind(id)
    .first<TokenRow>()
}
export async function settlePaymentTokenRemoval(
  db: D1Database,
  id: string,
  provider: TokenDeletionProvider,
  now: string
): Promise<{ outcome: 'removed' | 'pending' }> {
  if (!z.string().uuid().safeParse(id).success || !catalogPolicyInstantSchema.safeParse(now).success)
    throw new PaymentTokenError('invalid_input')
  const row = await read(db, id)
  if (!row) throw new PaymentTokenError('not_found')
  if (row.status === 'removed') {
    if (row.providerToken !== null || row.providerProof !== 1) throw new PaymentTokenError('unavailable')
    return { outcome: 'removed' }
  }
  if (row.status !== 'removal_pending') throw new PaymentTokenError('conflict')
  if (!row.providerToken || row.removalProof !== 1) throw new PaymentTokenError('unavailable')
  let outcome: 'deleted' | 'already_deleted' | 'pending'
  try {
    outcome = await provider.remove({ providerToken: row.providerToken, idempotencyKey: `payment-token-removal:${id}` })
  } catch {
    throw new PaymentTokenError('unavailable')
  }
  if (outcome === 'pending') return { outcome: 'pending' }
  if (outcome !== 'deleted' && outcome !== 'already_deleted') throw new PaymentTokenError('unavailable')
  const firstGuard = crypto.randomUUID(),
    lastGuard = crypto.randomUUID()
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO payment_token_guards(id,valid) SELECT ?1,CASE WHEN EXISTS(
        SELECT 1 FROM payment_saved_tokens WHERE id=?2 AND status='removal_pending' AND version=?3 AND provider_token=?4) THEN 1 ELSE 0 END`
        )
        .bind(firstGuard, id, row.version, row.providerToken),
      db
        .prepare(
          `UPDATE payment_saved_tokens SET status='removed',provider_token=NULL,version=version+1,updated_at=?3
        WHERE id=?1 AND status='removal_pending' AND version=?2`
        )
        .bind(id, row.version, now),
      db
        .prepare(
          `INSERT INTO payment_token_provider_audit(token_id,version,outcome,created_at)
        SELECT id,version,?3,?4 FROM payment_saved_tokens WHERE id=?1 AND status='removed' AND version=?2+1`
        )
        .bind(id, row.version, outcome, now),
      db
        .prepare(
          `INSERT INTO payment_token_guards(id,valid) SELECT ?1,CASE WHEN EXISTS(
        SELECT 1 FROM payment_saved_tokens t JOIN payment_token_provider_audit a ON a.token_id=t.id AND a.version=t.version
        WHERE t.id=?2 AND t.status='removed' AND t.provider_token IS NULL AND t.version=?3+1) THEN 1 ELSE 0 END`
        )
        .bind(lastGuard, id, row.version),
      db.prepare('DELETE FROM payment_token_guards WHERE id IN (?1,?2)').bind(firstGuard, lastGuard)
    ])
  } catch {
    const latest = await read(db, id)
    if (latest?.status === 'removed' && latest.providerToken === null && latest.providerProof === 1)
      return { outcome: 'removed' }
    throw new PaymentTokenError('unavailable')
  }
  const final = await read(db, id)
  if (final?.status !== 'removed' || final.providerToken !== null || final.providerProof !== 1)
    throw new PaymentTokenError('unavailable')
  return { outcome: 'removed' }
}
