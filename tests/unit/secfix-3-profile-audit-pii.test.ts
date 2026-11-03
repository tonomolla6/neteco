import { beforeAll, describe, expect, it, vi } from 'vitest'

// SECFIX-3 finding 10: profile updates wrote the customer's name and phone in clear into audit_log.
const recorded: { text: string; values: unknown[] }[] = []

vi.mock('../../server/db/client', () => {
  const transaction = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      recorded.push({ text, values })
      return /SELECT name, phone/.test(text) ? [{ name: 'Ana Pérez García', phone: '+34600111222' }] : []
    },
    { json: (value: unknown) => ({ json: value }) }
  )
  return { useDatabase: () => ({ begin: async (run: (tx: typeof transaction) => Promise<void>) => run(transaction) }) }
})
vi.mock('../../server/utils/account', () => ({
  requireCustomerAccount: async () => ({
    customerId: 'cust-1',
    profile: { id: 'ident-1' },
    mfaVerified: false,
    session: { sessionId: 'sess-1' }
  })
}))
vi.mock('../../server/utils/auth-session', () => ({
  identityProfile: async () => ({ id: 'ident-1' }),
  refreshAuthenticatedSession: async () => ({ id: 'ident-1' })
}))

let handler: (event: unknown) => Promise<unknown>

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('readValidatedBody', async (_event: unknown, parse: (value: unknown) => unknown) =>
    parse({ name: 'Ana María Pérez', phone: '+34 699 888 777' })
  )
  handler = (await import('../../server/api/account/profile.put')).default as never
})

describe('SECFIX-3 PUT /api/account/profile audit redaction', () => {
  it('stores no name or phone in before_redacted/after_redacted', async () => {
    await handler({ context: { correlationId: 'corr-1' } })
    const audit = recorded.find((entry) => entry.text.includes('INSERT INTO audit_log'))
    expect(audit).toBeDefined()
    const serialized = JSON.stringify(audit!.values)
    for (const pii of ['Ana Pérez García', '+34600111222', 'Ana María Pérez', '+34 699 888 777', '699']) {
      expect(serialized).not.toContain(pii)
    }
    expect(serialized).toContain('nameChanged')
  })
})
