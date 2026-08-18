import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workers = [
  ['scripts/outbox-worker.ts', 'event_type IN'],
  ['scripts/invoice-worker.ts', "event_type = 'invoice.issue.requested'"],
  ['scripts/refund-worker.ts', "event_type = 'refund.execute.requested'"],
  ['scripts/credit-note-worker.ts', "event_type = 'invoice.credit.requested'"]
] as const

describe('critical worker lease recovery', () => {
  it.each(workers)('%s reclaims only its own expired processing leases', async (file, queueGuard) => {
    const source = await readFile(file, 'utf8')
    for (const contract of [
      "SET status = 'retry', available_at = now(), locked_at = NULL, locked_by = NULL",
      "last_error_code = 'stale_worker_lease'",
      "WHERE status = 'processing' AND locked_at < now() - interval '15 minutes'",
      queueGuard
    ]) {
      expect(source).toContain(contract)
    }
  })
})
