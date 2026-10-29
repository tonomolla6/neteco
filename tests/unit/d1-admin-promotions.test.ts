import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import {
  executeD1AdminPromotion,
  readD1AdminPromotion,
  readD1AdminPromotionCommand,
  listD1AdminPromotions
} from '../../workers/catalog/admin-promotions'
import { adminPromotionIntentHash } from '../../shared/admin-promotions'

const NOW = '2030-01-02T12:00:00Z'
const actor = '10000000-0000-4000-8000-000000000073'
const session = '20000000-0000-4000-8000-000000000073'
const ruleId = '30000000-0000-4000-8000-000000000073'
const key = '40000000-0000-4000-8000-000000000073'
const claims = { identityId: actor, sessionId: session, sessionVersion: 1 }
const rule = {
  id: ruleId,
  version: 1,
  code: 'SYNTHETIC',
  status: 'paused',
  channel: 'online',
  startsAt: NOW,
  endsAt: null,
  benefit: { kind: 'percent', basisPoints: 1000 },
  scope: { kind: 'all' },
  segment: 'all',
  totalLimit: 10,
  perCustomerLimit: 1,
  volumeMode: 'exclude_volume'
} as const
const create = () => ({ expectedVersion: 0, rule: { ...rule }, reason: 'Synthetic governed promotion' })
describe('governed promotion administration, no checkout/cart mutation', () => {
  let sqlite: DatabaseSync, db: D1Database
  beforeEach(async () => {
    sqlite = await openAccountSecurityDatabase()
    db = d1OverSqlite(sqlite) as unknown as D1Database
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'promotion-admin@example.invalid','synthetic','2020-01-01T00:00:00Z','active','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
      )
      .run(actor)
    sqlite.exec(
      "INSERT OR IGNORE INTO permissions VALUES ('administration.manage','administration','manage','fixture'); INSERT INTO roles VALUES ('promotion_fixture','Promotions','fixture'); INSERT INTO role_permissions VALUES ('promotion_fixture','administration.manage');"
    )
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'promotion_fixture','2020-01-01T00:00:00Z')"
      )
      .run(actor)
    sqlite
      .prepare(
        "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,'2020-01-01T00:00:00Z','2035-01-01T00:00:00Z')"
      )
      .run(session, actor)
  })
  afterEach(() => sqlite?.close())
  const options = () => ({ idempotencyKey: key, now: NOW })
  it('creates one immutable version/command/audit, exact replay and bounded private read', async () => {
    const input = create(),
      receipt = await executeD1AdminPromotion(db, claims, input, options())
    expect(receipt).toMatchObject({ source: 'cloudflare', commandId: key, ruleId, version: 1 })
    expect(await executeD1AdminPromotion(db, claims, input, options())).toEqual(receipt)
    for (const table of ['promotion_rule_versions', 'promotion_admin_commands', 'promotion_admin_audit'])
      expect(sqlite.prepare('SELECT count(*) n FROM ' + table).get()).toEqual({ n: 1 })
    expect(await readD1AdminPromotion(db, claims, ruleId, {}, { now: NOW })).toMatchObject({
      rule,
      redemptions: 0,
      historyTotal: 1
    })
    expect(await listD1AdminPromotions(db, claims, {}, { now: NOW })).toMatchObject({ total: 1, items: [{ rule }] })
    expect(
      await readD1AdminPromotionCommand(db, claims, key, await adminPromotionIntentHash(input), { now: NOW })
    ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(sqlite.prepare('SELECT count(*) n FROM promotion_redemptions').get()).toEqual({ n: 0 })
  })
  it('requires explicit next version, preserves historical rule and pauses/resumes without code changes', async () => {
    await executeD1AdminPromotion(db, claims, create(), options())
    const next = { ...create(), expectedVersion: 1, rule: { ...rule, version: 2, status: 'active' } }
    expect(
      await executeD1AdminPromotion(db, claims, next, { ...options(), idempotencyKey: crypto.randomUUID() })
    ).toMatchObject({ version: 2 })
    expect(
      (await readD1AdminPromotion(db, claims, ruleId, {}, { now: NOW })).history.map((v) => v.rule.version)
    ).toEqual([2, 1])
    await expect(
      executeD1AdminPromotion(db, claims, create(), { ...options(), idempotencyKey: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      executeD1AdminPromotion(
        db,
        claims,
        { ...next, expectedVersion: 2, rule: { ...next.rule, version: 3, code: 'CHANGED' } },
        { ...options(), idempotencyKey: crypto.randomUUID() }
      )
    ).rejects.toMatchObject({ code: 'code_immutable' })
  })
  it('rejects changed payload on replay and never treats unknown lookup as no effect', async () => {
    await executeD1AdminPromotion(db, claims, create(), options())
    await expect(
      executeD1AdminPromotion(db, claims, { ...create(), reason: 'Different governed reason' }, options())
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(
      await readD1AdminPromotionCommand(db, claims, crypto.randomUUID(), await adminPromotionIntentHash(create()), {
        now: NOW
      })
    ).toEqual({ source: 'cloudflare', outcome: 'unknown' })
  })
  it.each(['grant', 'mfa', 'email', 'session'])(
    'checks live %s even for exact replay and receipt',
    async (boundary) => {
      await executeD1AdminPromotion(db, claims, create(), options())
      if (boundary === 'grant') sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(actor)
      if (boundary === 'mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(session)
      if (boundary === 'email') sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(actor)
      if (boundary === 'session') sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, session)
      await expect(executeD1AdminPromotion(db, claims, create(), options())).rejects.toHaveProperty('code')
      await expect(
        readD1AdminPromotionCommand(db, claims, key, await adminPromotionIntentHash(create()), { now: NOW })
      ).rejects.toHaveProperty('code')
    }
  )
  it('rolls back the head/version/command when audit persistence fails', async () => {
    sqlite.exec(
      "CREATE TRIGGER synthetic_promotion_failure BEFORE INSERT ON promotion_admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END"
    )
    await expect(executeD1AdminPromotion(db, claims, create(), options())).rejects.toBeDefined()
    for (const table of [
      'promotion_rules',
      'promotion_rule_versions',
      'promotion_admin_commands',
      'promotion_admin_audit'
    ])
      expect(sqlite.prepare('SELECT count(*) n FROM ' + table).get()).toEqual({ n: 0 })
  })
  it('does not accept malformed rule/version/calendar or unsafe input as a new command', async () => {
    for (const input of [
      { ...create(), rule: { ...rule, version: 2 } },
      { ...create(), rule: { ...rule, endsAt: NOW } },
      { ...create(), rule: { ...rule, benefit: { kind: 'percent', basisPoints: 10001 } } },
      { ...create(), unexpected: true }
    ])
      await expect(executeD1AdminPromotion(db, claims, input, options())).rejects.toMatchObject({
        code: 'invalid_input'
      })
    expect(sqlite.prepare('SELECT count(*) n FROM promotion_rules').get()).toEqual({ n: 0 })
  })
})
