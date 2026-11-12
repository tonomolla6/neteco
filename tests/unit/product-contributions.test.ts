import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { productContributionIntentHash, productContributionSubmitInputSchema } from '../../shared/product-contributions'
import {
  submitD1ProductContribution,
  replyD1ProductContribution,
  moderateD1ProductContribution,
  readD1ProductContribution,
  readD1ProductContributions,
  readD1ProductContributionCommand,
  readD1PublicProductContributions
} from '../../workers/support/product-contributions'
import { testUuid } from '../support/deterministic'

describe('MKT024/025 authoritative moderated product contributions', () => {
  let f: Awaited<ReturnType<typeof returnsFixture>>
  let productId: number
  const options = () => ({ now: utc() })
  const command = () => ({ ...options(), idempotencyKey: testUuid() })
  const review = (orderId?: string) => ({
    kind: 'review' as const,
    productId,
    score: 4,
    title: 'Uso sintético contrastado',
    body: 'Texto público sintético revisable sin datos personales.',
    privacyAcknowledged: true as const,
    ...(orderId ? { orderId } : {})
  })
  const question = () => ({
    kind: 'question' as const,
    productId,
    title: 'Consulta sintética de producto',
    body: '¿Dónde se encuentra la documentación aprobada de este producto?',
    privacyAcknowledged: true as const
  })
  const moderation = (version: number, action: 'publish' | 'withdraw' = 'publish') => ({
    expectedVersion: version,
    action,
    reason: 'Revisión sintética documentada y explícita',
    ...(action === 'publish' ? { reviewReference: 'synthetic-reviewed-content', slaDueAt: null } : {})
  })
  const economic = () =>
    ['orders', 'order_lines', 'payment_intents', 'inventory_balances', 'inventory_movements'].map((table) =>
      f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    )
  beforeEach(async () => {
    f = await returnsFixture()
    f.sqlite
      .prepare("INSERT INTO permissions VALUES('support.manage','support','manage','Synthetic moderation permission')")
      .run()
    f.sqlite.prepare("INSERT INTO role_permissions VALUES('operator','support.manage')").run()
    f.sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES(?,'synthetic-unused-secret',?,?)"
      )
      .run(CLAIMS.identityId, utc(-60000), utc(-60000))
    productId = (f.sqlite.prepare("SELECT legacy_id FROM products WHERE id='p-1'").get() as { legacy_id: number })
      .legacy_id
    const migration = new URL('../../db/d1/migrations/0088_product_contributions.sql', import.meta.url)
    f.sqlite.exec(await readFile(migration, 'utf8'))
  })
  afterEach(() => f.sqlite.close())
  it('keeps a genuine own delivered-order review private until explicit moderation and withdraws it immediately', async () => {
    const orderId = await f.order()
    const before = economic()
    const submitted = await submitD1ProductContribution(f.database, BUYER_CLAIMS, review(orderId), command())
    expect(submitted).toMatchObject({
      action: 'submit',
      expectedVersion: 0,
      version: 1,
      economicEffect: 'none',
      inventoryEffect: 'none',
      senderInvoked: false
    })
    expect((await readD1PublicProductContributions(f.database, productId, {}, options())).items).toEqual([])
    await moderateD1ProductContribution(f.database, CLAIMS, submitted.contributionId, moderation(1), command())
    const published = await readD1PublicProductContributions(f.database, productId, {}, options())
    expect(published.items).toHaveLength(1)
    expect(published.items[0]).toMatchObject({ origin: 'verified_purchase', score: 4, body: review().body })
    const publicJson = JSON.stringify(published)
    for (const secret of [
      BUYER_CLAIMS.identityId,
      BUYER_CLAIMS.sessionId,
      orderId,
      'buyer@example.invalid',
      'customerId',
      'orderId',
      'reason',
      'reviewReference'
    ])
      expect(publicJson).not.toContain(secret)
    await moderateD1ProductContribution(
      f.database,
      CLAIMS,
      submitted.contributionId,
      moderation(2, 'withdraw'),
      command()
    )
    expect((await readD1PublicProductContributions(f.database, productId, {}, options())).items).toEqual([])
    expect(economic()).toEqual(before)
  })
  it('never awards verified purchase using a foreign order or a client supplied badge', async () => {
    const foreignOrder = await f.order({ owned: false })
    await expect(
      submitD1ProductContribution(f.database, BUYER_CLAIMS, review(foreignOrder), command())
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(productContributionSubmitInputSchema.safeParse({ ...review(), origin: 'verified_purchase' }).success).toBe(
      false
    )
  })
  it('labels a review with no purchase proof explicitly unverified and never treats paid-only as delivered', async () => {
    const submitted = await submitD1ProductContribution(f.database, BUYER_CLAIMS, review(), command())
    expect(
      await readD1ProductContribution(f.database, BUYER_CLAIMS, 'customer', submitted.contributionId, options())
    ).toMatchObject({ origin: 'unverified', state: 'pending' })
    const paid = await f.order({ delivered: false })
    await expect(submitD1ProductContribution(f.database, BUYER_CLAIMS, review(paid), command())).rejects.toMatchObject({
      code: 'not_found'
    })
  })
  it('preserves exact actor-bound replay and recovery without a second submission', async () => {
    const body = question(),
      opts = command()
    const receipt = await submitD1ProductContribution(f.database, BUYER_CLAIMS, body, opts)
    expect(await submitD1ProductContribution(f.database, BUYER_CLAIMS, body, opts)).toEqual(receipt)
    const payloadHash = await productContributionIntentHash('submit', null, body)
    expect(receipt.payloadHash).toBe(payloadHash)
    expect(
      await readD1ProductContributionCommand(
        f.database,
        BUYER_CLAIMS,
        'customer',
        opts.idempotencyKey,
        payloadHash,
        options()
      )
    ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(
      await readD1ProductContributionCommand(f.database, CLAIMS, 'admin', opts.idempotencyKey, payloadHash, options())
    ).toEqual({ source: 'cloudflare', outcome: 'unknown', receipt: null })
    await expect(
      submitD1ProductContribution(f.database, BUYER_CLAIMS, { ...body, title: 'Otra consulta sintética' }, opts)
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(f.sqlite.prepare('SELECT count(*) n FROM product_contribution_commands').get()).toEqual({ n: 1 })
  })
  it('publishes expert answers while author replies return to moderation without replacing the expert answer', async () => {
    const created = await submitD1ProductContribution(f.database, BUYER_CLAIMS, question(), command())
    const answer = 'Consulte únicamente la ficha técnica aprobada disponible en esta página.'
    await moderateD1ProductContribution(
      f.database,
      CLAIMS,
      created.contributionId,
      {
        action: 'answer',
        expectedVersion: 1,
        reason: 'Respuesta experta revisada para este producto',
        reviewReference: 'synthetic-expert-review',
        body: answer
      },
      command()
    )
    expect((await readD1PublicProductContributions(f.database, productId, {}, options())).items[0]).toMatchObject({
      questionStatus: 'answered',
      answer
    })
    await replyD1ProductContribution(
      f.database,
      BUYER_CLAIMS,
      created.contributionId,
      { expectedVersion: 2, body: 'Gracias, preciso una aclaración adicional sintética.' },
      command()
    )
    expect((await readD1PublicProductContributions(f.database, productId, {}, options())).items).toEqual([])
    expect(
      await readD1ProductContribution(f.database, BUYER_CLAIMS, 'customer', created.contributionId, options())
    ).toMatchObject({ state: 'pending', answer })
    await moderateD1ProductContribution(f.database, CLAIMS, created.contributionId, moderation(3), command())
    expect((await readD1PublicProductContributions(f.database, productId, {}, options())).items[0]?.reply).toContain(
      'aclaración adicional'
    )
  })
  it('supports a real moderation queue, an explicit optional SLA and audited question closure', async () => {
    const created = await submitD1ProductContribution(f.database, BUYER_CLAIMS, question(), command())
    expect(
      await readD1ProductContributions(f.database, CLAIMS, 'admin', { state: 'pending', kind: 'question' }, options())
    ).toMatchObject({ total: 1, page: 1, perPage: 25 })
    const due = utc(3600000)
    await moderateD1ProductContribution(
      f.database,
      CLAIMS,
      created.contributionId,
      { ...moderation(1), slaDueAt: due },
      command()
    )
    expect(
      await readD1ProductContribution(f.database, BUYER_CLAIMS, 'customer', created.contributionId, options())
    ).toMatchObject({ slaDueAt: due, questionStatus: 'open' })
    await moderateD1ProductContribution(
      f.database,
      CLAIMS,
      created.contributionId,
      { action: 'close', expectedVersion: 2, reason: 'Consulta sintética finalizada tras revisión' },
      command()
    )
    expect(
      (await readD1ProductContribution(f.database, CLAIMS, 'admin', created.contributionId, options())).history.map(
        (item) => item.action
      )
    ).toEqual(['submit', 'publish', 'close'])
  })
  it('requires live moderation permission and actual MFA enrollment, including command replay', async () => {
    const created = await submitD1ProductContribution(f.database, BUYER_CLAIMS, review(), command()),
      opts = command()
    const input = moderation(1)
    await moderateD1ProductContribution(f.database, CLAIMS, created.contributionId, input, opts)
    f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(CLAIMS.identityId)
    await expect(
      moderateD1ProductContribution(f.database, CLAIMS, created.contributionId, input, opts)
    ).rejects.toMatchObject({ code: 'mfa_required' })
  })
  it('rejects stale CAS without losing a published revision or writing a receipt', async () => {
    const created = await submitD1ProductContribution(f.database, BUYER_CLAIMS, review(), command())
    await moderateD1ProductContribution(f.database, CLAIMS, created.contributionId, moderation(1), command())
    await expect(
      moderateD1ProductContribution(f.database, CLAIMS, created.contributionId, moderation(1, 'withdraw'), command())
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect(f.sqlite.prepare('SELECT count(*) n FROM product_contribution_commands').get()).toEqual({ n: 2 })
    expect((await readD1PublicProductContributions(f.database, productId, {}, options())).items).toHaveLength(1)
  })
  it('rejects authenticated customers trying to moderate or inspect another contribution', async () => {
    const created = await submitD1ProductContribution(f.database, BUYER_CLAIMS, question(), command())
    await expect(
      moderateD1ProductContribution(f.database, BUYER_CLAIMS, created.contributionId, moderation(1), command())
    ).rejects.toMatchObject({ code: 'mfa_required' })
    f.sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES(?,'synthetic-unused-secret',?,?)"
      )
      .run(BUYER_CLAIMS.identityId, utc(-60000), utc(-60000))
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(BUYER_CLAIMS.sessionId)
    await expect(
      moderateD1ProductContribution(f.database, BUYER_CLAIMS, created.contributionId, moderation(1), command())
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      readD1ProductContribution(f.database, CLAIMS, 'customer', created.contributionId, options())
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it('revalidates permission inside the batch and rolls back the full new revision', async () => {
    const created = await submitD1ProductContribution(f.database, BUYER_CLAIMS, question(), command())
    const db = new Proxy(f.database, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            f.sqlite.prepare("DELETE FROM role_permissions WHERE permission_code='support.manage'").run()
            return target.batch(statements)
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(
      moderateD1ProductContribution(db, CLAIMS, created.contributionId, moderation(1), command())
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(f.sqlite.prepare('SELECT count(*) n FROM product_contribution_commands').get()).toEqual({ n: 1 })
    expect((await readD1PublicProductContributions(f.database, productId, {}, options())).items).toEqual([])
  })
  it('does not project contributions after the product is withdrawn from publication', async () => {
    const created = await submitD1ProductContribution(f.database, BUYER_CLAIMS, review(), command())
    await moderateD1ProductContribution(f.database, CLAIMS, created.contributionId, moderation(1), command())
    f.sqlite.prepare("UPDATE products SET status='draft' WHERE id='p-1'").run()
    await expect(readD1PublicProductContributions(f.database, productId, {}, options())).rejects.toMatchObject({
      code: 'not_found'
    })
  })
  it('protects immutable commands from replacement and fails closed on corrupted history', async () => {
    const created = await submitD1ProductContribution(f.database, BUYER_CLAIMS, review(), command())
    expect(() =>
      f.sqlite.prepare('DELETE FROM product_contribution_commands WHERE id=?').run(created.commandId)
    ).toThrow()
    const triggers = f.sqlite
      .prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='product_contribution_commands'")
      .all() as Array<{ name: string }>
    for (const trigger of triggers) f.sqlite.exec(`DROP TRIGGER "${trigger.name}"`)
    f.sqlite.prepare("UPDATE product_contribution_commands SET response='{}' WHERE id=?").run(created.commandId)
    await expect(
      readD1ProductContribution(f.database, BUYER_CLAIMS, 'customer', created.contributionId, options())
    ).rejects.toMatchObject({ code: 'history_unconfirmed' })
  })
})
