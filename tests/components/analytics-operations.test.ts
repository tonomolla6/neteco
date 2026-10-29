import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AnalyticsOperationsPanel from '../../app/components/AnalyticsOperationsPanel.vue'
import {
  ANALYTICS_DEFINITIONS,
  analyticsClientNameSchema,
  type AnalyticsSnapshot,
  type AnalyticsReconciliation
} from '../../shared/analytics-measurement'
import type { AnalyticsQuery } from '../../app/components/analytics/operations-ui'
import '#app/nuxt-vitest-app-entry'

const { read, sessionMock, post } = vi.hoisted(() => ({ read: vi.fn(), sessionMock: vi.fn(), post: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => read)
mockNuxtImport('useUserSession', () => sessionMock)
mockNuxtImport('$fetch', () => post)
const ACTOR = '10000000-0000-4000-8000-000000000052',
  OTHER = '20000000-0000-4000-8000-000000000052',
  ORDER = '30000000-0000-4000-8000-000000000052'
function uuid(index: number) {
  return `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}
function session() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref<{ id: string; emailVerified: boolean; mfaVerified: boolean } | null>({
      id: ACTOR,
      emailVerified: true,
      mfaVerified: true
    }),
    session: ref(null),
    clear: async () => undefined,
    fetch: async () => undefined,
    openInPopup: () => undefined
  }
}
function occurrence(query: AnalyticsQuery) {
  return new Date(Date.parse(query.from) + 3600000).toISOString().replace('.000Z', 'Z')
}
function snapshot(query: AnalyticsQuery, changes: Partial<AnalyticsSnapshot> = {}): AnalyticsSnapshot {
  const kinds = ['capture_applied', 'refund_confirmed', 'fiscal_issued'] as const
  return {
    schemaVersion: 'v1',
    source: 'cloudflare',
    generatedAt: query.to,
    policy: {
      reference: 'local-analytics-review',
      version: 'v1',
      purpose: 'first_party_measurement',
      retentionDays: 30
    },
    period: { from: query.from, to: query.to },
    population: { environment: 'local', validationOnly: true },
    coverage: {
      status: 'complete',
      streams: kinds.map((kind) => ({
        kind,
        sourceCount: 1,
        eligibleCount: 1,
        unconfirmedCount: 0,
        excludedCount: 0,
        projectedCount: 1,
        backlogCount: 0,
        oldestUnprojectedAt: null,
        provenance: 'persisted_contract'
      }))
    },
    metrics: {
      currency: 'EUR',
      grossCollectedCents: 12000,
      capturedOrders: 1,
      refundedCents: 3000,
      confirmedRefunds: 1,
      collectedAfterRefundsCents: 9000,
      issuedFiscalCents: 12000,
      issuedFiscalDocuments: 1,
      settlementCertified: false
    },
    browser: {
      eventCounts: analyticsClientNameSchema.options.map((name) => ({ name, count: 0 })),
      uniqueSessions: 0,
      financialAuthority: 'none'
    },
    definitions: ANALYTICS_DEFINITIONS.map((item) => ({ ...item })),
    facts: kinds.map((sourceKind, index) => ({
      sourceKind,
      sourceId: uuid(index + 1),
      orderId: ORDER,
      currency: 'EUR',
      grossCents: index === 1 ? 3000 : 12000,
      netCents: index === 1 ? 2500 : 10000,
      taxCents: index === 1 ? 500 : 2000,
      shippingGrossCents: 0,
      occurredAt: occurrence(query),
      projectedAt: occurrence(query),
      population: 'validation',
      sourceFingerprint: 'a'.repeat(64)
    })),
    pagination: { page: query.page, perPage: query.perPage, total: 3, pages: 1 },
    ...changes
  }
}
function reconciliation(
  query: AnalyticsQuery,
  changes: Partial<AnalyticsReconciliation> = {}
): AnalyticsReconciliation {
  return {
    schemaVersion: 'v1',
    source: 'cloudflare',
    generatedAt: query.to,
    policy: snapshot(query).policy,
    period: { from: query.from, to: query.to },
    population: { environment: 'local', validationOnly: true },
    readOnly: true,
    settlementCertified: false,
    summary: {
      sourceCount: 3,
      missingCount: 0,
      mismatchCount: 0,
      unconfirmedCount: 0,
      excludedCount: 0,
      projectionLagSeconds: null
    },
    issues: [],
    pagination: { page: query.page, perPage: query.perPage, total: 0, pages: 0 },
    ...changes
  }
}
function manyReconciliation(query: AnalyticsQuery): AnalyticsReconciliation {
  const offset = (query.page - 1) * query.perPage,
    count = Math.max(0, Math.min(query.perPage, 21 - offset))
  return reconciliation(query, {
    summary: {
      sourceCount: 21,
      missingCount: 21,
      mismatchCount: 0,
      unconfirmedCount: 0,
      excludedCount: 0,
      projectionLagSeconds: 60
    },
    issues: Array.from({ length: count }, (_, index) => ({
      code: 'missing',
      sourceKind: 'refund_confirmed',
      sourceId: uuid(100 + offset + index),
      occurredAt: occurrence(query),
      lagSeconds: 60,
      hint: 'projection_pending'
    })),
    pagination: { page: query.page, perPage: query.perPage, total: 21, pages: Math.ceil(21 / query.perPage) }
  })
}
function legacySnapshot(query: AnalyticsQuery) {
  const value = snapshot(query)
  return snapshot(query, {
    population: { environment: 'production', validationOnly: false },
    metrics: { ...value.metrics, grossCollectedCents: null, capturedOrders: null, collectedAfterRefundsCents: null },
    coverage: {
      status: 'partial',
      streams: value.coverage.streams.map((stream) =>
        stream.kind === 'capture_applied'
          ? {
              ...stream,
              eligibleCount: 0,
              unconfirmedCount: 1,
              projectedCount: 0,
              provenance: 'legacy_capture_unavailable'
            }
          : stream
      )
    },
    facts: value.facts
      .filter((fact) => fact.sourceKind !== 'capture_applied')
      .map((fact) => ({ ...fact, population: 'real' as const })),
    pagination: { page: query.page, perPage: query.perPage, total: 2, pages: 1 }
  })
}
function emptySnapshot(query: AnalyticsQuery) {
  const value = snapshot(query)
  return snapshot(query, {
    metrics: {
      currency: 'EUR',
      grossCollectedCents: 0,
      capturedOrders: 0,
      refundedCents: 0,
      confirmedRefunds: 0,
      collectedAfterRefundsCents: 0,
      issuedFiscalCents: 0,
      issuedFiscalDocuments: 0,
      settlementCertified: false
    },
    coverage: {
      status: 'complete',
      streams: value.coverage.streams.map((stream) => ({
        ...stream,
        sourceCount: 0,
        eligibleCount: 0,
        projectedCount: 0
      }))
    },
    facts: [],
    pagination: { page: query.page, perPage: query.perPage, total: 0, pages: 0 }
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
let actor: ReturnType<typeof session>
const wrappers: Array<{ unmount: () => void }> = []
beforeEach(() => {
  actor = session()
  sessionMock.mockImplementation(() => actor)
  read.mockReset()
  post.mockReset()
  read.mockImplementation(async (path, options) =>
    path === '/api/admin/analytics' ? snapshot(options.query) : reconciliation(options.query)
  )
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
})
async function mount(runtime: unknown = 'cloudflare') {
  const wrapper = await mountSuspended(AnalyticsOperationsPanel, { props: { runtime } })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
type Wrapper = Awaited<ReturnType<typeof mount>>
async function dates(wrapper: Wrapper, from: string, to: string) {
  await wrapper.get('#analytics-from').setValue(from)
  await wrapper.get('#analytics-to').setValue(to)
}

describe('D1 analytics UI confirmed reads and honest financial semantics', () => {
  it('labels promotional observations explicitly without giving them financial authority', async () => {
    read.mockImplementation(async (path, options) => {
      if (path !== '/api/admin/analytics') return reconciliation(options.query)
      const value = snapshot(options.query)
      return {
        ...value,
        browser: {
          ...value.browser,
          eventCounts: value.browser.eventCounts.map((event) => ({
            ...event,
            count: event.name === 'promotional_impression' ? 12 : event.name === 'promotional_click' ? 3 : 0
          }))
        }
      }
    })
    const wrapper = await mount()
    const browser = wrapper.get('[data-testid="analytics-browser"]')
    expect(browser.text()).toContain('Impresiones promocionales')
    expect(browser.text()).toContain('Clics en promociones')
    expect(browser.text()).toContain('Sin autoridad financiera')
    expect(browser.findAll('dt').every((label) => label.text().length > 0)).toBe(true)
    expect(post).not.toHaveBeenCalled()
  })

  it('uses only fresh GETs with canonical [from,to), strict pagination, no provider or projection command', async () => {
    const wrapper = await mount()
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls.map((call) => call[0]).sort()).toEqual([
      '/api/admin/analytics',
      '/api/admin/analytics/reconciliation'
    ])
    for (const [, options] of read.mock.calls) {
      expect(options).toMatchObject({ method: 'GET', retry: 0, cache: 'no-store', query: { page: 1, perPage: 20 } })
      expect(options.query.from).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/)
      expect(Date.parse(options.query.to) - Date.parse(options.query.from)).toBe(7 * 86400000)
      expect(Object.keys(options.query).sort()).toEqual(['from', 'page', 'perPage', 'to'])
    }
    expect(wrapper.get('[data-testid="analytics-provenance"]').text()).toContain('inicio incluido, final excluido')
    expect(post).not.toHaveBeenCalled()
  })
  it.each(['node', 'unknown', null])('never reads a foreign/unconfirmed runtime %s', async (runtime) => {
    const wrapper = await mount(runtime)
    expect(read).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="analytics-runtime-unavailable"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="analytics-money"]').exists()).toBe(false)
  })
  it.each(['ready', 'loggedIn', 'email', 'mfa', 'id'])(
    'requires current %s before issuing any read',
    async (missing) => {
      if (missing === 'ready') actor.ready.value = false
      if (missing === 'loggedIn') actor.loggedIn.value = false
      if (missing === 'email') actor.user.value!.emailVerified = false
      if (missing === 'mfa') actor.user.value!.mfaVerified = false
      if (missing === 'id') actor.user.value!.id = 'admin'
      const wrapper = await mount()
      expect(read).not.toHaveBeenCalled()
      expect(wrapper.get('[data-testid="analytics-auth-required"]').text()).toContain('servidor')
    }
  )
  it('separates gross, confirmed refunds and period difference in integer cents', async () => {
    const wrapper = await mount()
    expect(wrapper.get('[data-testid="analytics-gross"]').text()).toContain('120,00')
    expect(wrapper.get('[data-testid="analytics-refunded"]').text()).toContain('30,00')
    expect(wrapper.get('[data-testid="analytics-after-refunds"]').text()).toContain('90,00')
    expect(wrapper.get('[data-testid="analytics-validation-only"]').text()).toContain('No representan ventas reales')
    expect(wrapper.get('[data-testid="analytics-fiscal"]').text()).toContain('No es una venta')
    expect(wrapper.text()).toContain('NO ventas netas, margen ni liquidación bancaria')
  })
  it('keeps legacy production capture unknown, never fills unavailable money with zero', async () => {
    read.mockImplementation(async (path, options) =>
      path === '/api/admin/analytics'
        ? legacySnapshot(options.query)
        : reconciliation(options.query, { population: { environment: 'production', validationOnly: false } })
    )
    const wrapper = await mount()
    expect(wrapper.get('[data-testid="analytics-gross"]').text()).toBe('No disponible')
    expect(wrapper.get('[data-testid="analytics-after-refunds"]').text()).toBe('No disponible')
    expect(wrapper.get('[data-testid="analytics-partial"]').text()).toContain('Cobertura parcial')
    expect(wrapper.get('[data-testid="analytics-coverage"]').text()).toContain(
      'Procedencia histórica de captura no verificable'
    )
    expect(wrapper.find('[data-testid="analytics-validation-only"]').exists()).toBe(false)
  })
  it('renders a genuine confirmed empty population separately from unavailable observations', async () => {
    read.mockImplementation(async (path, options) =>
      path === '/api/admin/analytics' ? emptySnapshot(options.query) : reconciliation(options.query)
    )
    const wrapper = await mount()
    expect(wrapper.get('[data-testid="analytics-commerce-empty"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="analytics-browser-empty"]').text()).toContain('no demuestra ausencia de compras')
    expect(wrapper.get('[data-testid="analytics-reconciliation-empty"]').text()).toContain(
      'Sin excepciones confirmadas'
    )
    expect(wrapper.get('[data-testid="analytics-gross"]').text()).toContain('0,00')
    expect(wrapper.find('[data-testid="analytics-read-error"]').exists()).toBe(false)
  })
  it('does not derive finance or attributed conversions from browser checkout events', async () => {
    read.mockImplementation(async (path, options) => {
      if (path !== '/api/admin/analytics') return reconciliation(options.query)
      const value = snapshot(options.query)
      return snapshot(options.query, {
        browser: {
          ...value.browser,
          uniqueSessions: 5,
          eventCounts: value.browser.eventCounts.map((event) => ({
            ...event,
            count: event.name === 'checkout_started' ? 99 : 0
          }))
        }
      })
    })
    const wrapper = await mount()
    expect(wrapper.get('[data-testid="analytics-browser"]').text()).toContain('99')
    expect(wrapper.get('[data-testid="analytics-browser"]').text()).toContain(
      'Sin autoridad financiera ni conversiones atribuidas'
    )
    expect(wrapper.get('[data-testid="analytics-gross"]').text()).toContain('120,00')
  })
  it('shows loading, then failure without manufacturing an empty dashboard', async () => {
    const hold = deferred<unknown>()
    read.mockImplementation(async (path, options) =>
      path === '/api/admin/analytics' ? hold.promise : reconciliation(options.query)
    )
    const wrapper = await mount()
    expect(wrapper.get('[data-testid="analytics-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="analytics-money"]').exists()).toBe(false)
    hold.resolve(undefined)
    await flushPromises()
    expect(wrapper.get('[data-testid="analytics-read-error"]').text()).toContain('no equivale a actividad cero')
    expect(wrapper.find('[data-testid="analytics-commerce-empty"]').exists()).toBe(false)
  })
  it('rejects unknown/PII fields and never renders transport error messages', async () => {
    read.mockImplementation(async (path, options) => {
      if (path === '/api/admin/analytics')
        return { ...snapshot(options.query), email: 'PRIVATE_PII_SENTINEL@example.test' }
      throw new Error('PRIVATE_BODY_SENTINEL')
    })
    const wrapper = await mount()
    expect(wrapper.get('[data-testid="analytics-read-error"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="analytics-reconciliation-error"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('PRIVATE_')
  })
  it('rejects a summary from a different range', async () => {
    read.mockImplementation(async (path, options) =>
      path === '/api/admin/analytics'
        ? snapshot({ ...options.query, from: '2000-01-01T00:00:00Z' })
        : reconciliation(options.query)
    )
    const wrapper = await mount()
    expect(wrapper.get('[data-testid="analytics-read-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="analytics-money"]').exists()).toBe(false)
  })
  it('rejects a reconciliation from a different page instead of calling it empty', async () => {
    read.mockImplementation(async (path, options) =>
      path === '/api/admin/analytics' ? snapshot(options.query) : reconciliation({ ...options.query, page: 2 })
    )
    const wrapper = await mount()
    expect(wrapper.get('[data-testid="analytics-reconciliation-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="analytics-reconciliation-empty"]').exists()).toBe(false)
  })
  it.each(['population', 'policy'])(
    'does not combine independently valid readings with different %s',
    async (mismatch) => {
      read.mockImplementation(async (path, options) => {
        if (path === '/api/admin/analytics') return snapshot(options.query)
        return reconciliation(
          options.query,
          mismatch === 'population'
            ? { population: { environment: 'preview', validationOnly: true } }
            : { policy: { ...snapshot(options.query).policy, version: 'v2' } }
        )
      })
      const wrapper = await mount()
      expect(wrapper.get('[data-testid="analytics-context-error"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="analytics-money"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="analytics-issues"]').exists()).toBe(false)
    }
  )
  it('clears facts on draft range change and reads only after explicit valid submission', async () => {
    const wrapper = await mount()
    await dates(wrapper, '2026-01-01', '2026-02-01')
    expect(wrapper.find('[data-testid="analytics-money"]').exists()).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(read).toHaveBeenCalledTimes(4)
    expect(read.mock.calls.at(-1)?.[1].query).toEqual({
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
      page: 1,
      perPage: 20
    })
  })
  it('does not read an invalid overlong range', async () => {
    const wrapper = await mount()
    await dates(wrapper, '2026-01-01', '2026-02-02')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(read).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="analytics-range-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="analytics-money"]').exists()).toBe(false)
  })
  it('range change discards an old in-flight response instead of restoring old-period money', async () => {
    const wrapper = await mount(),
      hold = deferred<unknown>()
    let oldQuery!: AnalyticsQuery
    read.mockImplementation(async (path, options) => {
      if (path !== '/api/admin/analytics') return reconciliation(options.query)
      oldQuery = options.query
      return hold.promise
    })
    await wrapper.get('[data-testid="analytics-refresh"]').trigger('click')
    await flushPromises()
    await dates(wrapper, '2026-01-01', '2026-01-08')
    read.mockImplementation(async (path, options) =>
      path === '/api/admin/analytics' ? snapshot(options.query) : reconciliation(options.query)
    )
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    hold.resolve(snapshot(oldQuery, { policy: { ...snapshot(oldQuery).policy, reference: 'OLD_RANGE_SENTINEL' } }))
    await flushPromises()
    expect(wrapper.get('[data-testid="analytics-provenance"]').text()).toContain('2026-01-01T00:00:00Z')
    expect(wrapper.text()).not.toContain('OLD_RANGE_SENTINEL')
  })
  it('MFA loss clears private observations and regaining MFA requires new server reads', async () => {
    const wrapper = await mount()
    actor.user.value!.mfaVerified = false
    await flushPromises()
    expect(wrapper.find('[data-testid="analytics-provenance"]').exists()).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
    actor.user.value!.mfaVerified = true
    await flushPromises()
    expect(read).toHaveBeenCalledTimes(4)
    expect(wrapper.get('[data-testid="analytics-provenance"]').exists()).toBe(true)
  })
  it('manual refresh is single-flight and clears old metrics during the wait', async () => {
    const wrapper = await mount(),
      hold = deferred<unknown>()
    let heldQuery!: AnalyticsQuery
    read.mockImplementation(async (path, options) => {
      if (path !== '/api/admin/analytics') return reconciliation(options.query)
      heldQuery = options.query
      return hold.promise
    })
    await wrapper.get('[data-testid="analytics-refresh"]').trigger('click')
    await wrapper.get('[data-testid="analytics-refresh"]').trigger('click')
    await flushPromises()
    expect(read).toHaveBeenCalledTimes(4)
    expect(wrapper.find('[data-testid="analytics-money"]').exists()).toBe(false)
    hold.resolve(snapshot(heldQuery))
    await flushPromises()
    expect(wrapper.get('[data-testid="analytics-money"]').exists()).toBe(true)
  })
  it('logout discards a late private response and all prior facts', async () => {
    const wrapper = await mount(),
      hold = deferred<unknown>()
    let heldQuery!: AnalyticsQuery
    read.mockImplementation(async (path, options) => {
      if (path !== '/api/admin/analytics') return reconciliation(options.query)
      heldQuery = options.query
      return hold.promise
    })
    await wrapper.get('[data-testid="analytics-refresh"]').trigger('click')
    await flushPromises()
    actor.loggedIn.value = false
    actor.user.value = null
    hold.resolve(snapshot(heldQuery))
    await flushPromises()
    expect(wrapper.get('[data-testid="analytics-auth-required"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('local-analytics-review')
  })
  it('actor change discards old results and obtains fresh facts for the new session', async () => {
    const wrapper = await mount(),
      hold = deferred<unknown>()
    let heldQuery!: AnalyticsQuery
    read.mockImplementation(async (path, options) => {
      if (path === '/api/admin/analytics' && actor.user.value?.id === ACTOR) {
        heldQuery = options.query
        return hold.promise
      }
      const policy = { ...snapshot(options.query).policy, reference: 'new-actor-policy' }
      return path === '/api/admin/analytics'
        ? snapshot(options.query, { policy })
        : reconciliation(options.query, { policy })
    })
    await wrapper.get('[data-testid="analytics-refresh"]').trigger('click')
    await flushPromises()
    actor.user.value!.id = OTHER
    await flushPromises()
    hold.resolve(snapshot(heldQuery, { policy: { ...snapshot(heldQuery).policy, reference: 'old-actor-sentinel' } }))
    await flushPromises()
    expect(wrapper.text()).toContain('new-actor-policy')
    expect(wrapper.text()).not.toContain('old-actor-sentinel')
  })
  it('an old actor denial cannot invalidate a new actor current confirmed reading', async () => {
    const wrapper = await mount(),
      hold = deferred<unknown>()
    read.mockImplementation(async (path, options) =>
      path === '/api/admin/analytics' && actor.user.value?.id === ACTOR
        ? hold.promise
        : path === '/api/admin/analytics'
          ? snapshot(options.query)
          : reconciliation(options.query)
    )
    await wrapper.get('[data-testid="analytics-refresh"]').trigger('click')
    await flushPromises()
    actor.user.value!.id = OTHER
    await flushPromises()
    hold.reject({ statusCode: 403 })
    await flushPromises()
    expect(wrapper.find('[data-testid="analytics-access-denied"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="analytics-money"]').exists()).toBe(true)
  })
  it('runtime change clears facts and a late response never restores a Cloudflare panel in Node', async () => {
    const wrapper = await mount(),
      hold = deferred<unknown>()
    let heldQuery!: AnalyticsQuery
    read.mockImplementation(async (path, options) => {
      heldQuery = options.query
      return hold.promise
    })
    await wrapper.get('[data-testid="analytics-refresh"]').trigger('click')
    await flushPromises()
    await wrapper.setProps({ runtime: 'node' })
    hold.resolve(snapshot(heldQuery))
    await flushPromises()
    expect(wrapper.get('[data-testid="analytics-runtime-unavailable"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="analytics-money"]').exists()).toBe(false)
  })
  it('a current live server denial invalidates both sections and needs an explicit fresh GET', async () => {
    const wrapper = await mount()
    read.mockImplementation(async () => {
      throw { statusCode: 403 }
    })
    await wrapper.get('[data-testid="analytics-refresh"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="analytics-access-denied"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="analytics-money"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="analytics-reconciliation-summary"]').exists()).toBe(false)
    const count = read.mock.calls.length
    await flushPromises()
    expect(read).toHaveBeenCalledTimes(count)
    read.mockImplementation(async (path, options) =>
      path === '/api/admin/analytics' ? snapshot(options.query) : reconciliation(options.query)
    )
    await wrapper.get('[data-testid="analytics-refresh"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="analytics-money"]').exists()).toBe(true)
  })
  it('paginates exceptions with the same range and does not recompute or refetch headline metrics', async () => {
    read.mockImplementation(async (path, options) =>
      path === '/api/admin/analytics' ? snapshot(options.query) : manyReconciliation(options.query)
    )
    const wrapper = await mount()
    expect(wrapper.get('[data-testid="analytics-issues"]').text()).toContain(uuid(100))
    await wrapper.get('[data-testid="analytics-next"]').trigger('click')
    await flushPromises()
    expect(read).toHaveBeenCalledTimes(3)
    expect(read.mock.calls.at(-1)?.[1].query.page).toBe(2)
    expect(wrapper.get('[data-testid="analytics-issues"]').text()).toContain(uuid(120))
    expect(wrapper.get('[data-testid="analytics-issues"]').text()).not.toContain(uuid(100))
    expect(wrapper.get('[data-testid="analytics-gross"]').text()).toContain('120,00')
    expect(wrapper.get('[data-testid="analytics-next"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="analytics-issues"]').text()).toContain('esta pantalla no la ejecuta')
    expect(post).not.toHaveBeenCalled()
  })
  it('a failed exception refresh is an error, never an artificial no-exceptions result', async () => {
    const wrapper = await mount()
    read.mockRejectedValueOnce(new Error('storage_unconfirmed'))
    await wrapper.get('[data-testid="analytics-reconciliation-refresh"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="analytics-reconciliation-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="analytics-reconciliation-empty"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="analytics-money"]').exists()).toBe(true)
  })
})
