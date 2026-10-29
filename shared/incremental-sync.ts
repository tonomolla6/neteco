import { z } from 'zod'

/** PER-024: pure incremental bulk-sync engine for feeds, stock and prices.
 * Deltas against the current fingerprints, byte/row-bounded batches, queue
 * backpressure and resumable checkpoints. The sink (D1/Queue) is injected. */

export const SYNC_MAX_ROWS = 100_000
export const SYNC_DEFAULT_BATCH_BYTES = 500_000

export type SyncKind = 'stock' | 'price' | 'feed'
export interface SyncRow {
  key: string
  value: unknown
}
export interface SyncCheckpoint {
  kind: SyncKind
  sourceVersion: string
  /** Index in the key-sorted rows of the next row to examine. */
  cursor: number
  applied: number
  skipped: number
  done: boolean
}
export interface SyncSink {
  apply(batch: SyncRow[]): Promise<{ queueDepth: number }>
  saveCheckpoint(checkpoint: SyncCheckpoint): Promise<void>
}

export class IncrementalSyncError extends Error {
  constructor(
    readonly code: 'duplicate_key' | 'invalid_row' | 'too_many_rows' | 'checkpoint_mismatch' | 'invalid_options'
  ) {
    super(code)
  }
}

const valueSchemas: Record<SyncKind, z.ZodType> = {
  stock: z.object({ quantity: z.number().int().min(0).max(1_000_000_000) }).strict(),
  price: z.object({ cents: z.number().int().min(0).max(100_000_000) }).strict(),
  feed: z.record(z.string(), z.unknown())
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Fingerprint stored per key: callers keep `previous[key] = fingerprint(value)`. */
export const syncFingerprint = stable

function validateRows(kind: SyncKind, rows: SyncRow[]): SyncRow[] {
  if (rows.length > SYNC_MAX_ROWS) throw new IncrementalSyncError('too_many_rows')
  const seen = new Set<string>()
  for (const row of rows) {
    if (
      typeof row.key !== 'string' ||
      !row.key ||
      row.key.length > 128 ||
      !valueSchemas[kind].safeParse(row.value).success
    ) {
      throw new IncrementalSyncError('invalid_row')
    }
    if (seen.has(row.key)) throw new IncrementalSyncError('duplicate_key')
    seen.add(row.key)
  }
  return rows.toSorted((a, b) => (a.key < b.key ? -1 : 1))
}

export function planSyncDeltas(kind: SyncKind, previous: Record<string, string>, rows: SyncRow[]) {
  const sorted = validateRows(kind, rows)
  const upserts = sorted.filter((row) => previous[row.key] !== stable(row.value))
  return { upserts, unchanged: sorted.length - upserts.length }
}

export interface IncrementalSyncOptions {
  kind: SyncKind
  sourceVersion: string
  rows: SyncRow[]
  previous: Record<string, string>
  checkpoint: SyncCheckpoint | null
  sink: SyncSink
  batchSize: number
  highWater: number
  maxBatchBytes?: number
  maxRetries?: number
}
export interface IncrementalSyncResult {
  status: 'completed' | 'backpressure' | 'failed'
  checkpoint: SyncCheckpoint
  applied: number
  skipped: number
  batches: number
  error?: string
}

export async function runIncrementalSync(options: IncrementalSyncOptions): Promise<IncrementalSyncResult> {
  const { kind, sink } = options
  const maxBytes = options.maxBatchBytes ?? SYNC_DEFAULT_BATCH_BYTES
  const retries = options.maxRetries ?? 2
  if (![options.batchSize, options.highWater, maxBytes].every((n) => Number.isInteger(n) && n > 0) || retries < 0) {
    throw new IncrementalSyncError('invalid_options')
  }
  const rows = validateRows(kind, options.rows)
  const unchanged = (row: SyncRow) => options.previous[row.key] === stable(row.value)

  let checkpoint: SyncCheckpoint = {
    kind,
    sourceVersion: options.sourceVersion,
    cursor: 0,
    applied: 0,
    skipped: 0,
    done: false
  }
  if (options.checkpoint) {
    if (options.checkpoint.kind !== kind || options.checkpoint.cursor > rows.length || options.checkpoint.cursor < 0) {
      throw new IncrementalSyncError('checkpoint_mismatch')
    }
    if (options.checkpoint.sourceVersion === options.sourceVersion) checkpoint = { ...options.checkpoint }
  }
  let batches = 0
  const result = (status: IncrementalSyncResult['status'], error?: string): IncrementalSyncResult => ({
    status,
    checkpoint,
    applied: checkpoint.applied,
    skipped: checkpoint.skipped,
    batches,
    ...(error ? { error } : {})
  })
  if (checkpoint.done) return result('completed')

  while (checkpoint.cursor < rows.length) {
    const batch: SyncRow[] = []
    let bytes = 0
    let cursor = checkpoint.cursor
    let skipped = checkpoint.skipped
    while (cursor < rows.length) {
      const row = rows[cursor]!
      if (unchanged(row)) {
        skipped += 1
        cursor += 1
        continue
      }
      const size = stable(row).length
      if (batch.length && (batch.length >= options.batchSize || bytes + size > maxBytes)) break
      batch.push(row)
      bytes += size
      cursor += 1
    }
    if (batch.length === 0) {
      checkpoint = { ...checkpoint, cursor, skipped, done: true }
      await sink.saveCheckpoint(checkpoint)
      return result('completed')
    }
    let depth = 0
    let failure: string | undefined
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        depth = (await sink.apply(batch)).queueDepth
        failure = undefined
        break
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
    }
    if (failure !== undefined) return result('failed', failure)
    batches += 1
    // Trailing unchanged rows are consumed so the final batch can be marked done.
    while (cursor < rows.length && unchanged(rows[cursor]!)) {
      skipped += 1
      cursor += 1
    }
    checkpoint = {
      ...checkpoint,
      cursor,
      skipped,
      applied: checkpoint.applied + batch.length,
      done: cursor >= rows.length
    }
    await sink.saveCheckpoint(checkpoint)
    if (!checkpoint.done && depth >= options.highWater) return result('backpressure')
  }
  if (!checkpoint.done) {
    checkpoint = { ...checkpoint, done: true }
    await sink.saveCheckpoint(checkpoint)
  }
  return result('completed')
}
