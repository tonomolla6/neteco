import { z } from 'zod'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'

export type PreferenceSyncTarget = 'esp' | 'cmp'
/** Payload carries the opaque customer id only: the adapter resolves contact data. */
export interface PreferenceSyncPayload {
  customerId: string
  version: number
  frequency: string
  topics: string[]
  sectors: string[]
  channels: { email: boolean; sms: boolean; push: boolean }
  unsubscribeAll: boolean
}
export type PreferenceSyncResult = { ok: true } | { ok: false; code: string }
export interface PreferenceSyncAdapter {
  apply(
    target: PreferenceSyncTarget,
    payload: PreferenceSyncPayload,
    idempotencyKey: string
  ): Promise<PreferenceSyncResult>
}
/** Deterministic in-memory ESP/CMP: idempotent by key, fails on demand. No network. */
export function createFakePreferenceSyncAdapter(failures: Partial<Record<PreferenceSyncTarget, string>> = {}) {
  const applied = new Map<string, PreferenceSyncPayload>(),
    calls: { target: PreferenceSyncTarget; key: string }[] = []
  const adapter: PreferenceSyncAdapter & {
    applied: typeof applied
    calls: typeof calls
    failures: typeof failures
  } = {
    applied,
    calls,
    failures,
    async apply(target, payload, key) {
      calls.push({ target, key })
      const code = failures[target]
      if (code) return { ok: false, code }
      applied.set(`${target}:${key}`, payload)
      return { ok: true }
    }
  }
  return adapter
}
const MAX_ATTEMPTS = 20,
  LEASE_SECONDS = 120
const add = (now: string, seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const jobSchema = z
  .object({
    id: z.string().min(40),
    customer_id: z.string().uuid(),
    target: z.enum(['esp', 'cmp']),
    attempts: z.number().int().min(0),
    applied_version: z.number().int().min(1),
    frequency: z.string(),
    topics: z.string(),
    sectors: z.string(),
    channel_email: z.number(),
    channel_sms: z.number(),
    channel_push: z.number(),
    unsubscribe_all: z.number()
  })
  .strict()
/**
 * Delivers due ESP/CMP jobs. A job is leased by CAS on its attempt counter, a
 * superseded version is never sent and the newest version always wins.
 */
export async function runPreferenceCenterSync(
  db: D1Database,
  adapter: PreferenceSyncAdapter,
  options: { now: string; limit?: number }
) {
  if (!catalogPolicyInstantSchema.safeParse(options.now).success) throw new Error('invalid_instant')
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100),
    summary = { synced: 0, failed: 0, skipped: 0 }
  const due = await db
    .prepare(
      `SELECT j.id,j.customer_id,j.target,j.attempts,j.applied_version,c.frequency,c.topics,c.sectors,c.channel_email,c.channel_sms,c.channel_push,c.unsubscribe_all
 FROM preference_center_sync_jobs j JOIN preference_center_commands c ON c.customer_id=j.customer_id AND c.command_id=j.command_id
 WHERE j.status IN('pending','failed') AND j.attempts<?2 AND j.next_attempt_at<=?1 ORDER BY j.next_attempt_at,j.id LIMIT ?3`
    )
    .bind(options.now, MAX_ATTEMPTS, limit)
    .all()
  for (const raw of due.results) {
    const job = jobSchema.parse(raw),
      leased = await db
        .prepare(
          `UPDATE preference_center_sync_jobs SET attempts=attempts+1,next_attempt_at=?2,updated_at=?1
 WHERE id=?3 AND status IN('pending','failed') AND attempts=?4 AND next_attempt_at<=?1 RETURNING id`
        )
        .bind(options.now, add(options.now, LEASE_SECONDS), job.id, job.attempts)
        .first()
    if (!leased) {
      summary.skipped++
      continue
    }
    let result: PreferenceSyncResult
    try {
      result = await adapter.apply(
        job.target,
        {
          customerId: job.customer_id,
          version: job.applied_version,
          frequency: job.frequency,
          topics: JSON.parse(job.topics),
          sectors: JSON.parse(job.sectors),
          channels: { email: job.channel_email === 1, sms: job.channel_sms === 1, push: job.channel_push === 1 },
          unsubscribeAll: job.unsubscribe_all === 1
        },
        job.id
      )
    } catch {
      result = { ok: false, code: 'adapter_exception' }
    }
    if (result.ok) {
      await db
        .prepare(
          `UPDATE preference_center_sync_jobs SET status='synced',last_error_code=NULL,updated_at=?1 WHERE id=?2 AND status IN('pending','failed')`
        )
        .bind(options.now, job.id)
        .run()
      summary.synced++
    } else {
      const backoff = Math.min(60 * 2 ** job.attempts, 3600)
      await db
        .prepare(
          `UPDATE preference_center_sync_jobs SET status='failed',last_error_code=?2,next_attempt_at=?3,updated_at=?1 WHERE id=?4 AND status IN('pending','failed')`
        )
        .bind(options.now, result.code.slice(0, 80) || 'adapter_error', add(options.now, backoff), job.id)
        .run()
      summary.failed++
    }
  }
  return summary
}
