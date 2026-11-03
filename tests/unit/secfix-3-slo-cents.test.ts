import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { generateD1ComplianceReport } from '../../workers/observability/b2b-slo'

const now = '2026-10-29T12:00:00Z'
const actor = '10000000-0000-4000-8000-000000000001'
const customer = '50000000-0000-4000-8000-000000000001'
const contract = '40000000-0000-4000-8000-000000000001'
const claims = { identityId: actor, sessionId: '20000000-0000-4000-8000-000000000001', sessionVersion: 1 }
const input = {
  commandId: '60000000-0000-4000-8000-000000000001',
  idempotencyKey: 'slo-cents',
  contractId: contract,
  reportMonth: '2026-10'
}
let sqlite: DatabaseSync

beforeEach(async () => {
  sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile('db/d1/migrations/0116_observability_sre_capacity_slo.sql', 'utf8'))
  sqlite.exec(`
    INSERT INTO identities(id,email,password_hash,status,created_at,updated_at) VALUES('${actor}','slo@example.invalid','hash','active','${now}','${now}');
    INSERT INTO customers(id,created_at,updated_at) VALUES('${customer}','${now}','${now}');
    INSERT INTO b2b_contract_slos(id,customer_id,company_name,contract_ref,tier_code,availability_target,api_p95_latency_target_ms,support_response_target_min,dispatch_lead_target_hours,status,operational_capacity_verified,billing_period_start,billing_period_end,created_by,created_at,updated_at)
      VALUES('${contract}','${customer}','Empresa','CTR-01','premium_b2b',0.999,400,30,24,'active',1,'2026-10-01T00:00:00Z','2026-10-31T23:59:59Z','${actor}','${now}','${now}');
    INSERT INTO b2b_slo_event_records(id,contract_id,event_date,service_journey,total_transactions,successful_transactions,p95_latency_ms,downtime_minutes,support_tickets_count,support_breaches_count,fulfillment_dispatches_count,fulfillment_delays_count,created_at)
      VALUES('70000000-0000-4000-8000-000000000001','${contract}','2026-10-15','b2b_api_orders',10,9,1000,100,0,0,0,0,'${now}');
    UPDATE b2b_account_sla_tiers SET penalty_credit_percent_per_breach = 12.5 WHERE tier_code = 'premium_b2b';
  `)
})
afterEach(() => sqlite.close())

describe('SECFIX-3 B2B penalty cents', () => {
  it('returns and persists integer cents and replays the same report', async () => {
    sqlite.exec(await readFile('db/d1/migrations/0154_b2b_slo_penalty_cents.sql', 'utf8'))
    const db = d1OverSqlite(sqlite)
    const first = await generateD1ComplianceReport(db, claims, input, { now })
    expect(first).toHaveProperty('penaltyCreditCents', 18750)
    expect(first).not.toHaveProperty('penaltyCreditEur')
    expect(await generateD1ComplianceReport(db, claims, input, { now })).toEqual(first)
    expect(
      sqlite
        .prepare('SELECT penalty_credit_cents, typeof(penalty_credit_cents) AS kind FROM b2b_slo_compliance_reports')
        .get()
    ).toEqual({ penalty_credit_cents: 18750, kind: 'integer' })
  })

  it('rounds a fractional cent once using decimal arithmetic', async () => {
    sqlite.exec(await readFile('db/d1/migrations/0154_b2b_slo_penalty_cents.sql', 'utf8'))
    sqlite.exec(
      "UPDATE b2b_account_sla_tiers SET penalty_credit_percent_per_breach = 12.345 WHERE tier_code = 'premium_b2b'"
    )
    const report = await generateD1ComplianceReport(d1OverSqlite(sqlite), claims, input, { now })
    expect(report.penaltyCreditCents).toBe(18518)
  })

  it('migrates existing euro amounts to cents without losing history', async () => {
    sqlite.exec(`INSERT INTO b2b_slo_compliance_reports(id,contract_id,report_month,availability_achieved,target_availability,availability_compliant,latency_p95_achieved_ms,latency_compliant,support_compliant,fulfillment_compliant,overall_compliant,total_downtime_minutes,excluded_downtime_minutes,net_chargeable_downtime_minutes,penalty_credit_eur,alert_level,generated_at)
      VALUES('80000000-0000-4000-8000-000000000001','${contract}','2026-09',0.9,0.999,0,1000,0,1,1,0,100,0,100,187.50,'breached','${now}')`)
    const migration = await readFile('db/d1/migrations/0154_b2b_slo_penalty_cents.sql', 'utf8')
    sqlite.exec(migration)
    expect(
      sqlite
        .prepare('SELECT penalty_credit_cents, typeof(penalty_credit_cents) AS kind FROM b2b_slo_compliance_reports')
        .get()
    ).toEqual({ penalty_credit_cents: 18750, kind: 'integer' })
  })

  it('replays an immutable legacy euro receipt in cents after migration', async () => {
    const db = d1OverSqlite(sqlite)
    const old = { id: 'legacy-report', penaltyCreditEur: 187.5 }
    const hash = createHash('sha256')
      .update(JSON.stringify({ contractId: contract, month: input.reportMonth }))
      .digest('hex')
    sqlite
      .prepare(
        `INSERT INTO b2b_contract_slo_commands(command_id,actor_id,action,idempotency_key,expected_version,result_version,payload_hash,input_json,receipt_json,created_at)
      VALUES(?, ?, 'generate_compliance_report', ?, 0, 1, ?, ?, ?, ?)`
      )
      .run(input.commandId, actor, input.idempotencyKey, hash, '{}', JSON.stringify(old), now)
    sqlite.exec(await readFile('db/d1/migrations/0154_b2b_slo_penalty_cents.sql', 'utf8'))
    const replay = await generateD1ComplianceReport(db, claims, input, { now })
    expect(replay).toHaveProperty('penaltyCreditCents', 18750)
    expect(replay).not.toHaveProperty('penaltyCreditEur')
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM b2b_slo_compliance_reports').get()).toEqual({ count: 0 })
  })
})
