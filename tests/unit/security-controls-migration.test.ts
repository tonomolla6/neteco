import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'

const FILE = 'db/d1/migrations/0114_security_keys_devices_abuse.sql'
const TABLES = [
  'b2b_api_keys',
  'b2b_api_key_last_use',
  'b2b_api_key_usage',
  'b2b_api_key_commands',
  'b2b_api_key_audit',
  'warehouse_devices',
  'warehouse_device_presence',
  'warehouse_device_commands',
  'warehouse_device_audit',
  'abuse_model_versions',
  'abuse_assessments',
  'abuse_reviews',
  'abuse_baselines',
  'abuse_drift_reports',
  'abuse_audit'
]

describe('migration 0114 (SEC-038/039/040)', () => {
  it('applies through the D1 batch path used by the deploy pipeline and creates STRICT tables', async () => {
    const sqlite = await openMigratedDatabase()
    const db = d1OverSqlite(sqlite)
    const statements = splitDemoSql(await readFile(FILE, 'utf8'))
    await db.batch(statements.map((sql) => db.prepare(sql)))
    for (const table of TABLES) {
      const row = sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as
        { sql: string } | undefined
      expect(row?.sql, table).toMatch(/\) STRICT$/)
    }
  })

  it('stores no secret-bearing or personal columns', async () => {
    const source = await readFile(FILE, 'utf8')
    expect(source).not.toMatch(/^\s+(secret|password|email|phone|address|ip_address|token)\w*\s+TEXT/im)
  })

  it('seeds exactly one active abuse model', async () => {
    const sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile(FILE, 'utf8'))
    expect(sqlite.prepare(`SELECT COUNT(*) c FROM abuse_model_versions WHERE status='active'`).get()).toEqual({ c: 1 })
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO abuse_model_versions(id, version, weights_json, review_threshold, hold_threshold, status, created_at)
           VALUES ('x', 2, '{}', 10, 20, 'active', '2026-10-29T00:00:00Z')`
        )
        .run()
    ).toThrow(/UNIQUE/)
  })
})
