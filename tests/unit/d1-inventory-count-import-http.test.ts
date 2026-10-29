import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleInventoryCountImportHttp } from '../../workers/catalog/inventory-count-import-http'
import {
  proposeD1InventoryCountImport,
  approveD1InventoryCountImport
} from '../../workers/catalog/inventory-count-import'
import { executeD1AdminInventoryCommand } from '../../workers/catalog/admin-inventory'
import { inventoryCountImportIntentHash } from '../../shared/inventory-count-import'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION
} from '../support/admin-inventory-fixture'

const origin = 'https://inventory-import.neteco.test'
const password = 'synthetic-inventory-import-cookie-more-than-32'
const claims = { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 }
const base = '/api/admin/inventory/count-imports'
const key = '80000000-0000-4000-8000-000000000010'
const csv = 'sku,countedPhysicalQuantity\nSYNTHETIC-SKU,18'
let fixture: Awaited<ReturnType<typeof openAdminInventoryFixture>>, cookie: string, reviewerCookie: string

beforeEach(async () => {
  fixture = await openAdminInventoryFixture()
  fixture.sqlite.exec(
    await readFile(new URL('../../db/d1/migrations/0077_inventory_count_imports.sql', import.meta.url), 'utf8')
  )
  cookie = (await issueD1SessionCookie(fixture.database, claims, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  reviewerCookie = (await issueD1SessionCookie(
    fixture.database,
    {
      identityId: '10000000-0000-4000-8000-000000000042',
      sessionId: '20000000-0000-4000-8000-000000000042',
      sessionVersion: 1
    },
    { password, maxAgeSeconds: 3600 }
  ))!.split(';')[0]!
})
afterEach(() => {
  fixture?.sqlite.close()
  vi.restoreAllMocks()
})

// Initial RED on the existing handler: ten behavioral failures (missing route
// returned400) and one CSRF control passed. Now use the real new boundary/core.
function dispatch(request: Request, database = fixture.database) {
  return handleInventoryCountImportHttp(request, {
    database,
    origin,
    sessionCookieConfiguration: { password, maxAgeSeconds: 3600 },
    edgeLimiter: { limit: async () => ({ success: true }) } as RateLimit,
    rateLimitPepper: 'synthetic-inventory-import-pepper-more-than-32',
    coordinate: (command) =>
      command.action === 'propose'
        ? proposeD1InventoryCountImport(database, command.claims, command.input, {
            idempotencyKey: command.idempotencyKey
          })
        : approveD1InventoryCountImport(database, command.claims, command.targetId!, command.input, {
            idempotencyKey: command.idempotencyKey
          })
  })
}
function request(body: unknown = { csv }, headers: Record<string, string> = {}, path = base + '/preview') {
  return new Request(origin + path, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.10',
      'Idempotency-Key': key,
      ...headers
    },
    body: JSON.stringify(body)
  })
}
function privateHeaders(response: Response | null) {
  expect(response).not.toBeNull()
  expect(response!.headers.get('cache-control')).toBe('private, no-store')
  expect(response!.headers.get('vary')).toBe('Cookie')
  expect(response!.headers.get('referrer-policy')).toBe('no-referrer')
}
function inventoryState() {
  return {
    balances: fixture.sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all(),
    movements: fixture.sqlite.prepare('SELECT * FROM inventory_movements ORDER BY id').all(),
    commands: fixture.sqlite.prepare('SELECT * FROM inventory_admin_commands ORDER BY id').all()
  }
}
function read(path: string, credential = cookie, headers: Record<string, string> = {}) {
  return dispatch(
    new Request(origin + path, {
      headers: {
        Cookie: credential,
        Origin: origin,
        'CF-Connecting-IP': '192.0.2.10',
        ...headers
      }
    })
  )
}
async function propose() {
  const preview = await dispatch(request())
  expect(preview?.status).toBe(200)
  const input = {
    csv,
    previewHash: ((await preview!.json()) as { previewHash: string }).previewHash,
    reason: 'Synthetic documented warehouse count',
    reference: 'SYNTHETIC-COUNT-010'
  }
  const response = await dispatch(request(input, {}, base))
  expect(response?.status).toBe(201)
  const receipt = (await response!.json()) as {
    importId: string
    payloadHash: string
    commandId: string
    version: number
  }
  return { input, receipt }
}

describe('inventory count import HTTP behavioral boundary', () => {
  it.each([
    '/api/admin/inventory/COUNT-IMPORTS/preview',
    '/api/admin/inventory/count-%69mports/preview',
    '/api/admin/inventory/count-imports/not-a-uuid'
  ])('consumes noncanonical import namespace %s without falling through to Node', async (path) => {
    const response = await dispatch(request({ csv }, {}, path))
    expect(response?.status).toBe(404)
    privateHeaders(response)
  })
  it('previews the real SKU/balance difference without changing stock or creating a count', async () => {
    const before = inventoryState()
    const response = await dispatch(request())
    expect(response?.status).toBe(200)
    privateHeaders(response)
    const result = (await response!.json()) as Record<string, unknown>
    expect(result).toMatchObject({
      source: 'cloudflare',
      canPropose: true,
      rows: [
        {
          rowNumber: 2,
          sku: 'SYNTHETIC-SKU',
          countedPhysicalQuantity: 18,
          variantId: 11,
          expectedBalanceVersion: 1,
          physicalQuantity: 20,
          physicalDelta: -2,
          error: null
        }
      ]
    })
    expect(result.previewHash).toMatch(/^[a-f0-9]{64}$/)
    expect(inventoryState()).toEqual(before)
  })
  it('reports an unknown SKU per row and refuses the whole proposal without partial writes', async () => {
    const before = inventoryState()
    const response = await dispatch(request({ csv: csv + '\nUNKNOWN-SKU,5' }))
    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({
      canPropose: false,
      rows: [
        { sku: 'SYNTHETIC-SKU', error: null },
        { sku: 'UNKNOWN-SKU', variantId: null, error: 'unknown_sku' }
      ]
    })
    expect(inventoryState()).toEqual(before)
  })
  it('keeps zero differences visible without inventing a stock adjustment', async () => {
    const before = inventoryState()
    const response = await dispatch(request({ csv: csv.replace(',18', ',20') }))
    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({ canPropose: false, rows: [{ physicalDelta: 0, error: null }] })
    expect(inventoryState()).toEqual(before)
  })
  it('requires an authenticated session before touching private balances', async () => {
    const prepare = vi.fn(() => {
      throw new Error('anonymous_database_access')
    })
    const response = await dispatch(request(undefined, { Cookie: '' }), { prepare } as unknown as D1Database)
    expect(response?.status).toBe(401)
    expect(prepare).not.toHaveBeenCalled()
    privateHeaders(response)
  })
  it.each(['email', 'mfa', 'grant', 'session'])(
    'rejects a real live %s authority boundary instead of returning preview data',
    async (boundary) => {
      if (boundary === 'email')
        fixture.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(claims.identityId)
      if (boundary === 'mfa')
        fixture.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(claims.sessionId)
      if (boundary === 'grant')
        fixture.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='inventory.read'")
      if (boundary === 'session')
        fixture.sqlite
          .prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?')
          .run(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), claims.sessionId)
      const response = await dispatch(request())
      expect(response?.status).toBe(boundary === 'session' ? 401 : 403)
      privateHeaders(response)
      expect(await response!.text()).not.toContain('SYNTHETIC-SKU')
    }
  )
  it('rejects cross-origin preview before reading a private SKU', async () => {
    const response = await dispatch(request(undefined, { Origin: 'https://foreign.invalid' }))
    expect(response?.status).toBe(403)
    privateHeaders(response)
  })
  it('bounds the streamed JSON body at 128 KiB without creating any stock mutation', async () => {
    const before = inventoryState()
    const response = await dispatch(request({ csv: 'x'.repeat(128 * 1024) }))
    expect(response?.status).toBe(413)
    expect(inventoryState()).toEqual(before)
  })
  it('fails closed with opaque 503 on D1 outage rather than a successful empty preview', async () => {
    const response = await dispatch(request(), {
      prepare() {
        throw new Error('synthetic_sql_infrastructure_private_details')
      }
    } as unknown as D1Database)
    expect(response?.status).toBe(503)
    privateHeaders(response)
    expect(await response!.text()).not.toContain('synthetic_sql_infrastructure_private_details')
  })
  it('proposes without changing stock, replays exactly and recovers only the same actor/hash', async () => {
    const before = inventoryState()
    const { input, receipt } = await propose()
    expect(receipt).toMatchObject({
      commandId: key,
      action: 'propose',
      expectedVersion: 0,
      version: 1,
      rowCount: 1,
      changedCount: 1,
      inventoryEffect: 'none',
      economicEffect: 'none'
    })
    expect(receipt.payloadHash).toBe(await inventoryCountImportIntentHash('propose', null, input))
    expect(inventoryState()).toEqual(before)
    const replay = await dispatch(request(input, {}, base))
    expect(replay?.status).toBe(201)
    expect(await replay!.json()).toEqual(receipt)
    const recovered = await read(base + '/commands/' + key, cookie, {
      'X-Neteco-Command-Payload-Hash': receipt.payloadHash
    })
    expect(recovered?.status).toBe(200)
    expect(await recovered!.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    const otherActor = await read(base + '/commands/' + key, reviewerCookie, {
      'X-Neteco-Command-Payload-Hash': receipt.payloadHash
    })
    expect(otherActor?.status).toBe(200)
    expect(await otherActor!.json()).toEqual({ source: 'cloudflare', outcome: 'unknown', receipt: null })
  })
  it('lists and reads the current proposal with explicit differences and another reviewer capability', async () => {
    const { receipt } = await propose()
    const list = await read(base + '?page=1&perPage=1')
    expect(list?.status).toBe(200)
    expect(await list!.json()).toMatchObject({
      source: 'cloudflare',
      page: 1,
      perPage: 1,
      total: 1,
      items: [{ importId: receipt.importId, proposedBy: claims.identityId, status: 'proposed' }]
    })
    const detail = await read(base + '/' + receipt.importId, reviewerCookie)
    expect(detail?.status).toBe(200)
    expect(await detail!.json()).toMatchObject({
      version: 1,
      capabilities: { approve: true },
      rows: [
        {
          physicalQuantity: 20,
          countedPhysicalQuantity: 18,
          physicalDelta: -2,
          currentBalanceVersion: 1,
          currentPhysicalQuantity: 20,
          stale: false
        }
      ]
    })
  })
  it('requires another authorized operator to approve and adjusts physical stock exactly once', async () => {
    const { receipt } = await propose()
    const body = { expectedVersion: 1, reason: 'Synthetic independent review of imported count' }
    const approvalKey = '80000000-0000-4000-8000-000000000011'
    const path = base + '/' + receipt.importId + '/approve'
    const self = await dispatch(request(body, { 'Idempotency-Key': approvalKey }, path))
    expect(self?.status).toBe(409)
    expect(await self!.json()).toEqual({ error: { code: 'approval_self' } })
    const approve = () => dispatch(request(body, { Cookie: reviewerCookie, 'Idempotency-Key': approvalKey }, path))
    const applied = await approve()
    expect(applied?.status).toBe(201)
    const result = await applied!.json()
    expect(result).toMatchObject({
      action: 'approve',
      importId: receipt.importId,
      expectedVersion: 1,
      version: 2,
      inventoryEffect: 'physical_adjustment',
      economicEffect: 'none'
    })
    const after = inventoryState()
    expect(fixture.sqlite.prepare('SELECT physical_quantity,version FROM inventory_balances').get()).toEqual({
      physical_quantity: 18,
      version: 2
    })
    const replay = await approve()
    expect(replay?.status).toBe(201)
    expect(await replay!.json()).toEqual(result)
    expect(inventoryState()).toEqual(after)
  })
  it('does not silently overwrite a balance changed after proposal', async () => {
    const { receipt } = await propose()
    await executeD1AdminInventoryCommand(
      fixture.database,
      claims,
      'receipt',
      { variantId: '11' },
      {
        expectedBalanceVersion: 1,
        quantity: 1,
        reason: 'Synthetic intervening physical receipt',
        reference: 'SYNTHETIC-STALE-010'
      },
      { idempotencyKey: '80000000-0000-4000-8000-000000000013' }
    )
    const before = inventoryState()
    const response = await dispatch(
      request(
        { expectedVersion: 1, reason: 'Synthetic independent count approval' },
        { Cookie: reviewerCookie, 'Idempotency-Key': '80000000-0000-4000-8000-000000000012' },
        base + '/' + receipt.importId + '/approve'
      )
    )
    expect(response?.status).toBe(409)
    expect(inventoryState()).toEqual(before)
    const detail = await read(base + '/' + receipt.importId, reviewerCookie)
    expect(await detail!.json()).toMatchObject({
      rows: [{ stale: true, currentBalanceVersion: 2, currentPhysicalQuantity: 21 }]
    })
  })
  it('rejects changed-body same-key replay instead of creating a second proposal', async () => {
    const { input } = await propose()
    const response = await dispatch(request({ ...input, reason: 'Different documented count justification' }, {}, base))
    expect(response?.status).toBe(409)
    expect(await response!.json()).toEqual({ error: { code: 'idempotency_conflict' } })
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM inventory_count_imports').get()!.n).toBe(1)
  })
  it('rejects excess CSV bytes and duplicate SKUs without allowing a partial proposal', async () => {
    const oversized = await dispatch(request({ csv: 'x'.repeat(65537) }))
    expect(oversized?.status).toBe(400)
    const duplicated = await dispatch(request({ csv: csv + '\nSYNTHETIC-SKU,19' }))
    expect(duplicated?.status).toBe(200)
    expect(await duplicated!.json()).toMatchObject({
      canPropose: false,
      rows: expect.arrayContaining([expect.objectContaining({ error: 'duplicate_sku' })])
    })
  })
})
