import { scryptSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAccountSecurityDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { deterministicUuid } from '../fixtures/deterministic'
import { customerTaxIdIsValid } from '../../shared/customer-tax-validation'
import { handleAuthenticationHttp } from '../../workers/auth/http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { testNow } from '../support/deterministic'

const origin = 'https://company-browser-fixture.neteco.test'
const password = 'Synthetic-browser-company-123'
const salt = Buffer.from('company-browser-fixture-salt')
const hash = `$scrypt$n=16384,r=8,p=1$${salt.toString('base64').replace(/=+$/, '')}$${scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64').replace(/=+$/, '')}`
const configuration = {
  password: 'synthetic-company-browser-seal-password-over32',
  maxAgeSeconds: 3600,
  origin,
  tokenPepper: 'synthetic-company-browser-token-pepper-over32',
  encryptionKey: Buffer.alloc(32, 7).toString('base64')
}
let sqlite: Awaited<ReturnType<typeof openAccountSecurityDatabase>>
let database: D1Database
beforeEach(async () => {
  sqlite = await openAccountSecurityDatabase()
  database = d1OverSqlite(sqlite)
})
afterEach(() => {
  if (sqlite?.isOpen) sqlite.close()
})

describe('compiled company browser fixture uses canonical synthetic fiscal IDs', () => {
  it.each([
    ['desktop', 'B99000641', 'B99000648'],
    ['mobile', 'B99000642', 'B99000655']
  ])(
    '%s rejects the old checksum and submits a distinct valid synthetic company through real HTTP',
    async (viewport, oldTaxId, taxId) => {
      const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
      const identityId = deterministicUuid('browser-company-owner-' + viewport)
      const customerId = deterministicUuid('browser-company-customer-' + viewport)
      const sessionId = deterministicUuid('browser-company-session-' + viewport)
      sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(customerId, now, now)
      sqlite
        .prepare(
          "INSERT INTO identities(id,email,password_hash,status,email_verified_at,customer_id,created_at,updated_at) VALUES(?,?,?,'active',?,?,?,?)"
        )
        .run(identityId, `browser-company-${viewport}@synthetic.invalid`, hash, now, customerId, now, now)
      sqlite
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,created_at,expires_at) VALUES(?,?,1,?,'2099-01-01T00:00:00Z')"
        )
        .run(sessionId, identityId, now)
      const cookie = (await issueD1SessionCookie(
        database,
        { identityId, sessionId, sessionVersion: 1 },
        configuration
      ))!.split(';')[0]!
      const submit = (value: string) =>
        handleAuthenticationHttp(
          new Request(origin + '/api/account/company', {
            method: 'PUT',
            headers: {
              Origin: origin,
              Cookie: cookie,
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '192.0.2.168'
            },
            body: JSON.stringify({
              legalName: `Empresa sintética ${viewport}`,
              tradeName: 'Demostración aislada',
              taxId: value,
              countryCode: 'ES',
              currentPassword: password
            })
          }),
          {
            database,
            configuration: () => configuration,
            edgeLimiter: { limit: async () => ({ success: true }) } as RateLimit
          }
        )
      expect(customerTaxIdIsValid('ES', oldTaxId, { required: true })).toBe(false)
      const rejected = await submit(oldTaxId)
      expect(rejected?.status).toBe(400)
      expect(await rejected!.json()).toEqual({ error: { code: 'invalid_tax_id' } })
      expect(sqlite.prepare('SELECT count(*) n FROM companies').get()!.n).toBe(0)
      expect(sqlite.prepare('SELECT count(*) n FROM identity_account_security_events').get()!.n).toBe(0)

      expect(customerTaxIdIsValid('ES', taxId, { required: true })).toBe(true)
      const accepted = await submit(taxId)
      expect(accepted?.status).toBe(200)
      const body = (await accepted!.json()) as { companyId: string; status: string; user: unknown }
      expect(body).toMatchObject({ status: 'pending', user: { id: identityId } })
      expect(body).not.toHaveProperty('ok')
      expect(body.companyId).toMatch(/^[a-f0-9-]{36}$/)
      expect(sqlite.prepare('SELECT tax_id,status,customer_id FROM companies WHERE id=?').get(body.companyId)).toEqual({
        tax_id: taxId,
        status: 'pending',
        customer_id: customerId
      })
      expect(sqlite.prepare('SELECT count(*) n FROM identity_account_security_events').get()!.n).toBe(1)
    }
  )
})
