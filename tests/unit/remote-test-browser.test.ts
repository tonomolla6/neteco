import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Browser } from '@playwright/test'
import { connectRemoteTestBrowser, RemoteTestBrowserError } from '../../scripts/lib/remote-test-browser'
import { auditNativeAnalyticsBrowser } from '../../scripts/lib/audit-native-analytics-browser'
import { auditNativeCatalogExport } from '../../scripts/lib/audit-native-catalog-export'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCatalogExportHttp } from '../../workers/catalog/catalog-export-http'

const browser = vi.hoisted(() => ({ connect: vi.fn(), launch: vi.fn() }))
vi.mock('@playwright/test', () => ({ chromium: browser }))
const origin = 'https://shop-audit.neteco.test'
const utc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('dedicated private SSH test browser: fail closed without shared-host fallback', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    vi.stubEnv('PW_TEST_CONNECT_WS_ENDPOINT', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('requires an endpoint before calling any browser method', async () => {
    await expect(connectRemoteTestBrowser(browser)).rejects.toMatchObject({ code: 'remote_browser_endpoint_missing' })
    expect(browser.connect).not.toHaveBeenCalled()
    expect(browser.launch).not.toHaveBeenCalled()
  })
  it.each([
    'https://127.0.0.1:43123/browser',
    'ws://remote.example.invalid:43123/browser',
    'ws://127.0.0.2:43123/browser',
    'ws://127.0.0.1.example.invalid:43123/browser',
    'ws://secret-user:secret-password@127.0.0.1:43123/browser',
    'ws://127.0.0.1:43123/browser?token=secret',
    'ws://127.0.0.1:43123/browser#secret',
    'ws://localhost/browser',
    'not a URI',
    'ws://127.0.0.1:43123/browser\n'
  ])('rejects an invalid/private-forward-unsafe URI without connecting: %s', async (endpoint) => {
    const error = await connectRemoteTestBrowser(browser, { endpoint }).catch((error) => error)
    expect(error).toBeInstanceOf(RemoteTestBrowserError)
    expect(error.code).toBe('remote_browser_endpoint_invalid')
    expect(String(error)).not.toContain(endpoint)
    expect(String(error)).not.toContain('secret-user')
    expect(String(error)).not.toContain('secret-password')
    expect(browser.connect).not.toHaveBeenCalled()
    expect(browser.launch).not.toHaveBeenCalled()
  })
  it.each(['ws://127.0.0.1:43123/private-browser', 'wss://localhost:43123/private-browser'])(
    'uses only connect with bounded timeout and server-loopback exposure',
    async (endpoint) => {
      const connected = {} as Browser
      browser.connect.mockResolvedValueOnce(connected)
      expect(await connectRemoteTestBrowser(browser, { endpoint })).toBe(connected)
      expect(browser.connect).toHaveBeenCalledExactlyOnceWith(endpoint, { exposeNetwork: '<loopback>', timeout: 10000 })
      expect(browser.launch).not.toHaveBeenCalled()
    }
  )
  it('uses the existing runner endpoint environment variable', async () => {
    vi.stubEnv('PW_TEST_CONNECT_WS_ENDPOINT', 'ws://localhost:43123/private-browser')
    browser.connect.mockResolvedValueOnce({} as Browser)
    await connectRemoteTestBrowser(browser)
    expect(browser.connect).toHaveBeenCalledWith('ws://localhost:43123/private-browser', expect.any(Object))
  })
  it('redacts provider connection errors and never falls back to launch', async () => {
    const endpoint = 'ws://127.0.0.1:43123/private-browser'
    browser.connect.mockRejectedValueOnce(new Error('CONNECT FAILED token=TOP_SECRET ' + endpoint))
    const error = await connectRemoteTestBrowser(browser, { endpoint }).catch((error) => error)
    expect(error).toMatchObject({ code: 'remote_browser_unavailable' })
    expect(String(error)).not.toContain('TOP_SECRET')
    expect(String(error)).not.toContain(endpoint)
    expect(error).not.toHaveProperty('cause')
    expect(browser.launch).not.toHaveBeenCalled()
  })
  it('analytics not-run reports zero actual browser scenarios without dispatch, callbacks or connection', async () => {
    vi.stubEnv('PW_TEST_CONNECT_WS_ENDPOINT', 'ws://localhost:43123/private-browser')
    const dispatch = vi.fn(),
      scenario = vi.fn()
    const result = await auditNativeAnalyticsBrowser({
      dispatch,
      origin,
      adminCookie: 'neteco-session=synthetic',
      range: { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' },
      scenario,
      browserMode: 'not-run'
    })
    expect(result).toMatchObject({
      scenarios: 0,
      browserStatus: 'not_run',
      requests: null,
      pageErrors: null,
      blockedExternal: null,
      screenshots: []
    })
    expect(result.reason).toContain('not run')
    expect(dispatch).not.toHaveBeenCalled()
    expect(scenario).not.toHaveBeenCalled()
    expect(browser.connect).not.toHaveBeenCalled()
    expect(browser.launch).not.toHaveBeenCalled()
  })
  it('analytics defaults to required and fails loudly when the dedicated service endpoint is absent', async () => {
    await expect(
      auditNativeAnalyticsBrowser({
        dispatch: vi.fn(),
        origin,
        adminCookie: 'neteco-session=synthetic',
        range: { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' },
        scenario: vi.fn()
      })
    ).rejects.toMatchObject({ code: 'remote_browser_endpoint_missing' })
    expect(browser.launch).not.toHaveBeenCalled()
  })
  it('catalog not-run still executes all six real HTTP/D1 scenarios with unchanged state', async () => {
    const sqlite = await openMigratedDatabase(),
      underlying = d1OverSqlite(sqlite)
    // Real D1 results are JSON records; node:sqlite uses null-prototype records.
    // Preserve actual SQLite values while matching the platform's row shape.
    const database = {
      ...underlying,
      prepare(sql: string) {
        const statement = underlying.prepare(sql)
        return {
          ...statement,
          async all() {
            const result = await statement.all<Record<string, unknown>>()
            return { ...result, results: result.results.map((row) => ({ ...row })) }
          }
        }
      }
    } as D1Database
    try {
      seedInventoryFixture(sqlite)
      await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: utc(-3600_000) })
      const identityId = crypto.randomUUID(),
        adminSession = crypto.randomUUID(),
        unprivilegedSession = crypto.randomUUID()
      sqlite
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'remote-helper@example.invalid','synthetic-unusable',?,'active',?,?)"
        )
        .run(identityId, utc(-86400_000), utc(-86400_000), utc(-86400_000))
      sqlite.exec(
        "INSERT INTO roles VALUES ('remote-browser-audit','Local helper auditor','Synthetic fixture'); INSERT INTO permissions VALUES ('catalog.write','catalog','write','Synthetic'),('administration.manage','administration','manage','Synthetic'); INSERT INTO role_permissions VALUES ('remote-browser-audit','catalog.write'),('remote-browser-audit','administration.manage')"
      )
      sqlite
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'remote-browser-audit',?)")
        .run(identityId, utc(-86400_000))
      for (const [sessionId, mfa] of [
        [adminSession, 1],
        [unprivilegedSession, 0]
      ] as const)
        sqlite
          .prepare(
            'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,?,?,?)'
          )
          .run(sessionId, identityId, mfa, utc(-86400_000), utc(3600_000))
      const password = 'synthetic-remote-browser-audit-password'.repeat(2)
      const cookie = async (sessionId: string) =>
        (await issueD1SessionCookie(
          database,
          { identityId, sessionId, sessionVersion: 1 },
          { password, maxAgeSeconds: 3600 }
        ))!.split(';')[0]!
      const env = { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
      const dispatch = vi.fn(async (request: Request) => {
          const response = await handleCatalogExportHttp(request, env)
          if (!response) throw new Error('unexpected_native_export_route')
          return response
        }),
        scenarios: string[] = []
      const result = await auditNativeCatalogExport({
        dispatch,
        database,
        origin,
        adminCookie: await cookie(adminSession),
        unprivilegedCookie: await cookie(unprivilegedSession),
        scenario: (name) => scenarios.push(name),
        browserMode: 'not-run'
      })
      expect(result.scenarios).toBe(6)
      expect(scenarios).toHaveLength(6)
      expect(scenarios.every((name) => !name.includes('browser') && !name.includes('compiled'))).toBe(true)
      expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(12)
      expect(result.browser).toMatchObject({ status: 'not_run', engine: null, csv: null, xlsx: null, requests: null })
      expect(browser.connect).not.toHaveBeenCalled()
      expect(browser.launch).not.toHaveBeenCalled()
      await expect(
        auditNativeCatalogExport({
          dispatch,
          database,
          origin,
          adminCookie: await cookie(adminSession),
          unprivilegedCookie: await cookie(unprivilegedSession),
          scenario: () => undefined
        })
      ).rejects.toMatchObject({ code: 'remote_browser_endpoint_missing' })
      expect(browser.launch).not.toHaveBeenCalled()
    } finally {
      sqlite.close()
    }
  })
})
