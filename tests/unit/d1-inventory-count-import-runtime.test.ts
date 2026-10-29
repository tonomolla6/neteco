import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { INVENTORY_COORDINATOR_NAME, InventoryCoordinator } from '../../workers/inventory-coordinator'
import { canonicalJson, sha256Hex } from '../../workers/catalog/inventory'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION,
  openAdminInventoryFixture
} from '../support/admin-inventory-fixture'

const origin = 'https://count-runtime.neteco.test'
const password = 'synthetic-count-runtime-cookie-more-than-32'
const base = '/api/admin/inventory/count-imports'
const claims = { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 }
const key = '70000000-0000-4000-8000-000000000041'
const approvalKey = '70000000-0000-4000-8000-000000000042'
const csv = 'sku,countedPhysicalQuantity\nSYNTHETIC-SKU,18'

function storageFixture() {
  const values = new Map<string, unknown>()
  return {
    get: vi.fn(async (id: string) => values.get(id)),
    put: vi.fn(async (id: string, value: unknown) => {
      values.set(id, structuredClone(value))
    }),
    list: vi.fn(async () => new Map(values)),
    getAlarm: vi.fn(async () => null),
    setAlarm: vi.fn(async () => undefined),
    deleteAlarm: vi.fn(async () => undefined)
  }
}

describe('count imports through the actual canary and global inventory coordinator', () => {
  let fixture: Awaited<ReturnType<typeof openAdminInventoryFixture>>
  let storage: ReturnType<typeof storageFixture>
  let coordinator: InventoryCoordinator
  let env: CloudflareEnv
  let cookie: string
  let reviewerCookie: string
  let forward: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    fixture = await openAdminInventoryFixture()
    fixture.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0077_inventory_count_imports.sql', import.meta.url), 'utf8')
    )
    storage = storageFixture()
    coordinator = new InventoryCoordinator(
      { storage } as unknown as DurableObjectState,
      { DB: fixture.database } as CloudflareEnv
    )
    forward = vi.fn(async (url: string, init: RequestInit) => coordinator.fetch(new Request(url, init)))
    env = {
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-count-runtime-pepper-more-than-32',
      DB: fixture.database,
      ADMIN_EDGE_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
      INVENTORY: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => ({ fetch: forward })) }
    } as unknown as CloudflareEnv
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

  function dispatch(path: string, body?: unknown, credential = cookie, idempotencyKey = key) {
    return worker.fetch(
      new Request(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: credential,
          Origin: origin,
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '192.0.2.41',
          'Idempotency-Key': idempotencyKey
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      env
    )
  }
  function internal(body: unknown) {
    return coordinator.fetch(
      new Request('https://inventory.internal/command', { method: 'POST', body: JSON.stringify(body) })
    )
  }
  function command(extra: Record<string, unknown> = {}) {
    return {
      type: 'inventory_count_import',
      claims,
      action: 'propose',
      targetId: null,
      input: {
        csv,
        previewHash: 'a'.repeat(64),
        reason: 'Synthetic physical inventory count',
        reference: 'COUNT-RUNTIME-041'
      },
      idempotencyKey: key,
      ...extra
    }
  }

  it('previews read-only and persists/approves/replays one real ledger adjustment through the same global DO', async () => {
    const preview = await dispatch(base + '/preview', { csv })
    expect(preview.status).toBe(200)
    expect(forward).not.toHaveBeenCalled()
    const input = {
      csv,
      previewHash: ((await preview.json()) as { previewHash: string }).previewHash,
      reason: 'Synthetic physical inventory count',
      reference: 'COUNT-RUNTIME-041'
    }
    const proposed = await dispatch(base, input)
    expect(proposed.status).toBe(201)
    const receipt = (await proposed.json()) as { importId: string }
    expect(fixture.sqlite.prepare('SELECT physical_quantity FROM inventory_balances').get()?.physical_quantity).toBe(20)
    expect(env.INVENTORY.idFromName).toHaveBeenCalledWith(INVENTORY_COORDINATOR_NAME)
    const approved = await dispatch(
      `${base}/${receipt.importId}/approve`,
      {
        expectedVersion: 1,
        reason: 'Synthetic independent warehouse verification'
      },
      reviewerCookie,
      approvalKey
    )
    expect(approved.status).toBe(201)
    const text = await approved.text()
    const replay = await dispatch(
      `${base}/${receipt.importId}/approve`,
      {
        expectedVersion: 1,
        reason: 'Synthetic independent warehouse verification'
      },
      reviewerCookie,
      approvalKey
    )
    expect(replay.status).toBe(201)
    expect(await replay.text()).toBe(text)
    expect(fixture.sqlite.prepare('SELECT physical_quantity,version FROM inventory_balances').get()).toEqual({
      physical_quantity: 18,
      version: 2
    })
    expect(
      fixture.sqlite
        .prepare("SELECT count(*) AS n FROM inventory_movements WHERE reference_type='inventory_count_import'")
        .get()?.n
    ).toBe(1)
    expect(storage.get).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
    expect(forward).toHaveBeenCalledTimes(3)
    const detail = await dispatch(`${base}/${receipt.importId}`, undefined, reviewerCookie)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({ source: 'cloudflare', status: 'approved', version: 2 })
    expect(forward).toHaveBeenCalledTimes(3)
  })

  it('rejects an injected cache commandId instead of returning a forged privileged receipt', async () => {
    const body = command({ commandId: 'forged-count-response' })
    await storage.put('cmd:forged-count-response', {
      commandHash: await sha256Hex(canonicalJson(body)),
      status: 201,
      body: { forged: true }
    })
    storage.put.mockClear()
    const response = await internal(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'invalid_input' } })
    expect(storage.get).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })

  it.each([
    { claims: { ...claims, sessionVersion: 0 } },
    { targetId: '70000000-0000-4000-8000-000000000099' },
    { action: 'approve', targetId: null },
    {
      input: { csv, previewHash: 'a'.repeat(64), reason: 'Synthetic count', reference: 'COUNT', physicalQuantity: 999 }
    }
  ])('rejects malformed privileged commands without touching the database: %j', async (extra) => {
    const prepare = vi.spyOn(fixture.database, 'prepare')
    const response = await internal(command(extra))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'invalid_input' } })
    expect(prepare).not.toHaveBeenCalled()
    expect(storage.get).not.toHaveBeenCalled()
  })

  it('re-authorizes an exact durable replay after the live write grant is revoked', async () => {
    const preview = await dispatch(base + '/preview', { csv })
    expect(preview.status).toBe(200)
    const body = command({
      input: {
        csv,
        previewHash: ((await preview.json()) as { previewHash: string }).previewHash,
        reason: 'Synthetic physical inventory count',
        reference: 'COUNT-RUNTIME-041'
      }
    })
    expect((await internal(body)).status).toBe(201)
    fixture.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(claims.identityId)
    const replay = await internal(body)
    expect(replay.status).toBe(403)
    expect(await replay.json()).toEqual({ error: { code: 'forbidden' } })
    expect(storage.get).not.toHaveBeenCalled()
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM inventory_count_import_commands').get()?.n).toBe(1)
  })

  it('sanitizes a D1 outage at the privileged coordinator boundary', async () => {
    vi.spyOn(fixture.database, 'prepare').mockImplementation(() => {
      throw new Error('SECRET-SQL-INTERNALS')
    })
    const response = await internal(command())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })

  it.each([base, base + '/preview', '/api/admin/inventory/%63ount-imports/preview'])(
    'fails closed with auth disabled at %s',
    async (path) => {
      env.AUTH_ENABLED = 'false'
      const response = await dispatch(path, { csv })
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(forward).not.toHaveBeenCalled()
    }
  )
})
