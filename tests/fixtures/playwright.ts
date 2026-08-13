import { expect, test as base } from '@playwright/test'
import { createHmac } from 'node:crypto'
import postgres from 'postgres'
import { deterministicTestData, type DeterministicTestData } from './deterministic'

const databaseConnection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'

interface NetecoFixtures {
  deterministic: DeterministicTestData
  externalNetworkGuard: undefined
  cartCleanup: undefined
}

export const test = base.extend<NetecoFixtures>({
  deterministic: async ({ browserName: _browserName }, use, testInfo) => {
    await use(deterministicTestData(`e2e:${testInfo.project.name}:${testInfo.titlePath.join(':')}`))
  },
  externalNetworkGuard: [
    async ({ context, baseURL }, use) => {
      if (!baseURL) throw new Error('Playwright baseURL is required for the external network guard')
      const allowedOrigin = new URL(baseURL).origin
      await context.route('**/*', async (route) => {
        if (new URL(route.request().url()).origin !== allowedOrigin) {
          await route.abort('blockedbyclient')
          return
        }
        await route.continue()
      })
      await use()
    },
    { auto: true }
  ],
  cartCleanup: [
    async ({ context }, use) => {
      await use()
      const cartCookie = (await context.cookies()).find((cookie) => cookie.name === 'neteco-cart')
      if (!cartCookie) return
      const pepper = process.env.AUTH_TOKEN_PEPPER ?? 'local-only-token-pepper-change-me'
      const tokenHash = createHmac('sha256', pepper).update(cartCookie.value, 'utf8').digest('hex')
      const sql = postgres(databaseConnection, { max: 1 })
      try {
        const [cart] = await sql<{ id: string; referenced: boolean }[]>`
          SELECT cart.id, EXISTS (SELECT 1 FROM orders WHERE orders.cart_id = cart.id) AS referenced
          FROM carts cart WHERE cart.public_token_hash = ${tokenHash}
        `
        if (!cart || cart.referenced) return
        await sql`DELETE FROM cart_operations WHERE cart_id = ${cart.id}`
        await sql`DELETE FROM cart_items WHERE cart_id = ${cart.id}`
        await sql`DELETE FROM carts WHERE id = ${cart.id}`
      } finally {
        await sql.end({ timeout: 5 })
      }
    },
    { auto: true }
  ]
})

export { expect }
