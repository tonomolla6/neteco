import { createHash } from 'node:crypto'
import { z } from 'zod'

export type BootstrapQuery = (sql: string) => Promise<Record<string, unknown>[]>
export interface BootstrapInput {
  identityId: string
  commandId: string
  expectedPlanHash: string
  reason: string
}
export interface BootstrapPlan {
  identityId: string
  sessionId: string
  sessionVersion: number
  emailVerifiedAt: string
  mfaVerifiedAt: string
  sessionExpiresAt: string
  permissions: string[]
  planHash: string
}
const uuid = z
  .string()
  .uuid()
  .regex(/^[a-f0-9-]+$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const reasonSchema = z
  .string()
  .min(10)
  .max(500)
  .refine(
    (value) =>
      value === value.trim() &&
      value === value.normalize('NFC') &&
      !Array.from(value).some((char) => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127)
  )
const inputSchema = z
  .object({ identityId: uuid, commandId: uuid, expectedPlanHash: hash, reason: reasonSchema })
  .strict()
const instant = z
  .string()
  .datetime()
  .refine((value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z') === value)
const rowSchema = z.object({
  identity_id: uuid,
  session_id: uuid,
  session_version: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER - 1),
  email_verified_at: instant,
  mfa_verified_at: instant,
  session_expires_at: instant,
  permissions_json: z.string()
})
const literal = (value: string | number) =>
  typeof value === 'number' ? String(value) : "'" + value.replaceAll("'", "''") + "'"
export function parseBootstrapArguments(args: string[]): {
  identityId: string
  apply: boolean
  commandId?: string
  expectedPlanHash?: string
  reason?: string
} {
  const options = new Map<string, string>()
  for (const arg of args) {
    const match = /^(--identity|--command-id|--expected-plan-hash|--reason)=(.+)$/.exec(arg)
    const key = match?.[1] ?? arg
    if ((!match && arg !== '--apply') || options.has(key)) throw new Error('invalid_bootstrap_arguments')
    options.set(key, match?.[2] ?? 'true')
  }
  const identityId = uuid.parse(options.get('--identity'))
  if (!options.has('--apply')) {
    if (options.size !== 1) throw new Error('invalid_bootstrap_arguments')
    return { identityId, apply: false }
  }
  return {
    ...inputSchema.parse({
      identityId,
      commandId: options.get('--command-id'),
      expectedPlanHash: options.get('--expected-plan-hash'),
      reason: options.get('--reason')
    }),
    apply: true
  }
}
/** Fixed local target; deliberately no remote, environment or arbitrary config option. */
export function bootstrapWranglerArguments(sql: string) {
  return [
    'wrangler',
    'd1',
    'execute',
    'DB',
    '--config',
    'wrangler.canary.jsonc',
    '--local',
    '--yes',
    '--json',
    '--command',
    sql
  ]
}
export async function inspectD1AdminBootstrap(identityId: string, query: BootstrapQuery): Promise<BootstrapPlan> {
  uuid.parse(identityId)
  const rows = await query(
    `SELECT * FROM admin_bootstrap_candidates WHERE identity_id=${literal(identityId)} ORDER BY session_created_at DESC,session_id DESC LIMIT 1`
  )
  if (!rows[0]) throw new Error('bootstrap_not_eligible')
  const row = rowSchema.parse(rows[0])
  const permissions = z.array(z.string().min(1).max(100)).min(1).max(100).parse(JSON.parse(row.permissions_json))
  const plan = {
    identityId: row.identity_id,
    sessionId: row.session_id,
    sessionVersion: row.session_version,
    emailVerifiedAt: row.email_verified_at,
    mfaVerifiedAt: row.mfa_verified_at,
    sessionExpiresAt: row.session_expires_at,
    permissions
  }
  return {
    ...plan,
    planHash: createHash('sha256')
      .update(JSON.stringify({ purpose: 'neteco-first-d1-admin-v1', ...plan }))
      .digest('hex')
  }
}
const receipt = (row: Record<string, unknown>) => ({
  source: 'local-d1-bootstrap',
  commandId: row.command_id,
  identityId: row.identity_id,
  roleCode: 'admin',
  planHash: row.plan_hash,
  recordedAt: row.recorded_at,
  sessionRevoked: true
})
export async function applyD1AdminBootstrap(
  raw: BootstrapInput,
  query: BootstrapQuery
): Promise<Record<string, unknown>> {
  const input = inputSchema.parse(raw)
  const select = `SELECT * FROM admin_bootstrap_commands WHERE command_id=${literal(input.commandId)}`
  const previous = (await query(select))[0]
  if (previous) {
    if (
      previous.identity_id !== input.identityId ||
      previous.plan_hash !== input.expectedPlanHash ||
      previous.reason !== input.reason
    )
      throw new Error('bootstrap_idempotency_conflict')
    return receipt(previous)
  }
  const plan = await inspectD1AdminBootstrap(input.identityId, query)
  if (plan.planHash !== input.expectedPlanHash) throw new Error('bootstrap_plan_changed')
  // One statement + database triggers: Wrangler's multi-statement execute is
  // NOT assumed to be a transaction. All checks and effects below are atomic.
  await query(`INSERT INTO admin_bootstrap_commands(command_id,identity_id,session_id,session_version,email_verified_at,mfa_verified_at,session_expires_at,permissions_json,plan_hash,reason,recorded_at)
    VALUES(${[input.commandId, plan.identityId, plan.sessionId, plan.sessionVersion, plan.emailVerifiedAt, plan.mfaVerifiedAt, plan.sessionExpiresAt, JSON.stringify(plan.permissions), plan.planHash, input.reason].map(literal).join(',')},strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(command_id) DO NOTHING RETURNING command_id`)
  const stored = (await query(select))[0]
  if (
    !stored ||
    stored.identity_id !== input.identityId ||
    stored.plan_hash !== input.expectedPlanHash ||
    stored.reason !== input.reason
  )
    throw new Error('bootstrap_receipt_unconfirmed')
  return receipt(stored)
}
