import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { categoryCommandFixture, categoryUtc as utc } from '../support/category-command-fixture'
import { assessPromoFraud } from '../../workers/security/promo-fraud'
import { testUuid, testNow } from '../support/deterministic'

const DAY = 86_400_000
const PEPPER = 'p'.repeat(40)

it('the scheduled worker applies the 90 day pseudonymised-signal retention and keeps open cases', async () => {
  const { sqlite, database } = await categoryCommandFixture()
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  try {
    sqlite.exec(
      await readFile(
        new URL('../../db/d1/migrations/0147_category_merchandising_promo_fraud.sql', import.meta.url),
        'utf8'
      )
    )
    const past = utc(-200 * DAY)
    for (const n of [1, 2, 3]) {
      sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(`c-${n}`, past, past)
    }
    const assess = (n: number, ref: string, at: string, signals: Record<string, string>) =>
      assessPromoFraud(
        database,
        { commandId: testUuid(), context: 'promotion', refId: ref, customerId: `c-${n}`, signals },
        { now: at, pepper: PEPPER }
      )
    await assess(1, 'old-clear', utc(-100 * DAY), { identity: 'old@example.invalid' }) // closed case, expired signal
    await assess(2, 'recent-clear', utc(-10 * DAY), { identity: 'recent@example.invalid' })
    // Two other customers share a payment token with c-3 -> review case that stays open.
    await assess(1, 'seed-x', utc(-100 * DAY), { payment: 'tok-1', device: 'dev-1' })
    await assess(2, 'seed-y', utc(-100 * DAY), { payment: 'tok-1', device: 'dev-1' })
    await assess(3, 'old-open', utc(-100 * DAY), { payment: 'tok-1', device: 'dev-1' })
    expect(sqlite.prepare("SELECT status FROM promo_fraud_cases WHERE ref_id='old-open'").get()).toEqual({
      status: 'open'
    })

    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      DB: database,
      ASYNC_JOBS: { send: async () => undefined },
      MEDIA: {},
      EMAIL: {},
      NEWSLETTER_EMAIL: {}
    } as unknown as CloudflareEnv
    // The small fixture omits unrelated scheduled subsystems; their failure is observable and isolated.
    const error = await worker
      .scheduled({ scheduledTime: testNow() } as ScheduledController, env)
      .catch((cause: unknown) => cause)
    if (error !== undefined) {
      expect(error).toBeInstanceOf(AggregateError)
      expect(String((error as Error).message)).not.toContain('security.promo-fraud-retention')
    }

    const refs = (
      sqlite
        .prepare(
          'SELECT DISTINCT c.ref_id FROM promo_fraud_signals s JOIN promo_fraud_cases c ON c.id=s.case_id ORDER BY 1'
        )
        .all() as Array<{ ref_id: string }>
    ).map((row) => row.ref_id)
    expect(refs).toEqual(['old-open', 'recent-clear'])
    // the cases themselves (audit trail) are never deleted
    expect(sqlite.prepare('SELECT count(*) AS n FROM promo_fraud_cases').get()).toEqual({ n: 5 })
  } finally {
    sqlite.close()
    log.mockRestore()
  }
})
