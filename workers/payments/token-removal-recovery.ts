import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { PaymentTokenError } from './token-removal'
import { settlePaymentTokenRemoval, type TokenDeletionProvider } from './token-provider-removal'

/** Claims are atomic and expire after one minute, so an interrupted worker can retry. */
export async function recoverPaymentTokenRemovals(
  db: D1Database,
  provider: TokenDeletionProvider,
  options: { now: string; limit: number }
): Promise<{ claimed: number; removed: number; pending: number; failed: number }> {
  if (
    !catalogPolicyInstantSchema.safeParse(options.now).success ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 25
  )
    throw new PaymentTokenError('invalid_input')
  const due = await db
    .prepare(
      `SELECT token_id AS id FROM payment_token_removal_jobs
    WHERE status='pending' AND due_at<=? ORDER BY due_at,token_id LIMIT ?`
    )
    .bind(options.now, options.limit)
    .all<{ id: string }>()
  if (!due.success) throw new PaymentTokenError('unavailable')
  const report = { claimed: 0, removed: 0, pending: 0, failed: 0 }
  for (const row of due.results) {
    const claim = await db
      .prepare(
        `UPDATE payment_token_removal_jobs SET attempts=attempts+1,
      due_at=strftime('%Y-%m-%dT%H:%M:%SZ',?1,'+60 seconds'),updated_at=?1
      WHERE token_id=?2 AND status='pending' AND due_at<=?1 RETURNING token_id`
      )
      .bind(options.now, row.id)
      .first<{ token_id: string }>()
    if (!claim) continue
    report.claimed++
    try {
      const result = await settlePaymentTokenRemoval(db, row.id, provider, options.now)
      if (result.outcome === 'pending') {
        report.pending++
        continue
      }
      const marked = await db
        .prepare(
          `UPDATE payment_token_removal_jobs SET status='done',updated_at=?2
        WHERE token_id=?1 AND status='pending' AND EXISTS(SELECT 1 FROM payment_saved_tokens WHERE id=?1 AND status='removed') RETURNING token_id`
        )
        .bind(row.id, options.now)
        .first<{ token_id: string }>()
      if (!marked) throw new PaymentTokenError('unavailable')
      report.removed++
    } catch {
      report.failed++
    }
  }
  return report
}
