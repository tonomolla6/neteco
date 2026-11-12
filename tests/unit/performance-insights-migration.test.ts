import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN_ID, NOW, setupPerformanceInsightsDb, uuid } from './performance-insights-fixture'

const SID = '80000000-0000-4000-8000-000000000001'
let sqlite: DatabaseSync
beforeEach(async () => {
  ;({ sqlite } = await setupPerformanceInsightsDb())
})
afterEach(() => sqlite.close())

const rec = (over: Record<string, string> = {}) => {
  const v = {
    id: `'${uuid()}'`,
    key: `'${'a'.repeat(64)}'`,
    status: `'proposed'`,
    decided_by: 'NULL',
    decided_at: 'NULL',
    reason: 'NULL',
    ...over
  }
  return `INSERT INTO aiops_recommendations (id, correlation_key, signal_ids_json, services_json, summary, runbook_id, runbook_steps_json,
    destructive, confidence, status, decision_reason, decided_by, decided_at, outcome, version, created_at, updated_at)
    VALUES (${v.id}, ${v.key}, '[]', '[]', 's', 'manual_triage', '[]', 0, 0.5, ${v.status}, ${v.reason}, ${v.decided_by}, ${v.decided_at}, 'pending', 1, '${NOW}', '${NOW}')`
}

describe('migration 0128 constraints', () => {
  it('applies on top of the base schema only (no dependency on other pending migrations)', () => {
    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('aiops_signals','aiops_recommendations','third_party_scripts','third_party_experiments','b2b_catalog_cache_stats','edge_personalization_rules','edge_personalization_evidence','perf_insight_commands')"
      )
      .all()
    expect(tables).toHaveLength(8)
  })

  it('an AIOps recommendation cannot leave "proposed" without a human decision record', () => {
    expect(() => sqlite.exec(rec({ status: `'approved'` }))).toThrow(/CHECK/)
    expect(() =>
      sqlite.exec(
        rec({
          id: `'${uuid()}'`,
          key: `'${'b'.repeat(64)}'`,
          status: `'approved'`,
          decided_by: `'${ADMIN_ID}'`,
          decided_at: `'${NOW}'`,
          reason: `'Revisado y aprobado'`
        })
      )
    ).not.toThrow()
  })

  it('correlation keys are unique so a cluster cannot be proposed twice', () => {
    sqlite.exec(rec())
    expect(() => sqlite.exec(rec())).toThrow(/UNIQUE/)
  })

  it('a removed third-party script must carry reason, actor and time', () => {
    const insert = (extra: string) =>
      `INSERT INTO third_party_scripts (id, vendor, name, kind, monthly_cost_cents, load_ms_p75, status ${extra ? ', removal_reason, removed_by, removed_at' : ''}, version, created_by, created_at, updated_at)
       VALUES ('${uuid()}', 'Vendor', 'Removed script', 'pixel', 0, 0, 'removed' ${extra}, 1, '${ADMIN_ID}', '${NOW}', '${NOW}')`
    expect(() => sqlite.exec(insert(''))).toThrow(/CHECK/)
    expect(() => sqlite.exec(insert(`, 'Sin retorno medido', '${ADMIN_ID}', '${NOW}'`))).not.toThrow()
    expect(sqlite.prepare('SELECT name FROM third_party_scripts').get()).toMatchObject({ name: 'Removed script' })
  })

  it('experiment counts are bounded by visitors and timestamps are canonical', () => {
    sqlite.exec(`INSERT INTO third_party_scripts (id, vendor, name, kind, monthly_cost_cents, load_ms_p75, status, version, created_by, created_at, updated_at)
      VALUES ('${SID}', 'Vendor', 'Name1', 'pixel', 0, 0, 'active', 1, '${ADMIN_ID}', '${NOW}', '${NOW}')`)
    const exp = (conv: number, at: string) =>
      `INSERT INTO third_party_experiments VALUES ('${uuid()}', '${SID}', 7, 3000, 10, ${conv}, 0, 0, 10, 1, 0, 0, 'keep', '{}', '${ADMIN_ID}', '${at}')`
    expect(() => sqlite.exec(exp(11, NOW))).toThrow(/CHECK/)
    expect(() => sqlite.exec(exp(1, '2026-10-29 12:00'))).toThrow(/CHECK/)
    expect(() => sqlite.exec(exp(1, NOW))).not.toThrow()
  })

  it('the command audit log is append-only and bound to identities', () => {
    const insert = `INSERT INTO perf_insight_commands VALUES ('${uuid()}', 'aiops', '${ADMIN_ID}', 'x', 'k', '${'a'.repeat(64)}', '{}', '${NOW}')`
    sqlite.exec(insert)
    expect(() => sqlite.exec(`UPDATE perf_insight_commands SET action = 'y'`)).toThrow(/immutable/)
    expect(() => sqlite.exec(`DELETE FROM perf_insight_commands`)).toThrow(/immutable/)
    expect(() =>
      sqlite.exec(
        `INSERT INTO perf_insight_commands VALUES ('${uuid()}', 'aiops', '${uuid()}', 'x', 'k2', '${'a'.repeat(64)}', '{}', '${NOW}')`
      )
    ).toThrow(/FOREIGN KEY/)
    expect(() =>
      sqlite.exec(
        `INSERT INTO perf_insight_commands VALUES ('${uuid()}', 'bogus', '${ADMIN_ID}', 'x', 'k3', '${'a'.repeat(64)}', '{}', '${NOW}')`
      )
    ).toThrow(/CHECK/)
  })

  it('cache statistics only accept known scopes and non-negative counters', () => {
    expect(() => sqlite.exec(`INSERT INTO b2b_catalog_cache_stats VALUES ('2026-10-29', 'tenant', 0, 0, 0)`)).toThrow(
      /CHECK/
    )
    expect(() => sqlite.exec(`INSERT INTO b2b_catalog_cache_stats VALUES ('2026-10-29', 'b2b', -1, 0, 0)`)).toThrow(
      /CHECK/
    )
    expect(() => sqlite.exec(`INSERT INTO b2b_catalog_cache_stats VALUES ('2026-10-29', 'b2b', 1, 0, 0)`)).not.toThrow()
  })

  it('edge rules are limited to three coarse segments and well-formed identifiers', () => {
    const insert = (segment: string, slot: string) =>
      `INSERT INTO edge_personalization_rules (id, slot, segment, variant_key, status, version, created_by, created_at, updated_at)
       VALUES ('${uuid()}', '${slot}', '${segment}', 'v_one', 'draft', 1, '${ADMIN_ID}', '${NOW}', '${NOW}')`
    expect(() => sqlite.exec(insert('vip_customer', 'home'))).toThrow(/CHECK/)
    expect(() => sqlite.exec(insert('b2b', 'Home Hero'))).toThrow(/CHECK/)
    expect(() => sqlite.exec(insert('b2b', 'home_hero'))).not.toThrow()
    expect(() => sqlite.exec(insert('b2b', 'home_hero'))).toThrow(/UNIQUE/)
  })
})
