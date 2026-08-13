import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { closeDatabase } from '../server/db/client'
import { ingestBankTransferMovement } from '../server/services/orders'

const movementSchema = z
  .object({
    externalId: z.string().trim().min(1).max(200),
    bookedAt: z.string().datetime({ offset: true }),
    amountCents: z.number().int().positive(),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/),
    reference: z.string().trim().min(1).max(500)
  })
  .strict()

const statementSchema = z.array(movementSchema).min(1).max(10_000)
const fileArgument = process.argv.find((argument) => argument.startsWith('--file='))?.slice('--file='.length)
const provider = process.env.BANK_TRANSFER_STATEMENT_PROVIDER?.trim() || 'statement-import'
if (!fileArgument) throw new Error('--file=/absolute/or/relative/statement.json is required')

try {
  const statement = statementSchema.parse(JSON.parse(await readFile(resolve(fileArgument), 'utf8')))
  const results = []
  for (const movement of statement) {
    results.push(
      await ingestBankTransferMovement({
        ...movement,
        provider,
        bookedAt: new Date(movement.bookedAt),
        correlationId: randomUUID()
      })
    )
  }
  process.stdout.write(
    `${JSON.stringify({
      event: 'payment.bank_transfer.reconciled',
      provider,
      processed: results.length,
      matched: results.filter((result) => result.status === 'matched' && !result.duplicate).length,
      needsReview: results.filter((result) => result.status === 'needs_review').length,
      duplicates: results.filter((result) => result.duplicate).length,
      results
    })}\n`
  )
} finally {
  await closeDatabase()
}
