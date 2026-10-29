import { describe, expect, it } from 'vitest'
import {
  IncrementalSyncError,
  planSyncDeltas,
  runIncrementalSync,
  type SyncCheckpoint,
  type SyncSink
} from '../../shared/incremental-sync'

const stock = (n: number, qty = 5) =>
  Array.from({ length: n }, (_, i) => ({ key: `SKU-${String(i).padStart(4, '0')}`, value: { quantity: qty } }))
const fp = (rows: ReturnType<typeof stock>) => Object.fromEntries(rows.map((r) => [r.key, JSON.stringify(r.value)]))

function sink(over: Partial<{ depth: (call: number) => number; failAt: number[] }> = {}) {
  const batches: string[][] = []
  const checkpoints: SyncCheckpoint[] = []
  let call = 0
  const s: SyncSink = {
    async apply(batch) {
      call += 1
      if (over.failAt?.includes(call)) throw new Error('d1_unavailable')
      batches.push(batch.map((row) => row.key))
      return { queueDepth: over.depth?.(call) ?? 0 }
    },
    async saveCheckpoint(cp) {
      checkpoints.push(cp)
    }
  }
  return { s, batches, checkpoints }
}

describe('planSyncDeltas', () => {
  it('keeps only new and changed rows', () => {
    const rows = stock(4)
    const previous = fp(rows.slice(0, 3))
    rows[1] = { key: rows[1]!.key, value: { quantity: 9 } }
    const plan = planSyncDeltas('stock', previous, rows)
    expect(plan.upserts.map((r) => r.key)).toEqual(['SKU-0001', 'SKU-0003'])
    expect(plan.unchanged).toBe(2)
  })
  it('ignores key order inside values', () => {
    const plan = planSyncDeltas('feed', { A: JSON.stringify({ a: 1, b: 2 }) }, [{ key: 'A', value: { b: 2, a: 1 } }])
    expect(plan.upserts).toEqual([])
  })
  it.each([
    ['stock', { quantity: -1 }],
    ['stock', { quantity: 1.5 }],
    ['price', { cents: -5 }],
    ['price', { cents: 'x' }]
  ] as const)('rejects invalid %s value %j', (kind, value) => {
    expect(() => planSyncDeltas(kind, {}, [{ key: 'A', value }])).toThrow(IncrementalSyncError)
  })
  it('rejects duplicate keys, empty keys and oversized inputs', () => {
    expect(() => planSyncDeltas('stock', {}, [...stock(1), ...stock(1)])).toThrow(/duplicate_key/)
    expect(() => planSyncDeltas('stock', {}, [{ key: '', value: { quantity: 1 } }])).toThrow(/invalid_row/)
    expect(() => planSyncDeltas('stock', {}, stock(100_001))).toThrow(/too_many_rows/)
  })
})

describe('runIncrementalSync', () => {
  const base = { kind: 'stock' as const, sourceVersion: 'v1', batchSize: 100, highWater: 10, checkpoint: null }
  it('applies only deltas in bounded batches and checkpoints after each', async () => {
    const rows = stock(250)
    const x = sink()
    const r = await runIncrementalSync({ ...base, rows, previous: fp(rows.slice(0, 50)), sink: x.s })
    expect(r.status).toBe('completed')
    expect(r.applied).toBe(200)
    expect(r.skipped).toBe(50)
    expect(x.batches.map((b) => b.length)).toEqual([100, 100])
    expect(x.checkpoints.map((c) => c.applied)).toEqual([100, 200])
    expect(x.checkpoints.at(-1)!.done).toBe(true)
  })
  it('does nothing for an unchanged feed', async () => {
    const rows = stock(10)
    const x = sink()
    const r = await runIncrementalSync({ ...base, rows, previous: fp(rows), sink: x.s })
    expect(r).toMatchObject({ status: 'completed', applied: 0, skipped: 10, batches: 0 })
    expect(x.batches).toEqual([])
  })
  it('honours the byte budget per batch', async () => {
    const x = sink()
    await runIncrementalSync({ ...base, rows: stock(30), previous: {}, sink: x.s, batchSize: 1000, maxBatchBytes: 200 })
    expect(x.batches.length).toBeGreaterThan(1)
    expect(x.batches.flat()).toHaveLength(30)
  })
  it('pauses on backpressure with a checkpoint and resumes from it without reprocessing', async () => {
    const rows = stock(300)
    const first = sink({ depth: (c) => (c === 2 ? 50 : 0) })
    const r1 = await runIncrementalSync({ ...base, rows, previous: {}, sink: first.s })
    expect(r1.status).toBe('backpressure')
    expect(r1.applied).toBe(200)
    expect(r1.checkpoint.done).toBe(false)
    const second = sink()
    const r2 = await runIncrementalSync({ ...base, rows, previous: {}, checkpoint: r1.checkpoint, sink: second.s })
    expect(r2.status).toBe('completed')
    expect(second.batches.flat()).toHaveLength(100)
    expect(second.batches.flat()[0]).toBe('SKU-0200')
    expect(r2.applied).toBe(300)
  })
  it('restarts from zero when the source version changed', async () => {
    const rows = stock(150)
    const cp: SyncCheckpoint = {
      kind: 'stock',
      sourceVersion: 'old',
      cursor: 100,
      applied: 100,
      skipped: 0,
      done: false
    }
    const x = sink()
    const r = await runIncrementalSync({ ...base, rows, previous: {}, checkpoint: cp, sink: x.s })
    expect(x.batches.flat()).toHaveLength(150)
    expect(r.applied).toBe(150)
  })
  it('does not advance the checkpoint past a failed batch, retrying first', async () => {
    const x = sink({ failAt: [2] })
    const r = await runIncrementalSync({ ...base, rows: stock(200), previous: {}, sink: x.s, maxRetries: 1 })
    expect(r.status).toBe('completed')
    const y = sink({ failAt: [2, 3, 4] })
    const failed = await runIncrementalSync({ ...base, rows: stock(200), previous: {}, sink: y.s, maxRetries: 1 })
    expect(failed.status).toBe('failed')
    expect(failed.checkpoint.cursor).toBe(100)
    expect(failed.error).toBe('d1_unavailable')
  })
  it('rejects a checkpoint of another kind or beyond the data', async () => {
    const x = sink()
    const cp: SyncCheckpoint = { kind: 'price', sourceVersion: 'v1', cursor: 0, applied: 0, skipped: 0, done: false }
    await expect(
      runIncrementalSync({ ...base, rows: stock(3), previous: {}, checkpoint: cp, sink: x.s })
    ).rejects.toThrow(/checkpoint_mismatch/)
    const far = { ...cp, kind: 'stock' as const, cursor: 99 }
    await expect(
      runIncrementalSync({ ...base, rows: stock(3), previous: {}, checkpoint: far, sink: x.s })
    ).rejects.toThrow(/checkpoint_mismatch/)
  })
  it('rejects non-positive batch sizes and watermarks', async () => {
    const x = sink()
    await expect(
      runIncrementalSync({ ...base, rows: stock(1), previous: {}, sink: x.s, batchSize: 0 })
    ).rejects.toThrow(/invalid_options/)
    await expect(
      runIncrementalSync({ ...base, rows: stock(1), previous: {}, sink: x.s, highWater: 0 })
    ).rejects.toThrow(/invalid_options/)
  })
  it('syncs prices and generic feeds with their own validation', async () => {
    const x = sink()
    const r = await runIncrementalSync({
      kind: 'price',
      sourceVersion: 'p1',
      batchSize: 10,
      highWater: 5,
      checkpoint: null,
      previous: {},
      rows: [{ key: 'A', value: { cents: 1999 } }],
      sink: x.s
    })
    expect(r.applied).toBe(1)
  })
})
