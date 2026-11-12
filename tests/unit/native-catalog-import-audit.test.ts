import { describe, expect, it, vi } from 'vitest'
import { auditNativeCatalogImport } from '../../scripts/lib/audit-native-catalog-import'
import { renderD1CategorySeed } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { renderD1InventorySeed } from '../../scripts/lib/d1-inventory-seed'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleNativeCatalogImportHttp } from '../../workers/catalog/native-import-http'
import { handleCatalogImportJobHttp } from '../../workers/catalog/import-job-http'
import { handleD1AdminCatalogRequest } from '../../workers/catalog/admin-catalog-http'
import { testUuid, testNow } from '../support/deterministic'

const origin = 'https://shop-audit.neteco.test'
const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('disposable native catalog import HTTP proof', () => {
  it('runs sixteen counted scenarios including inert staging/review and atomic 601-row apply/compensation without external I/O', async () => {
    const sqlite = await openMigratedDatabase(),
      database = d1OverSqlite(sqlite)
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external network forbidden'))
    try {
      sqlite.exec(renderD1CategorySeed())
      sqlite.exec(renderD1ProductSeed())
      sqlite.exec(renderD1InventorySeed())
      sqlite.limits.exprDepth = 100
      sqlite.limits.variableNumber = 100
      sqlite.limits.functionArg = 32
      sqlite.limits.compoundSelect = 5
      sqlite.limits.likePatternLength = 50
      const identityId = testUuid(),
        adminSession = testUuid(),
        unprivilegedSession = testUuid()
      sqlite
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'native-audit-helper@example.invalid','unusable-synthetic',?,'active',?,?)"
        )
        .run(identityId, utc(-86400_000), utc(-86400_000), utc(-86400_000))
      sqlite.exec("INSERT INTO roles VALUES ('native-audit-helper','Import fixture','Synthetic only')")
      for (const [resource, action] of [
        ['catalog', 'write'],
        ['administration', 'manage'],
        ['inventory', 'write']
      ] as const) {
        sqlite
          .prepare('INSERT INTO permissions VALUES (?,?,?,?)')
          .run(`${resource}.${action}`, resource, action, 'Synthetic only')
        sqlite.prepare("INSERT INTO role_permissions VALUES ('native-audit-helper',?)").run(`${resource}.${action}`)
      }
      sqlite
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'native-audit-helper',?)")
        .run(identityId, utc(-86400_000))
      for (const [session, mfa] of [
        [adminSession, 1],
        [unprivilegedSession, 0]
      ] as const)
        sqlite
          .prepare(
            'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,?,?,?)'
          )
          .run(session, identityId, mfa, utc(-86400_000), utc(3600_000))
      const password = 'native-helper-session-test-only-secret'.repeat(2),
        configuration = { password, maxAgeSeconds: 3600 }
      const cookie = async (sessionId: string) =>
        (await issueD1SessionCookie(database, { identityId, sessionId, sessionVersion: 1 }, configuration))!.split(
          ';'
        )[0]!
      const env = { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
      const dispatch = vi.fn(async (request: Request) => {
          const response =
            (await handleNativeCatalogImportHttp(request, env)) ??
            (await handleCatalogImportJobHttp(request, env)) ??
            (await handleD1AdminCatalogRequest(request, {
              database,
              sessionCookieConfiguration: configuration,
              origin
            }))
          if (!response) throw new Error('unexpected_disposable_audit_route')
          return response
        }),
        scenarios: string[] = []
      const beforePublished = sqlite.prepare("SELECT count(*) AS n FROM products WHERE status='published'").get()!.n
      const result = await auditNativeCatalogImport({
        dispatch,
        database,
        origin,
        adminCookie: await cookie(adminSession),
        unprivilegedCookie: await cookie(unprivilegedSession),
        scenario: (name) => scenarios.push(name)
      })
      expect(result).toMatchObject({
        scenarios: 16,
        productsCreated: 2,
        variantsCreated: 2,
        assetsPendingVerification: 2,
        compensatedProducts: 1,
        retainedEditedDrafts: 1,
        unauthorizedReplayBlocked: true,
        unrelatedRecordsUnchanged: true,
        publicationAuthorityCreated: false,
        externalStorageWrites: false,
        browserStatus: 'not_run',
        productionAcceptance: false
      })
      expect(result.globalJobStaging).toEqual({
        recordCount: 601,
        pages: [201, 201, 199],
        status: 'ready',
        applied: false,
        identicalReplayVerified: true,
        domainUnchanged: true,
        full25000RowApplyAcceptance: false
      })
      expect(result.globalJobReview).toEqual({
        totalEntries: 2404,
        sampledEntries: 4,
        sampledKinds: ['assets', 'media', 'products', 'variants'],
        fullPaginationCompleted: false,
        readOnly: true,
        unauthorizedReadBlocked: true
      })
      expect(result.globalJobCommands).toEqual({
        testedRecordCount: 601,
        appliedProducts: 601,
        compensatedProducts: 601,
        durableReceipts: 2,
        auditRows: 9015,
        exactApplyReplayVerified: true,
        exactRevertReplayVerified: true,
        unauthorizedReplayBlocked: true,
        immutableStagingUnchanged: true,
        unrelatedRecordsUnchanged: true,
        publicationAuthorityCreated: false,
        full25000RowApplyAcceptance: false
      })
      expect(scenarios).toHaveLength(result.scenarios)
      expect(new Set(scenarios).size).toBe(result.scenarios)
      expect(dispatch.mock.calls).toHaveLength(result.httpRequests)
      expect(sqlite.prepare("SELECT count(*) AS n FROM products WHERE status='published'").get()!.n).toBe(
        beforePublished
      )
      expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_native_commands').get()!.n).toBe(3)
      expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_native_audit').get()!.n).toBe(3)
      expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_import_jobs').get()!.n).toBe(1)
      expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_import_job_rows').get()!.n).toBe(601)
      expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_import_job_pages').get()!.n).toBe(3)
      expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_import_job_seals').get()!.n).toBe(1)
      expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_import_job_commands').get()!.n).toBe(2)
      expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_import_job_command_audit').get()!.n).toBe(9015)
      expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_import_job_guards').get()!.n).toBe(0)
      const jobCommands = dispatch.mock.calls.filter(([request]) =>
        /\/import-jobs\/[^/]+\/(apply|revert)$/.test(new URL(request.url).pathname)
      )
      expect(jobCommands).toHaveLength(5)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
      sqlite.close()
    }
    // Sixteen HTTP/D1 scenarios include 601-row staging, apply and compensation.
    // This is a journey budget, not a relaxation of D1's per-query limits.
  }, 60000)
})
