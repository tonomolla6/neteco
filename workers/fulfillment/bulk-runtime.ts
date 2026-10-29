import { z } from 'zod'
import { supportUuid } from '../../shared/support-operations'
import { AdminOrderBulkError, processD1AdminOrderBulkStep, readD1AdminOrderBulkDispatches } from './bulk'

export interface AdminOrderBulkQueue {
  send(body: { type: 'admin.order-bulk.requested'; groupId: string; dispatchId: string }): Promise<unknown>
}
export interface AdminOrderBulkRuntimeOptions {
  enabled: boolean
  now?: string
  limit?: number
  queue?: AdminOrderBulkQueue
}
export type AdminOrderBulkMessageOutcome = 'completed' | 'requeued' | 'retry' | 'invalid' | 'disabled'
const dispatchSchema = z.object({ groupId: supportUuid, dispatchId: supportUuid }).strict()
const messageSchema = z
  .object({ type: z.literal('admin.order-bulk.requested'), groupId: supportUuid, dispatchId: supportUuid })
  .strict()
export function parseAdminOrderBulkMessage(raw: unknown): z.infer<typeof messageSchema> | null {
  const parsed = messageSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
const stepSchema = z
  .object({
    source: z.literal('cloudflare'),
    groupId: supportUuid,
    dispatchId: supportUuid,
    processed: z.number().int().min(0).max(1),
    remaining: z.number().int().min(0).max(25),
    requeue: z.boolean(),
    status: z.enum(['pending', 'completed', 'paused'])
  })
  .strict()
  .refine(
    (value) =>
      value.requeue === (value.status === 'pending' && value.remaining > 0) &&
      (value.status !== 'completed' || value.remaining === 0)
  )
export async function dispatchAdminOrderBulkRequests(
  database: D1Database,
  queue: AdminOrderBulkQueue,
  options: AdminOrderBulkRuntimeOptions
): Promise<{ selected: number; sent: number; failed: number }> {
  if (!options.enabled) return { selected: 0, sent: 0, failed: 0 }
  const limit = z
    .number()
    .int()
    .min(1)
    .max(5)
    .parse(options.limit ?? 5)
  const rows = z
    .array(dispatchSchema)
    .max(limit)
    .parse(
      await readD1AdminOrderBulkDispatches(database, {
        ...(options.now === undefined ? {} : { now: options.now }),
        limit
      })
    )
  if (new Set(rows.map((row) => row.groupId)).size !== rows.length) throw new Error('unconfirmed_bulk_dispatches')
  let sent = 0,
    failed = 0
  for (const row of rows) {
    try {
      await queue.send({ type: 'admin.order-bulk.requested', ...row })
      sent++
    } catch {
      failed++
    }
  }
  return { selected: rows.length, sent, failed }
}
export async function consumeAdminOrderBulkMessage(
  database: D1Database,
  raw: unknown,
  options: AdminOrderBulkRuntimeOptions
): Promise<AdminOrderBulkMessageOutcome> {
  if (!options.enabled) return 'disabled'
  const message = parseAdminOrderBulkMessage(raw)
  if (!message) return 'invalid'
  try {
    const result = stepSchema.parse(
      await processD1AdminOrderBulkStep(database, message.groupId, message.dispatchId, {
        ...(options.now === undefined ? {} : { now: options.now }),
        limit: 1
      })
    )
    if (result.groupId !== message.groupId || result.dispatchId !== message.dispatchId) return 'retry'
    if (!result.requeue) return 'completed'
    if (!options.queue) return 'retry'
    await options.queue.send(message)
    return 'requeued'
  } catch (error) {
    if (error instanceof AdminOrderBulkError && ['invalid_input', 'not_found'].includes(error.code)) return 'invalid'
    return 'retry'
  }
}
