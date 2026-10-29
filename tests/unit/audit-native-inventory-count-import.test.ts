import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { InventoryCoordinator, INVENTORY_COORDINATOR_NAME } from '../../workers/inventory-coordinator'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { auditNativeInventoryCountImport } from '../../scripts/lib/audit-native-inventory-count-import'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION,
  inventoryFixtureUtc
} from '../support/admin-inventory-fixture'

const origin = 'https://count-native-helper.neteco.test'
const password = 'synthetic-native-count-cookie-more-than-32'
const unprivilegedId = '10000000-0000-4000-8000-000000000043'
const unprivilegedSession = '20000000-0000-4000-8000-000000000043'
let fixture: Awaited<ReturnType<typeof openAdminInventoryFixture>>
let env: CloudflareEnv
let proposerCookie: string, approverCookie: string, unprivilegedCookie: string
let forward: ReturnType<typeof vi.fn>
beforeEach(async () => {
  fixture = await openAdminInventoryFixture()
  fixture.sqlite.exec(
    await readFile(new URL('../../db/d1/migrations/0077_inventory_count_imports.sql', import.meta.url), 'utf8')
  )
  const values = new Map<string, unknown>()
  const storage = {
    get: async (id: string) => values.get(id),
    put: async (id: string, value: unknown) => {
      values.set(id, structuredClone(value))
    },
    list: async () => new Map(values),
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined
  }
  const coordinator = new InventoryCoordinator(
    { storage } as unknown as DurableObjectState,
    { DB: fixture.database } as CloudflareEnv
  )
  forward = vi.fn(async (url: string, init: RequestInit) => coordinator.fetch(new Request(url, init)))
  env = {
    AUTH_ENABLED: 'true',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: password,
    AUTH_RATE_LIMIT_PEPPER: 'synthetic-native-count-pepper-more-than-32',
    DB: fixture.database,
    ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
    INVENTORY: { idFromName: vi.fn((name: string) => name), get: () => ({ fetch: forward }) }
  } as unknown as CloudflareEnv
  fixture.sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,?,'unusable-synthetic',?,'active',?,?)"
    )
    .run(
      unprivilegedId,
      'unprivileged-count@synthetic.invalid',
      inventoryFixtureUtc(-3600000),
      inventoryFixtureUtc(-3600000),
      inventoryFixtureUtc(-3600000)
    )
  fixture.sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
    )
    .run(unprivilegedSession, unprivilegedId, inventoryFixtureUtc(-3600000), inventoryFixtureUtc(3600000))
  const cookie = async (identityId: string, sessionId: string) =>
    (await issueD1SessionCookie(
      fixture.database,
      { identityId, sessionId, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!
  proposerCookie = await cookie(INVENTORY_FIXTURE_ACTOR, INVENTORY_FIXTURE_SESSION)
  approverCookie = await cookie('10000000-0000-4000-8000-000000000042', '20000000-0000-4000-8000-000000000042')
  unprivilegedCookie = await cookie(unprivilegedId, unprivilegedSession)
})
afterEach(() => {
  fixture?.sqlite.close()
  vi.restoreAllMocks()
})
const input = (scenario: (id: string) => void) => ({
  database: fixture.database,
  dispatch: (request: Request) => worker.fetch(request, env),
  origin,
  proposerCookie,
  approverCookie,
  unprivilegedCookie,
  variantLegacyId: 11,
  scenario
})
describe('native inventory count import helper on real canary/coordinator/D1', () => {
  it('completes six guarded scenarios with one real physical adjustment and exact durable receipts', async () => {
    const scenario = vi.fn()
    const result = await auditNativeInventoryCountImport(input(scenario))
    expect(result).toMatchObject({
      scenarios: 6,
      atomic: true,
      physicalDelta: 1,
      commandDelta: 2,
      auditDelta: 2,
      economicUnchanged: true,
      providerSubmission: false,
      browserExecuted: false
    })
    expect(scenario.mock.calls.map(([id]) => id)).toEqual(result.checks)
    expect(new Set(result.checks).size).toBe(6)
    expect(fixture.sqlite.prepare('SELECT physical_quantity,version FROM inventory_balances').get()).toEqual({
      physical_quantity: 21,
      version: 2
    })
    expect(
      fixture.sqlite
        .prepare("SELECT count(*) n FROM inventory_movements WHERE reference_type='inventory_count_import'")
        .get()!.n
    ).toBe(1)
    expect(env.INVENTORY.idFromName).toHaveBeenCalledWith(INVENTORY_COORDINATOR_NAME)
    expect(forward).toHaveBeenCalledTimes(4)
  })
  it('rejects an actual unprivileged proposer before any count command or physical mutation', async () => {
    await expect(
      auditNativeInventoryCountImport({ ...input(vi.fn()), proposerCookie: unprivilegedCookie })
    ).rejects.toThrow('native_count_import_http_status')
    expect(forward).not.toHaveBeenCalled()
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM inventory_count_import_commands').get()!.n).toBe(0)
    expect(fixture.sqlite.prepare('SELECT physical_quantity,version FROM inventory_balances').get()).toEqual({
      physical_quantity: 20,
      version: 1
    })
  })
})
