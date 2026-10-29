import { describe, expect, it, vi } from 'vitest'
import { auditNativeOrderTimeline } from '../../scripts/lib/audit-native-order-timeline'
import { encodeOrderTimelineCursor } from '../../shared/order-timeline'

// Acceptance-helper boundary only: no assertion here is live workerd evidence.
const orderId = '10000000-0000-4000-8000-000000000001'
function guarded() {
  const dispatch = vi.fn(async () => {
    throw new Error('unexpected dispatch')
  })
  const prepare = vi.fn(() => {
    throw new Error('unexpected SQL')
  })
  return {
    dispatch,
    prepare,
    input: {
      dispatch,
      database: { prepare } as unknown as D1Database,
      origin: 'https://shop-audit.neteco.test',
      orderId,
      customerCookie: 'session=owner',
      adminCookie: 'session=admin',
      wrongOwnerCookie: 'session=other'
    }
  }
}
function boundary() {
  const events = [
    { id: 'payment:p1', kind: 'payment', state: 'captured', createdAt: '2026-10-08T10:01:00Z', validationOnly: null },
    { id: 'checkout:c1', kind: 'checkout', state: 'created', createdAt: '2026-10-08T10:00:00Z', validationOnly: null }
  ]
  const state = { violation: '', missingOrder: false, changedCounts: false, changedMetadata: false }
  let snapshots = 0
  const sqlSeen: string[] = []
  const prepare = vi.fn((sql: string) => {
    sqlSeen.push(sql)
    if (!/^SELECT\b/u.test(sql)) throw new Error('Mutation forbidden')
    let values: unknown[] = []
    const statement = {
      bind: (...args: unknown[]) => {
        values = args
        return statement
      },
      first: async () => {
        if (sql.startsWith('SELECT id, status')) return state.missingOrder ? null : { id: orderId }
        if (sql === 'SELECT id FROM orders WHERE id = ?') return values[0] === orderId ? { id: orderId } : null
        snapshots++
        return Object.fromEntries(
          [...sql.matchAll(/ AS ([a-z_]+)/gu)].map((match) => [match[1]!, state.changedCounts && snapshots > 1 ? 2 : 1])
        )
      },
      all: async () => ({
        success: true,
        results: sql.includes('AS kind')
          ? sql.includes("'checkout' AS kind")
            ? [events[1]]
            : sql.includes("'payment' AS kind")
              ? [events[0]]
              : []
          : [{ metadata: state.changedMetadata && snapshots > 1 ? 'changed' : 'unchanged' }]
      })
    }
    return statement
  })
  const dispatch = vi.fn(async (request: Request) => {
    expect(request.method).toBe('GET')
    const url = new URL(request.url),
      cookie = request.headers.get('cookie')
    expect(url.origin).toBe(guarded().input.origin)
    const headers: Record<string, string> = { 'cache-control': 'private, no-store' }
    if (state.violation === 'cache') headers['cache-control'] = 'public, max-age=300'
    if (state.violation === 'cookie') headers['set-cookie'] = 'session=new'
    const error = (code: string, status: number) => Response.json({ error: { code } }, { headers, status })
    if (!cookie) return error('unauthenticated', 401)
    if (url.pathname.includes('/admin/') && cookie === 'session=owner')
      return error(state.violation === 'mfa' ? 'mfa_required' : 'forbidden', 403)
    if (cookie === 'session=other' || !url.pathname.includes(orderId)) return error('not_found', 404)
    if (url.searchParams.get('cursor') === '!invalid') return error('invalid_input', 400)
    const audience = url.pathname.includes('/admin/') ? 'admin' : 'customer'
    const limit = Number(url.searchParams.get('limit'))
    const offset = url.searchParams.has('cursor') ? 1 : 0
    const items: Record<string, unknown>[] = structuredClone(limit === 1 ? events.slice(offset, offset + 1) : events)
    if (state.violation === 'forged') items[0]!.id = 'payment:forged'
    if (state.violation === 'privacy') items[0]!.actorId = 'private-actor'
    if (state.violation === 'stage') items[0]!.state = 'future_delivery'
    if (state.violation === 'empty') items.splice(0)
    const nextCursor =
      limit === 1 && offset === 0
        ? encodeOrderTimelineCursor({
            v: 1,
            orderId,
            audience,
            asOf: '2026-10-08T11:00:00Z',
            at: events[0]!.createdAt,
            id: events[0]!.id
          })
        : null
    return Response.json(
      {
        source: 'cloudflare',
        orderId: state.violation === 'order' ? '20000000-0000-4000-8000-000000000002' : orderId,
        audience,
        items,
        nextCursor
      },
      { headers }
    )
  })
  return {
    state,
    dispatch,
    sqlSeen,
    input: { ...guarded().input, dispatch, database: { prepare } as unknown as D1Database }
  }
}
describe('native order-timeline helper boundary, not live acceptance', () => {
  it('keeps the exact configured MFA denial for a customer without administrative MFA', async () => {
    const fixture = boundary()
    fixture.state.violation = 'mfa'
    await expect(
      auditNativeOrderTimeline({ ...fixture.input, customerAdminDenial: 'mfa_required' })
    ).resolves.toMatchObject({ scenarios: 7 })
  })
  it('runs seven assertions with real-schema cursor pages on a synthetic boundary only', async () => {
    const fixture = boundary()
    const result = await auditNativeOrderTimeline(fixture.input)
    expect(result).toMatchObject({
      scenarios: 7,
      sourceKinds: ['checkout', 'payment'],
      countsUnchanged: true,
      fixtureDigestsUnchanged: true,
      globalRowsWrittenProof: false,
      productionAcceptance: false,
      outboundNetworkGate: 'caller_owned'
    })
    expect(fixture.sqlSeen.every((sql) => /^SELECT\b/u.test(sql))).toBe(true)
    expect(fixture.dispatch).toHaveBeenCalledTimes(9)
  })
  it('rejects absent durable order before dispatch', async () => {
    const fixture = boundary()
    fixture.state.missingOrder = true
    await expect(auditNativeOrderTimeline(fixture.input)).rejects.toThrow()
    expect(fixture.dispatch).not.toHaveBeenCalled()
  })
  it.each(['forged', 'privacy', 'stage', 'empty', 'order', 'cache', 'cookie'])(
    'refuses %s instead of accepting plausible timeline data',
    async (violation) => {
      const fixture = boundary()
      fixture.state.violation = violation
      await expect(auditNativeOrderTimeline(fixture.input)).rejects.toThrow()
    }
  )
  it.each(['changedCounts', 'changedMetadata'] as const)('detects %s', async (key) => {
    const fixture = boundary()
    fixture.state[key] = true
    await expect(auditNativeOrderTimeline(fixture.input)).rejects.toThrow()
  })
  it.each(['https://neteco.es', 'http://shop-audit.neteco.test', 'https://shop-audit.neteco.test/path', 'invalid'])(
    'rejects unsafe origin %s before SQL/dispatch',
    async (origin) => {
      const fixture = guarded()
      await expect(auditNativeOrderTimeline({ ...fixture.input, origin })).rejects.toThrow()
      expect(fixture.dispatch).not.toHaveBeenCalled()
      expect(fixture.prepare).not.toHaveBeenCalled()
    }
  )
  it.each(['', 'not-uuid', '../orders', '10000000-0000-4000-8000-000000000001?x=1'])(
    'rejects invalid orderId %s before SQL/dispatch',
    async (orderId) => {
      const fixture = guarded()
      await expect(auditNativeOrderTimeline({ ...fixture.input, orderId })).rejects.toThrow()
      expect(fixture.dispatch).not.toHaveBeenCalled()
      expect(fixture.prepare).not.toHaveBeenCalled()
    }
  )
  it.each(['customerCookie', 'adminCookie', 'wrongOwnerCookie'] as const)(
    'rejects unsafe %s before SQL/dispatch',
    async (key) => {
      const fixture = guarded()
      await expect(auditNativeOrderTimeline({ ...fixture.input, [key]: 'session=bad\r\nx: 1' })).rejects.toThrow()
      expect(fixture.dispatch).not.toHaveBeenCalled()
      expect(fixture.prepare).not.toHaveBeenCalled()
    }
  )
})
