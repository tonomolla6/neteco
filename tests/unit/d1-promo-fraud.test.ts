import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS,
  CATEGORY_IDENTITY,
  categoryUtc as utc
} from '../support/category-command-fixture'
import {
  PromoFraudError,
  assessPromoFraud,
  decidePromoFraudCase,
  getPromoFraudBenefitGates,
  listCustomerPromoFraudCases,
  listPromoFraudCases,
  purgePromoFraudSignals,
  readPromoFraudCase,
  resolvePromoFraudAppeal,
  submitPromoFraudAppeal
} from '../../workers/security/promo-fraud'

const PEPPER = 'p'.repeat(40)
const DAY = 86_400_000
let sqlite: DatabaseSync, database: D1Database
const uuid = (n: number, group = 1) => `${group}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const customerId = (n: number) => `cust-${n}`
const claimsOf = (n: number) => ({ identityId: uuid(n, 7), sessionId: uuid(n, 8), sessionVersion: 1 })
let command = 0
const nextCommand = () => uuid(++command, 9)

function addCustomer(n: number) {
  const past = utc(-DAY)
  sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(customerId(n), past, past)
  sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?,?)"
    )
    .run(uuid(n, 7), `customer${n}@example.invalid`, past, customerId(n), past, past)
  sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
    )
    .run(uuid(n, 8), uuid(n, 7), past, utc(3_600_000))
}
function addAdmin(n: number, mfa = 1) {
  const past = utc(-DAY)
  sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?)"
    )
    .run(uuid(n, 7), `admin${n}@example.invalid`, past, past, past)
  sqlite
    .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'category_admin',?)")
    .run(uuid(n, 7), past)
  sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,?,?,?)'
    )
    .run(uuid(n, 8), uuid(n, 7), mfa, past, utc(3_600_000))
  return claimsOf(n)
}
const assess = (
  n: number,
  ref: string,
  signals: Record<string, string>,
  extra: { now?: string; commandId?: string; context?: 'referral' | 'promotion' } = {}
) =>
  assessPromoFraud(
    database,
    {
      commandId: extra.commandId ?? nextCommand(),
      context: extra.context ?? 'referral',
      refId: ref,
      customerId: customerId(n),
      signals
    },
    { now: extra.now ?? utc(), pepper: PEPPER }
  )
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof PromoFraudError ? error.code : `unexpected:${String(error)}`)
  )
const count = (table: string) => (sqlite.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n
/** A hold: two customers earlier + this one share the same device (>2 others needs 3 before) and payment (>1). */
async function seedHold() {
  for (const n of [1, 2, 3]) await assess(n, `seed-${n}`, { device: 'dev-X', payment: 'tok-X' })
  const held = await assess(4, 'held-ref', { device: 'dev-X', payment: 'tok-X' })
  return held.case
}
async function seedReview() {
  for (const n of [1, 2, 3]) await assess(n, `seed-${n}`, { device: 'dev-Y' })
  return (await assess(4, 'review-ref', { device: 'dev-Y' })).case
}

beforeEach(async () => {
  ;({ sqlite, database } = await categoryCommandFixture())
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0147_category_merchandising_promo_fraud.sql', import.meta.url),
      'utf8'
    )
  )
  for (const n of [1, 2, 3, 4, 5]) addCustomer(n)
  command = 0
})
afterEach(() => sqlite.close())

describe('SEC-036 assessPromoFraud', () => {
  it('clears unique signals, records pseudonyms only and never the raw values', async () => {
    const { case: c, replayed } = await assess(1, 'ref-1', {
      identity: 'ana@example.com',
      address: 'Calle Mayor 1',
      device: 'dev-1',
      payment: 'tok-1'
    })
    expect(replayed).toBe(false)
    expect(c).toMatchObject({ decision: 'clear', status: 'closed', score: 0, version: 1, exceededKinds: [] })
    expect(count('promo_fraud_signals')).toBe(4)
    const dump = JSON.stringify([
      sqlite.prepare('SELECT * FROM promo_fraud_signals').all(),
      sqlite.prepare('SELECT * FROM promo_fraud_cases').all(),
      sqlite.prepare('SELECT * FROM promo_fraud_events').all()
    ])
    for (const raw of ['ana@example.com', 'Calle Mayor', 'dev-1', 'tok-1']) expect(dump).not.toContain(raw)
  })
  it('does not count a customer against itself', async () => {
    await assess(1, 'a', { device: 'dev-S' })
    await assess(1, 'b', { device: 'dev-S' })
    await assess(1, 'c', { device: 'dev-S' })
    const last = await assess(1, 'd', { device: 'dev-S' })
    expect(last.case.decision).toBe('clear')
  })
  it('requests a review but never holds on a single exceeded signal', async () => {
    const c = await seedReview()
    expect(c).toMatchObject({ decision: 'review', status: 'open', exceededKinds: ['device'], score: 20 })
    const gates = await getPromoFraudBenefitGates(database, 'referral', ['review-ref'])
    expect(gates.get('review-ref')).toEqual({ blocked: false, caseId: c.id, status: 'open' })
  })
  it('holds the benefit when two independent kinds are exceeded', async () => {
    const c = await seedHold()
    expect(c).toMatchObject({ decision: 'hold', status: 'open', exceededKinds: ['device', 'payment'], score: 50 })
    const gates = await getPromoFraudBenefitGates(database, 'referral', ['held-ref'])
    expect(gates.get('held-ref')?.blocked).toBe(true)
  })
  it('tolerates sharing up to the limit', async () => {
    await assess(1, 'a', { device: 'dev-Z' })
    await assess(2, 'b', { device: 'dev-Z' })
    const third = await assess(3, 'c', { device: 'dev-Z' })
    expect(third.case.decision).toBe('clear')
  })
  it('matches cosmetic variants of identity and address', async () => {
    await assess(1, 'a', { identity: 'Ana.Perez+promo@Example.com' })
    const second = await assess(2, 'b', { identity: ' ana.perez@example.com ' })
    expect(second.case).toMatchObject({ decision: 'review', exceededKinds: ['identity'] })
  })
  it('keeps kinds separate: the same raw value as identity and device does not match', async () => {
    await assess(1, 'a', { identity: 'same-token' })
    const second = await assess(2, 'b', { device: 'same-token' })
    expect(second.case.decision).toBe('clear')
  })
  it('only counts signals inside the 30 day window', async () => {
    for (const n of [1, 2, 3]) await assess(n, `old-${n}`, { device: 'dev-W' }, { now: utc(-40 * DAY) })
    const recent = await assess(4, 'new', { device: 'dev-W' })
    expect(recent.case.decision).toBe('clear')
    for (const n of [1, 2, 3]) await assess(n, `fresh-${n}`, { device: 'dev-V' }, { now: utc(-10 * DAY) })
    expect((await assess(4, 'new2', { device: 'dev-V' })).case.decision).toBe('review')
  })
  it('replays the same command and rejects reuse with another payload', async () => {
    const commandId = nextCommand()
    const first = await assess(1, 'r1', { device: 'd' }, { commandId })
    const again = await assess(1, 'r1', { device: 'd' }, { commandId })
    expect(again.replayed).toBe(true)
    expect(again.case.id).toBe(first.case.id)
    expect(count('promo_fraud_cases')).toBe(1)
    expect(await code(assess(1, 'r1', { device: 'other' }, { commandId }))).toBe('idempotency_conflict')
    expect(await code(assess(2, 'r1', { device: 'd' }, { commandId }))).toBe('idempotency_conflict')
  })
  it('refuses a second assessment of the same reference with a new command', async () => {
    await assess(1, 'dup', { device: 'd' })
    expect(await code(assess(1, 'dup', { device: 'd2' }))).toBe('already_assessed')
    expect(count('promo_fraud_cases')).toBe(1)
  })
  it('can assess the same reference in a different context', async () => {
    await assess(1, 'dup', { device: 'd' }, { context: 'referral' })
    expect(await code(assess(1, 'dup', { device: 'd' }, { context: 'promotion' }))).toBe('ok')
  })
  it('validates input and refuses a weak or missing pepper', async () => {
    expect(await code(assessPromoFraud(database, { commandId: 'x' }, { now: utc(), pepper: PEPPER }))).toBe(
      'invalid_input'
    )
    expect(
      await code(
        assessPromoFraud(
          database,
          {
            commandId: nextCommand(),
            context: 'referral',
            refId: 'r',
            customerId: 'cust-1',
            signals: {},
            decision: 'clear'
          },
          { now: utc(), pepper: PEPPER }
        )
      )
    ).toBe('invalid_input')
    expect(
      await code(
        assessPromoFraud(
          database,
          { commandId: nextCommand(), context: 'referral', refId: 'r', customerId: 'cust-1', signals: { device: 'd' } },
          { now: utc(), pepper: 'short' }
        )
      )
    ).toBe('security_configuration_missing')
    expect(
      await code(
        assessPromoFraud(
          database,
          { commandId: nextCommand(), context: 'referral', refId: 'r', customerId: 'cust-1', signals: { device: 'd' } },
          { now: 'yesterday', pepper: PEPPER }
        )
      )
    ).toBe('invalid_input')
  })
  it('reports an unknown customer without leaving partial rows', async () => {
    const result = await code(
      assessPromoFraud(
        database,
        { commandId: nextCommand(), context: 'referral', refId: 'r', customerId: 'ghost', signals: { device: 'd' } },
        { now: utc(), pepper: PEPPER }
      )
    )
    expect(result).toBe('customer_not_found')
    expect(count('promo_fraud_cases') + count('promo_fraud_signals') + count('promo_fraud_events')).toBe(0)
  })
  it('is atomic: a failing audit insert rolls back the case and its signals', async () => {
    sqlite.exec("CREATE TRIGGER boom BEFORE INSERT ON promo_fraud_events BEGIN SELECT RAISE(ABORT,'boom'); END")
    await expect(assess(1, 'x', { device: 'd', payment: 'p' })).rejects.toBeDefined()
    expect(count('promo_fraud_cases') + count('promo_fraud_signals')).toBe(0)
  })
  it('uses a fixed number of statements however many signals are assessed', async () => {
    let statements = 0
    const counting = new Proxy(database, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (property === 'prepare')
          return (sql: string) => {
            statements++
            return (value as (s: string) => unknown).call(target, sql)
          }
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await assessPromoFraud(
      counting,
      {
        commandId: nextCommand(),
        context: 'referral',
        refId: 'n1',
        customerId: 'cust-1',
        signals: { identity: 'a', address: 'b', device: 'c', payment: 'd' }
      },
      { now: utc(), pepper: PEPPER }
    )
    expect(statements).toBeLessThanOrEqual(6)
  })
  it('uses the pepper as a key: another pepper does not link to earlier signals', async () => {
    for (const n of [1, 2, 3]) await assess(n, `seed-${n}`, { device: 'dev-P' })
    const other = await assessPromoFraud(
      database,
      {
        commandId: nextCommand(),
        context: 'referral',
        refId: 'otherpepper',
        customerId: 'cust-4',
        signals: { device: 'dev-P' }
      },
      { now: utc(), pepper: 'q'.repeat(40) }
    )
    expect(other.case.decision).toBe('clear')
  })
})

describe('SEC-036 review queue and decisions', () => {
  it('lists the pending queue for administrators only', async () => {
    await seedHold()
    const queue = await listPromoFraudCases(database, CATEGORY_CLAIMS, { filter: 'pending' }, { now: utc() })
    expect(queue.map((c) => c.refId)).toEqual(['seed-3', 'held-ref'])
    expect(await code(listPromoFraudCases(database, claimsOf(1), {}, { now: utc() }))).toBe('forbidden')
    expect(
      await code(listPromoFraudCases(database, { ...CATEGORY_CLAIMS, sessionVersion: 9 }, {}, { now: utc() }))
    ).toBe('unauthenticated')
    const weak = addAdmin(20, 0)
    expect(await code(listPromoFraudCases(database, weak, {}, { now: utc() }))).toBe('mfa_required')
  })
  it('pending excludes closed and decided cases, all includes them', async () => {
    const c = await seedReview()
    await assess(5, 'clean', { device: 'zzz' })
    expect(
      (await listPromoFraudCases(database, CATEGORY_CLAIMS, { filter: 'pending' }, { now: utc() })).map((x) => x.id)
    ).toEqual([c.id])
    expect(
      (await listPromoFraudCases(database, CATEGORY_CLAIMS, { filter: 'all' }, { now: utc() })).length
    ).toBeGreaterThan(1)
    await decidePromoFraudCase(
      database,
      CATEGORY_CLAIMS,
      c.id,
      { expectedVersion: 1, outcome: 'release', note: 'Hermanos en casa' },
      { now: utc() }
    )
    expect(await listPromoFraudCases(database, CATEGORY_CLAIMS, { filter: 'pending' }, { now: utc() })).toEqual([])
  })
  it('reads a case with its audit trail', async () => {
    const c = await seedHold()
    const detail = await readPromoFraudCase(database, CATEGORY_CLAIMS, c.id, { now: utc() })
    expect(detail.case.id).toBe(c.id)
    expect(detail.events.map((e) => e.action)).toEqual(['assessed'])
    expect(detail.appeal).toBeNull()
    expect(await code(readPromoFraudCase(database, CATEGORY_CLAIMS, uuid(77), { now: utc() }))).toBe('not_found')
  })
  it('releases a case: versioned, audited and attributable', async () => {
    const c = await seedHold()
    const decided = await decidePromoFraudCase(
      database,
      CATEGORY_CLAIMS,
      c.id,
      { expectedVersion: 1, outcome: 'release', note: 'Verificado: misma familia' },
      { now: utc() }
    )
    expect(decided).toMatchObject({ status: 'released', version: 2, decidedBy: CATEGORY_IDENTITY })
    const gate = await getPromoFraudBenefitGates(database, 'referral', ['held-ref'])
    expect(gate.get('held-ref')?.blocked).toBe(false)
    const detail = await readPromoFraudCase(database, CATEGORY_CLAIMS, c.id, { now: utc() })
    expect(detail.events.map((e) => e.action)).toEqual(['assessed', 'released'])
  })
  it('upholds a case and keeps the benefit blocked, even a review-only one', async () => {
    const c = await seedReview()
    await decidePromoFraudCase(
      database,
      CATEGORY_CLAIMS,
      c.id,
      { expectedVersion: 1, outcome: 'uphold', note: 'Abuso confirmado' },
      { now: utc() }
    )
    expect((await getPromoFraudBenefitGates(database, 'referral', ['review-ref'])).get('review-ref')?.blocked).toBe(
      true
    )
  })
  it('uses compare-and-set and answers a repeat of the same decision idempotently', async () => {
    const c = await seedHold()
    const input = { expectedVersion: 1, outcome: 'release' as const, note: 'Verificado: misma familia' }
    const first = await decidePromoFraudCase(database, CATEGORY_CLAIMS, c.id, input, { now: utc() })
    expect(await decidePromoFraudCase(database, CATEGORY_CLAIMS, c.id, input, { now: utc() })).toEqual(first)
    expect(count('promo_fraud_events')).toBe(count('promo_fraud_cases') + 1)
    expect(
      await code(decidePromoFraudCase(database, CATEGORY_CLAIMS, c.id, { ...input, outcome: 'uphold' }, { now: utc() }))
    ).toBe('invalid_transition')
    const stale = await seedReviewFresh()
    expect(
      await code(
        decidePromoFraudCase(database, CATEGORY_CLAIMS, stale.id, { ...input, expectedVersion: 5 }, { now: utc() })
      )
    ).toBe('version_conflict')
  })
  async function seedReviewFresh() {
    for (const n of [1, 2, 3]) await assess(n, `fresh-${n}`, { device: 'dev-F' })
    return (await assess(4, 'fresh-ref', { device: 'dev-F' })).case
  }
  it('refuses to decide a closed case or an unknown one', async () => {
    const { case: clear } = await assess(1, 'clean', { device: 'solo' })
    expect(
      await code(
        decidePromoFraudCase(
          database,
          CATEGORY_CLAIMS,
          clear.id,
          { expectedVersion: 1, outcome: 'release', note: 'no aplica' },
          { now: utc() }
        )
      )
    ).toBe('invalid_transition')
    expect(
      await code(
        decidePromoFraudCase(
          database,
          CATEGORY_CLAIMS,
          uuid(55),
          { expectedVersion: 1, outcome: 'release', note: 'no aplica' },
          { now: utc() }
        )
      )
    ).toBe('not_found')
  })
  it('lets only one of two concurrent decisions win', async () => {
    const c = await seedHold()
    const other = addAdmin(21)
    const results = await Promise.all([
      code(
        decidePromoFraudCase(
          database,
          CATEGORY_CLAIMS,
          c.id,
          { expectedVersion: 1, outcome: 'release', note: 'Revisión A' },
          { now: utc() }
        )
      ),
      code(
        decidePromoFraudCase(
          database,
          other,
          c.id,
          { expectedVersion: 1, outcome: 'uphold', note: 'Revisión B' },
          { now: utc() }
        )
      )
    ])
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
    expect(results.filter((r) => r === 'version_conflict' || r === 'invalid_transition')).toHaveLength(1)
    expect(count('promo_fraud_events')).toBe(count('promo_fraud_cases') + 1)
  })
  it('does not let an administrator review a case about their own customer account', async () => {
    const now = utc(-DAY)
    sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run('cust-6', now, now)
    for (const n of [1, 2, 3]) await assess(n, `seed-${n}`, { device: 'dev-X', payment: 'tok-X' })
    const held = await assessPromoFraud(
      database,
      {
        commandId: nextCommand(),
        context: 'referral',
        refId: 'own-ref',
        customerId: 'cust-6',
        signals: { device: 'dev-X', payment: 'tok-X' }
      },
      { now: utc(), pepper: PEPPER }
    )
    sqlite.prepare("UPDATE identities SET customer_id='cust-6' WHERE id=?").run(CATEGORY_IDENTITY)
    expect(held.case.decision).toBe('hold')
    expect(
      await code(
        decidePromoFraudCase(
          database,
          CATEGORY_CLAIMS,
          held.case.id,
          { expectedVersion: 1, outcome: 'release', note: 'Es mi cuenta' },
          { now: utc() }
        )
      )
    ).toBe('self_review')
    expect(sqlite.prepare('SELECT status FROM promo_fraud_cases WHERE id=?').get(held.case.id)).toMatchObject({
      status: 'open'
    })
  })
  it('rejects customers, non-MFA sessions and invalid bodies', async () => {
    const c = await seedHold()
    const input = { expectedVersion: 1, outcome: 'release' as const, note: 'Verificado' }
    expect(await code(decidePromoFraudCase(database, claimsOf(1), c.id, input, { now: utc() }))).toBe('forbidden')
    expect(await code(decidePromoFraudCase(database, addAdmin(22, 0), c.id, input, { now: utc() }))).toBe(
      'mfa_required'
    )
    expect(
      await code(decidePromoFraudCase(database, CATEGORY_CLAIMS, c.id, { ...input, extra: 1 }, { now: utc() }))
    ).toBe('invalid_input')
    expect(await code(decidePromoFraudCase(database, CATEGORY_CLAIMS, 'not-a-uuid', input, { now: utc() }))).toBe(
      'invalid_input'
    )
  })
  it('re-checks authority at write time: a role revoked mid-flight changes nothing', async () => {
    const c = await seedHold()
    const racing = new Proxy(database, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (property === 'batch')
          return (statements: unknown[]) => {
            sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CATEGORY_IDENTITY)
            return (value as (s: unknown[]) => unknown).call(target, statements)
          }
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    expect(
      await code(
        decidePromoFraudCase(
          racing,
          CATEGORY_CLAIMS,
          c.id,
          { expectedVersion: 1, outcome: 'release', note: 'Verificado' },
          { now: utc() }
        )
      )
    ).toBe('forbidden')
    expect(sqlite.prepare('SELECT status,version FROM promo_fraud_cases WHERE id=?').get(c.id)).toMatchObject({
      status: 'open',
      version: 1
    })
  })
})

describe('SEC-036 customer appeal', () => {
  it('lists only the caller own cases without scores or signal details', async () => {
    const c = await seedHold()
    const mine = await listCustomerPromoFraudCases(database, claimsOf(4), { now: utc() })
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ id: c.id, canAppeal: true, appealStatus: null, version: 1 })
    expect(Object.keys(mine[0]!)).not.toEqual(expect.arrayContaining(['score']))
    expect(JSON.stringify(mine)).not.toMatch(/score|exceeded|device|payment|customerId/)
    expect(await listCustomerPromoFraudCases(database, claimsOf(5), { now: utc() })).toEqual([])
    expect(
      await code(listCustomerPromoFraudCases(database, { ...claimsOf(4), sessionVersion: 3 }, { now: utc() }))
    ).toBe('unauthenticated')
  })
  it('lets the customer appeal a held case once; the benefit stays blocked meanwhile', async () => {
    const c = await seedHold()
    const appealed = await submitPromoFraudAppeal(
      database,
      claimsOf(4),
      c.id,
      { caseVersion: 1, statement: 'Somos hermanos y compartimos equipo y tarjeta.' },
      { now: utc() }
    )
    expect(appealed).toMatchObject({ status: 'appealed', version: 2, appealStatus: 'pending' })
    expect((await getPromoFraudBenefitGates(database, 'referral', ['held-ref'])).get('held-ref')?.blocked).toBe(true)
    expect(
      await code(
        submitPromoFraudAppeal(
          database,
          claimsOf(4),
          c.id,
          { caseVersion: 2, statement: 'Segunda apelación de prueba.' },
          { now: utc() }
        )
      )
    ).toBe('appeal_not_allowed')
    expect(count('promo_fraud_appeals')).toBe(1)
    const detail = await readPromoFraudCase(database, CATEGORY_CLAIMS, c.id, { now: utc() })
    expect(detail.events.map((e) => e.action)).toEqual(['assessed', 'appeal_submitted'])
    expect(detail.appeal).toMatchObject({ status: 'pending' })
  })
  it('does not offer an appeal for a review-only case, but does after it is upheld', async () => {
    const c = await seedReview()
    const statement = 'No he cometido ningún abuso, compartimos oficina.'
    expect(
      await code(submitPromoFraudAppeal(database, claimsOf(4), c.id, { caseVersion: 1, statement }, { now: utc() }))
    ).toBe('appeal_not_allowed')
    await decidePromoFraudCase(
      database,
      CATEGORY_CLAIMS,
      c.id,
      { expectedVersion: 1, outcome: 'uphold', note: 'Abuso confirmado' },
      { now: utc() }
    )
    const appealed = await submitPromoFraudAppeal(
      database,
      claimsOf(4),
      c.id,
      { caseVersion: 2, statement },
      { now: utc() }
    )
    expect(appealed.status).toBe('appealed')
  })
  it('hides other customers cases and enforces the version', async () => {
    const c = await seedHold()
    const statement = 'Esta apelación es de otra persona distinta.'
    expect(
      await code(submitPromoFraudAppeal(database, claimsOf(5), c.id, { caseVersion: 1, statement }, { now: utc() }))
    ).toBe('not_found')
    expect(
      await code(submitPromoFraudAppeal(database, claimsOf(4), c.id, { caseVersion: 7, statement }, { now: utc() }))
    ).toBe('version_conflict')
    expect(
      await code(
        submitPromoFraudAppeal(database, claimsOf(4), c.id, { caseVersion: 1, statement: 'corto' }, { now: utc() })
      )
    ).toBe('invalid_input')
    expect(
      await code(
        submitPromoFraudAppeal(
          database,
          claimsOf(4),
          c.id,
          { caseVersion: 1, statement, customerId: 'cust-5' },
          { now: utc() }
        )
      )
    ).toBe('invalid_input')
    expect(count('promo_fraud_appeals')).toBe(0)
  })
  it('requires a live customer session', async () => {
    const c = await seedHold()
    sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(-1000), uuid(4, 8))
    expect(
      await code(
        submitPromoFraudAppeal(
          database,
          claimsOf(4),
          c.id,
          { caseVersion: 1, statement: 'Somos hermanos y compartimos todo.' },
          { now: utc() }
        )
      )
    ).toBe('unauthenticated')
  })
  it('is atomic: a failing audit insert leaves no appeal and the case untouched', async () => {
    const c = await seedHold()
    sqlite.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON promo_fraud_events WHEN NEW.action='appeal_submitted' BEGIN SELECT RAISE(ABORT,'boom'); END"
    )
    await expect(
      submitPromoFraudAppeal(
        database,
        claimsOf(4),
        c.id,
        { caseVersion: 1, statement: 'Somos hermanos y compartimos todo.' },
        { now: utc() }
      )
    ).rejects.toBeDefined()
    expect(count('promo_fraud_appeals')).toBe(0)
    expect(sqlite.prepare('SELECT status,version FROM promo_fraud_cases WHERE id=?').get(c.id)).toMatchObject({
      status: 'open',
      version: 1
    })
  })
})

describe('SEC-036 appeal resolution', () => {
  async function appealed() {
    const c = await seedHold()
    await submitPromoFraudAppeal(
      database,
      claimsOf(4),
      c.id,
      { caseVersion: 1, statement: 'Somos hermanos y compartimos todo.' },
      { now: utc() }
    )
    return c
  }
  it('accepts an appeal: the benefit is released', async () => {
    const c = await appealed()
    const resolved = await resolvePromoFraudAppeal(
      database,
      CATEGORY_CLAIMS,
      c.id,
      { expectedVersion: 2, outcome: 'accept', note: 'Documentación suficiente' },
      { now: utc() }
    )
    expect(resolved).toMatchObject({ status: 'appeal_accepted', version: 3, appealStatus: 'accepted' })
    expect((await getPromoFraudBenefitGates(database, 'referral', ['held-ref'])).get('held-ref')?.blocked).toBe(false)
    const detail = await readPromoFraudCase(database, CATEGORY_CLAIMS, c.id, { now: utc() })
    expect(detail.events.map((e) => e.action)).toEqual(['assessed', 'appeal_submitted', 'appeal_accepted'])
  })
  it('rejects an appeal: final, the benefit stays blocked and no new appeal is possible', async () => {
    const c = await appealed()
    const resolved = await resolvePromoFraudAppeal(
      database,
      CATEGORY_CLAIMS,
      c.id,
      { expectedVersion: 2, outcome: 'reject', note: 'Sin pruebas aportadas' },
      { now: utc() }
    )
    expect(resolved.status).toBe('appeal_rejected')
    expect((await getPromoFraudBenefitGates(database, 'referral', ['held-ref'])).get('held-ref')?.blocked).toBe(true)
    expect(
      await code(
        submitPromoFraudAppeal(
          database,
          claimsOf(4),
          c.id,
          { caseVersion: 3, statement: 'Intento otra apelación distinta.' },
          { now: utc() }
        )
      )
    ).toBe('appeal_not_allowed')
  })
  it('requires a second reviewer: whoever decided the case cannot resolve its appeal', async () => {
    const c = await seedReview()
    await decidePromoFraudCase(
      database,
      CATEGORY_CLAIMS,
      c.id,
      { expectedVersion: 1, outcome: 'uphold', note: 'Abuso confirmado' },
      { now: utc() }
    )
    await submitPromoFraudAppeal(
      database,
      claimsOf(4),
      c.id,
      { caseVersion: 2, statement: 'Compartimos oficina, no hay abuso.' },
      { now: utc() }
    )
    const input = { expectedVersion: 3, outcome: 'accept' as const, note: 'Revisado de nuevo' }
    expect(await code(resolvePromoFraudAppeal(database, CATEGORY_CLAIMS, c.id, input, { now: utc() }))).toBe(
      'same_reviewer'
    )
    const second = addAdmin(23)
    expect((await resolvePromoFraudAppeal(database, second, c.id, input, { now: utc() })).status).toBe(
      'appeal_accepted'
    )
  })
  it('checks permission, version and state', async () => {
    const c = await appealed()
    const input = { expectedVersion: 2, outcome: 'accept' as const, note: 'Documentación suficiente' }
    expect(await code(resolvePromoFraudAppeal(database, claimsOf(4), c.id, input, { now: utc() }))).toBe('forbidden')
    expect(
      await code(
        resolvePromoFraudAppeal(database, CATEGORY_CLAIMS, c.id, { ...input, expectedVersion: 9 }, { now: utc() })
      )
    ).toBe('version_conflict')
    await resolvePromoFraudAppeal(database, CATEGORY_CLAIMS, c.id, input, { now: utc() })
    expect(
      await code(
        resolvePromoFraudAppeal(database, CATEGORY_CLAIMS, c.id, { ...input, expectedVersion: 3 }, { now: utc() })
      )
    ).toBe('invalid_transition')
    const open = await seedReviewFresh2()
    expect(
      await code(
        resolvePromoFraudAppeal(database, CATEGORY_CLAIMS, open.id, { ...input, expectedVersion: 1 }, { now: utc() })
      )
    ).toBe('invalid_transition')
  })
  async function seedReviewFresh2() {
    for (const n of [1, 2, 3]) await assess(n, `f2-${n}`, { device: 'dev-F2' })
    return (await assess(5, 'f2-ref', { device: 'dev-F2' })).case
  }
  it('is atomic: a failing audit insert leaves the appeal pending', async () => {
    const c = await appealed()
    sqlite.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON promo_fraud_events WHEN NEW.action='appeal_accepted' BEGIN SELECT RAISE(ABORT,'boom'); END"
    )
    await expect(
      resolvePromoFraudAppeal(
        database,
        CATEGORY_CLAIMS,
        c.id,
        { expectedVersion: 2, outcome: 'accept', note: 'Documentación suficiente' },
        { now: utc() }
      )
    ).rejects.toBeDefined()
    expect(sqlite.prepare('SELECT status FROM promo_fraud_appeals WHERE case_id=?').get(c.id)).toMatchObject({
      status: 'pending'
    })
    expect(sqlite.prepare('SELECT status FROM promo_fraud_cases WHERE id=?').get(c.id)).toMatchObject({
      status: 'appealed'
    })
  })
})

describe('SEC-036 database guards and retention', () => {
  it('forbids skipping the state machine, deleting cases and editing the audit trail', async () => {
    const c = await seedHold()
    expect(() =>
      sqlite.prepare("UPDATE promo_fraud_cases SET status='appeal_accepted',version=2 WHERE id=?").run(c.id)
    ).toThrow(/transition_invalid/)
    expect(() =>
      sqlite.prepare("UPDATE promo_fraud_cases SET score=0,status='released',version=2 WHERE id=?").run(c.id)
    ).toThrow(/transition_invalid/)
    expect(() => sqlite.prepare('DELETE FROM promo_fraud_cases WHERE id=?').run(c.id)).toThrow(/no_delete/)
    expect(() => sqlite.prepare("UPDATE promo_fraud_events SET action='released'").run()).toThrow(/append_only/)
    expect(() => sqlite.prepare('DELETE FROM promo_fraud_events').run()).toThrow(/append_only/)
  })
  it('refuses an appeal row for a customer that does not own the case', async () => {
    const c = await seedHold()
    expect(() =>
      sqlite
        .prepare(
          "INSERT INTO promo_fraud_appeals(id,case_id,customer_id,statement,status,created_at) VALUES(?,?,?,?, 'pending',?)"
        )
        .run(uuid(90), c.id, customerId(5), 'Intento de apelación ajena', utc())
    ).toThrow(/appeal_not_allowed/)
  })
  it('rejects a hold with a single exceeded kind at the schema level', () => {
    const insert = () =>
      sqlite
        .prepare(
          "INSERT INTO promo_fraud_cases(id,command_id,payload_hash,context,ref_id,customer_id,decision,score,exceeded_kinds,shared_counts,status,version,created_at,updated_at) VALUES(?,?,?,'referral','x','cust-1','hold',20,'[\"device\"]','{}','open',1,?,?)"
        )
        .run(uuid(91), uuid(92), 'a'.repeat(64), utc(), utc())
    expect(insert).toThrow()
  })
  it('batches the benefit gate and defaults unknown references to not blocked', async () => {
    await seedHold()
    const gates = await getPromoFraudBenefitGates(database, 'referral', ['held-ref', 'unknown'])
    expect(gates.get('held-ref')?.blocked).toBe(true)
    expect(gates.get('unknown')).toEqual({ blocked: false, caseId: null, status: null })
    expect(await getPromoFraudBenefitGates(database, 'referral', [])).toEqual(new Map())
    expect(
      await code(
        getPromoFraudBenefitGates(
          database,
          'referral',
          Array.from({ length: 101 }, (_, i) => `r${i}`)
        )
      )
    ).toBe('invalid_input')
  })
  it('purges only signals older than the retention period and keeps cases and events', async () => {
    await assess(1, 'old', { device: 'a' }, { now: utc(-100 * DAY) })
    await assess(2, 'new', { device: 'b' })
    const result = await purgePromoFraudSignals(database, { now: utc() })
    expect(result).toEqual({ deleted: 1 })
    expect(count('promo_fraud_signals')).toBe(1)
    expect(count('promo_fraud_cases')).toBe(2)
  })
})
