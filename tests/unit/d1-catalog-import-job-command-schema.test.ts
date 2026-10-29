import { readFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const directory = new URL('../../db/d1/migrations/', import.meta.url)
const migration = new URL('0057_catalog_import_job_commands.sql', directory)
const actor = '00570000-0000-4000-8000-000000000001'
const job = '00570000-0000-4000-8000-000000000002'
const id = '00570000-0000-4000-8000-000000000003'
const nonce = '00570000-0000-4000-8000-000000000004'
const other = '00570000-0000-4000-8000-000000000005'
const hash = 'a'.repeat(64)
const now = '2026-10-04T10:00:00Z'
const counts = { products: 601, variants: 601, assets: 601, mappings: 601 }
const receipt = () => ({
  source: 'cloudflare',
  action: 'apply',
  jobId: job,
  jobHash: hash,
  commandId: id,
  counts,
  updated: true
})

describe('incremental immutable whole-job commands and per-row audit schema', () => {
  let sqlite: DatabaseSync
  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys=ON')
    const historical = (await readdir(directory))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 56)
      .sort()
    expect(historical).toHaveLength(56)
    for (const name of historical) sqlite.exec(await readFile(new URL(name, directory), 'utf8'))
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    sqlite.limits.likePatternLength = 50
  })
  afterEach(() => sqlite.close())
  const apply = async () => sqlite.exec(await readFile(migration, 'utf8'))
  function seed() {
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,status,created_at,updated_at) VALUES (?,'commands57@example.invalid','synthetic','active',?,?)"
      )
      .run(actor, now, now)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,status,created_at,updated_at) VALUES (?,'other57@example.invalid','synthetic','active',?,?)"
      )
      .run(other, now, now)
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,created_at) VALUES ('job57warehouse','JOB57','Synthetic','warehouse',?)"
      )
      .run(now)
    sqlite
      .prepare(
        "INSERT INTO catalog_import_jobs(id,actor_id,warehouse_id,idempotency_key,payload_hash,total_pages,record_count,created_at,expires_at) VALUES (?,?,'job57warehouse','create57',?,2,601,?,'2026-10-05T10:00:00Z')"
      )
      .run(job, actor, hash, now)
    sqlite
      .prepare(
        "INSERT INTO catalog_import_job_seals(job_id,hash,counts,reason,created_at,expires_at) VALUES (?,?,?,'Approved whole job',?,'2026-10-04T10:30:00Z')"
      )
      .run(job, hash, JSON.stringify(counts), now)
  }
  function command(response: unknown = receipt(), patch: Record<string, string> = {}) {
    const values = {
      id,
      nonce,
      actor_id: actor,
      job_id: job,
      action: 'apply',
      idempotency_key: 'apply57',
      payload_hash: hash,
      reason: 'Approved whole job',
      created_at: now,
      ...patch
    }
    return sqlite
      .prepare(
        'INSERT INTO catalog_import_job_commands(id,nonce,actor_id,job_id,action,idempotency_key,payload_hash,reason,response,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        values.id,
        values.nonce,
        values.actor_id,
        values.job_id,
        values.action,
        values.idempotency_key,
        values.payload_hash,
        values.reason,
        typeof response === 'string' ? response : JSON.stringify(response),
        values.created_at
      )
  }
  function audit(before: string | null, after: string, kind = 'variants', item = 'variant57') {
    return sqlite
      .prepare(
        'INSERT INTO catalog_import_job_command_audit(command_id,kind,item_id,before_state,after_state) VALUES (?,?,?,?,?)'
      )
      .run(id, kind, item, before, after)
  }
  it('migrates an empty schema with foreign keys enabled and no extra guard table', async () => {
    await apply()
    expect(sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(sqlite.prepare('SELECT count(*) n FROM catalog_import_job_commands').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) n FROM catalog_import_job_command_audit').get()).toEqual({ n: 0 })
  })
  it('preserves existing staged data incrementally without another guard table', async () => {
    seed()
    const jobs = sqlite.prepare('SELECT * FROM catalog_import_jobs').all(),
      seals = sqlite.prepare('SELECT * FROM catalog_import_job_seals').all()
    await apply()
    expect(sqlite.prepare('SELECT * FROM catalog_import_jobs').all()).toEqual(jobs)
    expect(sqlite.prepare('SELECT * FROM catalog_import_job_seals').all()).toEqual(seals)
    expect(sqlite.prepare('SELECT count(*) n FROM catalog_import_job_commands').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) n FROM catalog_import_job_command_audit').get()).toEqual({ n: 0 })
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'catalog_import_job%guard%'")
        .all()
    ).toEqual([{ name: 'catalog_import_job_guards' }])
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('accepts a strict sealed receipt and matching revert, with immutable commands', async () => {
    await apply()
    seed()
    command()
    const revertId = '00570000-0000-4000-8000-000000000006'
    command(
      { ...receipt(), action: 'revert', commandId: revertId },
      { id: revertId, nonce: other, action: 'revert', idempotency_key: 'revert57' }
    )
    expect(sqlite.prepare('SELECT count(*) n FROM catalog_import_job_commands').get()).toEqual({ n: 2 })
    for (const sql of [
      "UPDATE catalog_import_job_commands SET reason='changed'",
      'DELETE FROM catalog_import_job_commands'
    ])
      expect(() => sqlite.exec(sql)).toThrow(/import_job_command_immutable/)
    expect(() => command()).toThrow(/import_job_command_immutable/)
    expect(() =>
      sqlite.exec(
        "INSERT OR REPLACE INTO catalog_import_job_commands SELECT * FROM catalog_import_job_commands WHERE action='apply'"
      )
    ).toThrow(/import_job_command_immutable/)
  })
  it('rejects actor, seal hash, receipt identities, chronology and exact counts mismatches', async () => {
    await apply()
    seed()
    for (const patch of [
      { jobHash: 'b'.repeat(64) },
      { commandId: other },
      { jobId: other },
      { action: 'revert' },
      { counts: { ...counts, variants: 600 } }
    ])
      expect(() => command({ ...receipt(), ...patch })).toThrow()
    expect(() => command(receipt(), { actor_id: other })).toThrow(/import_job_command_shape/)
    expect(() => command(receipt(), { created_at: '2026-10-04T09:59:59Z' })).toThrow(/import_job_command_shape/)
    expect(sqlite.prepare('SELECT count(*) n FROM catalog_import_job_commands').get()).toEqual({ n: 0 })
  })
  it('rejects every missing receipt and count field rather than accepting NULL CHECK results', async () => {
    await apply()
    seed()
    for (const field of Object.keys(receipt())) {
      const raw = Object.fromEntries(Object.entries(receipt()).filter(([key]) => key !== field))
      expect(() => command(raw)).toThrow()
    }
    for (const field of Object.keys(counts)) {
      const raw = Object.fromEntries(Object.entries(counts).filter(([key]) => key !== field))
      expect(() => command({ ...receipt(), counts: raw })).toThrow()
    }
    for (const response of [
      { ...receipt(), extra: 1 },
      { ...receipt(), counts: { ...counts, extra: 1 } },
      { ...receipt(), updated: 1 },
      { ...receipt(), counts: { ...counts, products: '601' } },
      { ...receipt(), counts: null },
      { ...receipt(), source: null },
      'null',
      '[]',
      '{malformed'
    ])
      expect(() => command(response)).toThrow()
    expect(() =>
      command(JSON.stringify(receipt()).replace('"source":"cloudflare"', '"source":"cloudflare","source":"cloudflare"'))
    ).toThrow(/import_job_command_shape/)
    expect(() => command(JSON.stringify(receipt()).replace('"products":601', '"products":601,"products":601'))).toThrow(
      /import_job_command_shape/
    )
  })
  it('rejects malformed command metadata, nonexistent foreign keys and unsealed jobs', async () => {
    await apply()
    seed()
    for (const patch of [
      { id: 'short' },
      { nonce: 'short' },
      { payload_hash: 'A'.repeat(64) },
      { payload_hash: 'a'.repeat(63) },
      { reason: '  a  ' },
      { reason: 'x'.repeat(501) },
      { idempotency_key: '' },
      { idempotency_key: 'x'.repeat(201) },
      { created_at: 'not-time' },
      { job_id: other }
    ])
      expect(() => command(receipt(), patch)).toThrow()
    sqlite
      .prepare(
        "INSERT INTO catalog_import_jobs(id,actor_id,warehouse_id,idempotency_key,payload_hash,total_pages,record_count,created_at,expires_at) VALUES (?,?,'job57warehouse','unsealed',?,1,1,?,'2026-10-05T10:00:00Z')"
      )
      .run(other, actor, hash, now)
    expect(() => command({ ...receipt(), jobId: other }, { job_id: other })).toThrow(/import_job_command_shape/)
  })
  it('rejects replacement by all durable uniqueness keys, including distinct command IDs', async () => {
    await apply()
    seed()
    command()
    for (const patch of [
      { id: other },
      { id: other, nonce: other },
      { id: other, nonce: other, idempotency_key: 'distinct' }
    ])
      expect(() => command({ ...receipt(), commandId: other }, patch)).toThrow(/import_job_command_immutable/)
    expect(sqlite.prepare('SELECT count(*) n FROM catalog_import_job_commands').get()).toEqual({ n: 1 })
  })
  it('retains nulls in object and grouped-array snapshots for all seven kinds with composite keys', async () => {
    await apply()
    seed()
    command()
    const grouped = JSON.stringify([
      { id: 'v', color: null },
      { label: null, quantity: 0 }
    ])
    for (const kind of ['products', 'variants', 'assets', 'media', 'prices', 'balances', 'movements']) {
      const item =
        kind === 'media'
          ? JSON.stringify(['product', null, 'asset', 'primary', 'v1'])
          : kind === 'balances'
            ? JSON.stringify(['variant', 'warehouse'])
            : kind + '-id'
      audit(null, grouped, kind, item)
      expect(
        sqlite.prepare('SELECT before_state,after_state FROM catalog_import_job_command_audit WHERE kind=?').get(kind)
      ).toEqual({ before_state: null, after_state: grouped })
    }
    audit('{"color":null}', '{"color":null}', 'variants', 'second')
    expect(
      sqlite
        .prepare(
          "SELECT json_type(before_state,'$.color') t FROM catalog_import_job_command_audit WHERE item_id='second'"
        )
        .get()
    ).toEqual({ t: 'null' })
  })
  it('enforces audit foreign keys, snapshot shapes and append-only update/delete/replace', async () => {
    await apply()
    seed()
    command()
    audit(null, '{"color":null}')
    for (const [before, after, kind] of [
      [null, 'null', 'assets'],
      [null, '1', 'assets'],
      ['true', '{}', 'assets'],
      ['{broken', '{}', 'assets'],
      [null, '{}', 'unknown']
    ] as const)
      expect(() => audit(before, after, kind)).toThrow()
    for (const sql of [
      "UPDATE catalog_import_job_command_audit SET before_state='{}'",
      'DELETE FROM catalog_import_job_command_audit',
      'INSERT OR REPLACE INTO catalog_import_job_command_audit SELECT * FROM catalog_import_job_command_audit'
    ])
      expect(() => sqlite.exec(sql)).toThrow(/import_job_audit_immutable/)
    expect(() =>
      sqlite.prepare("INSERT INTO catalog_import_job_command_audit VALUES (?,'assets','orphan',NULL,'{}')").run(other)
    ).toThrow(/FOREIGN KEY/)
    expect(() => audit(null, '{}')).toThrow(/import_job_audit_immutable/)
  })
  it('bounds individual snapshots at 1800000 and combined rows at 1900000 exact UTF-8 bytes', async () => {
    await apply()
    seed()
    command()
    const boundary = JSON.stringify({ text: 'é'.repeat(899994) + 'x' })
    expect(new TextEncoder().encode(boundary).byteLength).toBe(1800000)
    audit(null, boundary)
    const half = JSON.stringify({ text: 'é'.repeat(449994) + 'x' })
    expect(new TextEncoder().encode(half).byteLength).toBe(900000)
    audit(half, half, 'assets', 'combined-boundary')
    const combinedHalf = JSON.stringify({ text: 'é'.repeat(474994) + 'x' })
    expect(new TextEncoder().encode(combinedHalf).byteLength).toBe(950000)
    audit(combinedHalf, combinedHalf, 'assets', 'combined-1900000')
    expect(() => audit(boundary, boundary, 'assets', 'combined-large')).toThrow(/CHECK/)
    audit('{}', boundary, 'assets', 'combined-two-extra')
    const smallOversized = JSON.stringify({ text: 'x'.repeat(99990) })
    expect(new TextEncoder().encode(smallOversized).byteLength).toBe(100001)
    expect(() => audit(smallOversized, boundary, 'assets', 'combined-1900001')).toThrow(/CHECK/)
    const oversized = JSON.stringify({ text: 'é'.repeat(899995) })
    expect(new TextEncoder().encode(oversized).byteLength).toBe(1800001)
    expect(() => audit(null, oversized, 'assets', 'after-large')).toThrow(/CHECK/)
    expect(() => audit(oversized, '{}', 'assets', 'before-large')).toThrow(/CHECK/)
    expect(sqlite.prepare('SELECT count(*) n FROM catalog_import_job_command_audit').get()).toEqual({ n: 4 })
  })
})
