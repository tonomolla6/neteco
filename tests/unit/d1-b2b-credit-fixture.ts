import { readFile } from 'node:fs/promises'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { requestShippingOptions } from '../../workers/catalog/checkout'
import { testUuid } from '../support/deterministic'

export async function creditWorld() {
  const f = await returnsFixture()
  const now = utc(),
    before = utc(-60000)
  f.sqlite.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0105_b2b_credit_terms.sql', 'utf8'))
  f.sqlite
    .prepare(
      "INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES('company',?,'Empresa','approved',?,?)"
    )
    .run(CUSTOMER, before, before)
  const terms = (limit: number, expected = 0, blocked = 0) =>
    f.sqlite
      .prepare(
        `INSERT INTO b2b_credit_commands(actor_id,command_id,session_id,session_version,company_id,expected_version,payment_days,credit_limit_cents,blocked,block_reason,reason,payload_hash,created_at) VALUES(?,?,?,1,'company',?,30,?,?,?,'Agreement',?,?)`
      )
      .run(
        CLAIMS.identityId,
        testUuid(),
        CLAIMS.sessionId,
        expected,
        limit,
        blocked,
        blocked ? 'Risk' : null,
        'a'.repeat(64),
        now
      )
  async function input() {
    const cart = await createCart(f.database, { correlationId: 'credit-test', now })
    await setCartLine(f.database, {
      ...cart,
      expectedVersion: 1,
      idempotencyKey: 'add',
      variantId: 'v-1-1',
      quantity: 1,
      correlationId: 'credit-test',
      now
    })
    const quote = await quoteCart(f.database, {
      ...cart,
      expectedVersion: 2,
      idempotencyKey: 'quote',
      correlationId: 'credit-test',
      now,
      ownerSession: BUYER_CLAIMS
    })
    const shipping = await requestShippingOptions(f.database, {
      ...cart,
      expectedVersion: 2,
      idempotencyKey: 'shipping',
      correlationId: 'credit-test',
      now,
      destination: { city: 'Ontinyent', postalCode: '46870' },
      ownerSession: BUYER_CLAIMS
    })
    if (quote.outcome !== 'quoted' || shipping.outcome !== 'options') throw new Error('fixture quote')
    const option = (
      shipping.body.options as Array<{ methodCode: string; optionIndex: number; optionHash: string }>
    ).find((o) => o.methodCode === 'pickup')!
    return {
      ...cart,
      expectedVersion: 2,
      idempotencyKey: 'checkout',
      correlationId: 'credit-test',
      now,
      ownerSession: BUYER_CLAIMS,
      quoteId: quote.quote.quoteId,
      shippingQuoteId: String(shipping.body.shippingQuoteId),
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      expectedTotalGrossCents: quote.quote.totals.grossCents,
      contactEmail: 'buyer@example.invalid',
      contactName: 'Buyer',
      contactPhone: '+34600111222',
      shippingAddress: {
        recipientName: 'Buyer',
        line1: 'Carrer Major 1',
        city: 'Ontinyent',
        province: 'Valencia',
        postalCode: '46870',
        phone: '+34600111222'
      },
      consentTos: true as const,
      consentPrivacy: true as const,
      paymentMethod: 'credit' as const
    }
  }
  return { ...f, now, terms, input }
}
