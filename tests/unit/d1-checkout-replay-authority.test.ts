import { expect, it } from 'vitest'
import { returnsFixture, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions } from '../../workers/catalog/checkout'

it('does not release a completed checkout receipt or order token when its owner session is revoked during replay lookup', async () => {
  const fixture = await returnsFixture()
  try {
    const database = fixture.database
    const cart = await createCart(database, { now: utc(), correlationId: 'replay-authority' })
    const common = { ...cart, expectedVersion: 2, now: utc(), correlationId: 'replay-authority' }
    await setCartLine(database, {
      ...common,
      expectedVersion: 1,
      variantId: 'v-1-1',
      quantity: 2,
      idempotencyKey: 'add'
    })
    const quote = await quoteCart(database, { ...common, idempotencyKey: 'quote' })
    const shipping = await requestShippingOptions(database, {
      ...common,
      idempotencyKey: 'shipping',
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    if (quote.outcome !== 'quoted' || shipping.outcome !== 'options') throw new Error('synthetic_quote_failed')
    const option = (
      shipping.body.options as Array<{ methodCode: string; optionIndex: number; optionHash: string }>
    ).find((item) => item.methodCode === 'pickup')!
    const input = {
      ...common,
      ownerSession: BUYER_CLAIMS,
      idempotencyKey: 'checkout',
      quoteId: quote.quote.quoteId,
      shippingQuoteId: String(shipping.body.shippingQuoteId),
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      contactEmail: 'buyer@example.invalid',
      shippingAddress: {
        recipientName: 'Synthetic buyer',
        line1: 'Synthetic street 1',
        city: 'Ontinyent',
        province: 'Valencia',
        postalCode: '46870',
        phone: '+34600111222'
      },
      consentTos: true as const,
      consentPrivacy: true as const
    }
    expect(await placeOrder(database, input)).toMatchObject({ outcome: 'order_created' })
    let revoked = false
    const raced = new Proxy(database, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (!sql.includes('response_body FROM checkout_commands')) return statement
            const bind = statement.bind.bind(statement)
            statement.bind = (...values: unknown[]) => {
              const bound = bind(...values),
                first = bound.first.bind(bound)
              bound.first = async <T>() => {
                const result = await first<T>()
                if (!revoked) {
                  revoked = true
                  fixture.sqlite
                    .prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?')
                    .run(utc(), BUYER_CLAIMS.sessionId)
                }
                return result
              }
              return bound
            }
            return statement
          }
        const value: unknown = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(placeOrder(raced, input)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(revoked).toBe(true)
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM orders').get()?.n).toBe(1)
  } finally {
    fixture.sqlite.close()
  }
})
