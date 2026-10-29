import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/AdminAuditPanel.vue'
import {
  adminAuditListSchema,
  adminAuditDetailSchema,
  adminAuditReceiptSchema,
  adminAuditReviewInputSchema,
  adminAuditExportInputSchema,
  adminAuditIntentHash,
  adminAuditHash,
  adminAuditFilterHash,
  ADMIN_AUDIT_EXPORT_COLUMNS,
  ADMIN_AUDIT_EXPORT_FILENAME,
  ADMIN_AUDIT_EXPORT_CONTENT_TYPE,
  ADMIN_AUDIT_EXPORT_HEADERS,
  type AdminAuditReceipt
} from '../../shared/admin-audit'
import { csvCell } from '../../server/utils/csv'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  raw: vi.fn(),
  session: vi.fn(),
  navigation: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => Object.assign(mocks.request, { raw: mocks.raw }))
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: mocks.navigation }))
const actor = '10000000-0000-4000-8000-000000000084',
  sid = '20000000-0000-4000-8000-000000000084',
  eventId = 'inventory:30000000-0000-4000-8000-000000000084',
  commandId = '40000000-0000-4000-8000-000000000084',
  now = '2026-10-09T20:00:00Z',
  endpoint = '/api/admin/audit',
  detailPath = `${endpoint}/${encodeURIComponent(eventId)}`
const permission = ref(true)
function session() {
  return {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: actor, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: sid, sessionVersion: 1 })
  }
}
let auth: ReturnType<typeof session>,
  snapshot: ReturnType<typeof adminAuditListSchema.parse>,
  detail: ReturnType<typeof adminAuditDetailSchema.parse>,
  receipt: AdminAuditReceipt | null
let createUrl: ReturnType<typeof vi.fn>, revokeUrl: ReturnType<typeof vi.fn>
const mounted: Awaited<ReturnType<typeof mountSuspended>>[] = []
type Options = { method?: string; body?: unknown; headers?: Record<string, string>; query?: Record<string, unknown> }
const posts = () => mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
function row() {
  return {
    id: eventId,
    family: 'inventory',
    action: 'count_approve',
    createdAt: now,
    actorId: actor,
    resourceId: 'variant-1',
    commandId,
    sessionId: null,
    ipHash: null,
    reason: 'redacted',
    before: 'redacted',
    after: 'redacted',
    reviewVersion: 0,
    disposition: null
  }
}
function csv() {
  return (
    '\uFEFF' +
    [
      ADMIN_AUDIT_EXPORT_COLUMNS.map(csvCell).join(','),
      ADMIN_AUDIT_EXPORT_COLUMNS.map((key) => csvCell(row()[key] ?? '')).join(',')
    ].join('\r\n') +
    '\r\n'
  )
}
beforeEach(() => {
  auth = session()
  permission.value = true
  receipt = null
  snapshot = adminAuditListSchema.parse({
    source: 'cloudflare',
    items: [row()],
    nextCursor: null,
    evaluatedAt: now,
    coverage: {
      families: ['inventory'],
      historicalNetworkMetadata: 'only_when_recorded',
      excluded: ['customer_self_service', 'automated_provider_events', 'application_logs']
    }
  })
  detail = adminAuditDetailSchema.parse({
    source: 'cloudflare',
    item: row(),
    reviews: [],
    evaluatedAt: now,
    changes: [{ field: 'physicalQuantity', before: 0, after: 7 }],
    changesAvailability: 'recorded'
  })
  mocks.session.mockReturnValue(auth)
  mocks.navigation.mockReturnValue({
    status: ref('ready'),
    capabilities: computed(() => ({
      state: 'ready',
      identityId: auth.user.value.id,
      sessionId: auth.session.value.sessionId,
      sessionVersion: auth.session.value.sessionVersion,
      permissions: permission.value ? ['administration.manage'] : []
    }))
  })
  mocks.request.mockReset().mockImplementation(async (path: string, options: Options) => {
    if (options.method === 'POST' && path.endsWith('/reviews')) {
      const input = adminAuditReviewInputSchema.parse(options.body)
      receipt = adminAuditReceiptSchema.parse({
        source: 'cloudflare',
        action: 'review',
        commandId: options.headers!['Idempotency-Key'],
        eventId,
        version: input.expectedVersion + 1,
        disposition: input.disposition,
        payloadHash: await adminAuditIntentHash('review', eventId, input),
        recordedAt: now
      })
      detail = {
        ...detail,
        item: { ...detail.item, reviewVersion: receipt.version, disposition: receipt.disposition },
        reviews: [
          {
            commandId: receipt.commandId,
            actorId: actor,
            version: receipt.version,
            disposition: receipt.disposition,
            recordedAt: now,
            reason: 'redacted'
          }
        ]
      }
      return receipt
    }
    if (options.method === 'POST' && path.endsWith('/exports')) {
      const input = adminAuditExportInputSchema.parse(options.body),
        text = csv()
      receipt = adminAuditReceiptSchema.parse({
        source: 'cloudflare',
        action: 'export',
        commandId: options.headers!['Idempotency-Key'],
        payloadHash: await adminAuditIntentHash('export', null, input),
        recordedAt: now,
        rows: 1,
        bytes: new TextEncoder().encode(text).byteLength,
        digest: await adminAuditHash(text),
        filterHash: await adminAuditFilterHash(input.filters),
        expiresAt: '2026-10-10T20:00:00Z'
      })
      return receipt
    }
    if (path.includes('/commands/'))
      return receipt
        ? { source: 'cloudflare', outcome: 'applied', receipt }
        : { source: 'cloudflare', outcome: 'unknown', receipt: null }
    if (path === detailPath) return detail
    return snapshot
  })
  mocks.raw.mockReset().mockImplementation(async () => {
    if (receipt?.action !== 'export') throw Error('unconfirmed_export')
    const buffer = new TextEncoder().encode(csv()).buffer
    return {
      status: 200,
      ok: true,
      _data: buffer,
      headers: new Headers({
        'Content-Type': ADMIN_AUDIT_EXPORT_CONTENT_TYPE,
        'Content-Disposition': `attachment; filename="${ADMIN_AUDIT_EXPORT_FILENAME}"`,
        'Cache-Control': 'private, no-store',
        [ADMIN_AUDIT_EXPORT_HEADERS.source]: 'cloudflare',
        [ADMIN_AUDIT_EXPORT_HEADERS.rows]: String(receipt.rows),
        [ADMIN_AUDIT_EXPORT_HEADERS.bytes]: String(receipt.bytes),
        [ADMIN_AUDIT_EXPORT_HEADERS.digest]: receipt.digest
      })
    }
  })
  createUrl = vi.fn(() => 'blob:synthetic-admin-audit')
  revokeUrl = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }))
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function render(props = {}) {
  const w = await mountSuspended(Panel, {
    props: { scopeKey: 'audit-current', enabled: true, pending: false, ...props }
  })
  mounted.push(w)
  await flushPromises()
  return w
}
type Wrapper = Awaited<ReturnType<typeof render>>
async function load(w: Wrapper) {
  await w.get('[data-audit-load]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-audit-list]').exists()).toBe(true))
}
async function open(w: Wrapper) {
  await load(w)
  await w.get(`[data-audit-open="${eventId}"]`).trigger('click')
  await vi.waitFor(() => expect(w.find('[data-audit-detail]').exists()).toBe(true))
}
async function review(w: Wrapper) {
  await open(w)
  await w.get('[data-audit-disposition]').setValue('follow_up')
  await w.get('[data-audit-review-reason]').setValue('Synthetic private reason reviewed by the operator')
  await new DOMWrapper(w.get('[data-audit-review]').element.closest('form')!).trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-audit-confirm]').exists()).toBe(true))
}
async function exportReview(w: Wrapper) {
  await load(w)
  await w.get('[data-audit-export-reason]').setValue('Synthetic explicitly reviewed private CSV export')
  await new DOMWrapper(w.get('[data-audit-export-review]').element.closest('form')!).trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-audit-confirm]').exists()).toBe(true))
}
async function confirm(w: Wrapper) {
  await w.get('[data-audit-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-audit-confirmed]').exists()).toBe(true))
}
it('reads explicitly and displays bounded coverage and unknown network facts without mutating', async () => {
  const w = await render()
  expect(mocks.request).not.toHaveBeenCalled()
  await open(w)
  expect(posts()).toHaveLength(0)
  expect(mocks.raw).not.toHaveBeenCalled()
  expect(w.text()).toContain('UTC')
  expect(w.text()).toContain('No registrado')
  expect(w.text()).toContain('Redactado')
  expect(w.text()).toContain('Fuentes incluidas')
  expect(w.get('[data-audit-detail]').text()).toContain('0')
  expect(w.get('[data-audit-detail]').text()).toContain('7')
  expect(mocks.request.mock.calls.some(([path]) => path === detailPath)).toBe(true)
})
it.each([{ enabled: false }, { pending: true }, { scopeKey: '' }])(
  'does not request with inactive context %j',
  async (props) => {
    const w = await render(props)
    if (w.find('[data-audit-load]').exists()) await w.get('[data-audit-load]').trigger('click')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.raw).not.toHaveBeenCalled()
  }
)
it.each(['permission', 'mfa', 'session'] as const)('requires live bound audit authority: %s', async (kind) => {
  if (kind === 'permission') permission.value = false
  if (kind === 'mfa') auth.user.value.mfaVerified = false
  if (kind === 'session')
    mocks.navigation.mockReturnValue({
      status: ref('ready'),
      capabilities: ref({
        state: 'ready',
        identityId: actor,
        sessionId: sid,
        sessionVersion: 2,
        permissions: ['administration.manage']
      })
    })
  const w = await render()
  expect(w.find('[data-audit-load]').exists()).toBe(false)
  expect(mocks.request).not.toHaveBeenCalled()
})
it('applies filters explicitly and freezes them across cursor pagination until reapplied', async () => {
  snapshot.nextCursor = 'next_cursor_84'
  const w = await render()
  await w.get('[data-audit-family]').setValue('inventory')
  await w.get('[data-audit-resource]').setValue('variant-1')
  expect(mocks.request).not.toHaveBeenCalled()
  await load(w)
  expect(mocks.request.mock.calls[0]![1].query).toEqual({ family: 'inventory', resourceId: 'variant-1', limit: 25 })
  await w.get('[data-audit-resource]').setValue('unapplied-other')
  await w.get('[data-audit-next]').trigger('click')
  await flushPromises()
  expect(mocks.request.mock.calls.at(-1)![1].query).toEqual({
    family: 'inventory',
    resourceId: 'variant-1',
    limit: 25,
    cursor: 'next_cursor_84'
  })
})
it('requires review and explicit confirmation plus exact review history before success', async () => {
  const w = await render()
  await review(w)
  expect(posts()).toHaveLength(0)
  await confirm(w)
  expect(posts()).toHaveLength(1)
  expect(posts()[0]![0]).toBe(`${detailPath}/reviews`)
  expect(posts()[0]![1].body).toEqual({
    expectedVersion: 0,
    disposition: 'follow_up',
    reason: 'Synthetic private reason reviewed by the operator'
  })
  expect(w.emitted('confirmed')).toHaveLength(1)
  expect(mocks.raw).not.toHaveBeenCalled()
})
it('recovers a lost review response by exact lookup and fresh detail without another POST', async () => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    const result = await original(path, options)
    if (options.method === 'POST') throw Error('synthetic_lost')
    return result
  })
  const w = await render()
  await review(w)
  await w.get('[data-audit-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-audit-check]').exists()).toBe(true))
  await w.get('[data-audit-check]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-audit-confirmed]').exists()).toBe(true))
  expect(posts()).toHaveLength(1)
  const lookup = mocks.request.mock.calls.find(([path]) => path.includes('/commands/'))!
  expect(lookup[0]).toBe(`${endpoint}/commands/${receipt!.commandId}`)
  expect(lookup[1].query).toEqual({ payloadHash: receipt!.payloadHash })
})
it('does not confirm a review whose current history has no matching command', async () => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    const result = await original(path, options)
    return path === detailPath && receipt ? { ...detail, reviews: [] } : result
  })
  const w = await render()
  await review(w)
  await w.get('[data-audit-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-audit-check]').exists()).toBe(true))
  expect(w.emitted('confirmed')).toBeUndefined()
})
it('freezes export filters and requires receipt plus exact GET before an explicit verified CSV download', async () => {
  const w = await render()
  await exportReview(w)
  expect(posts()).toHaveLength(0)
  expect(mocks.raw).not.toHaveBeenCalled()
  await confirm(w)
  expect(mocks.request.mock.calls.some(([path]) => path.includes('/commands/'))).toBe(true)
  expect(mocks.raw).not.toHaveBeenCalled()
  await w.get('[data-audit-download]').trigger('click')
  await vi.waitFor(() => expect(createUrl).toHaveBeenCalledTimes(1))
  expect(mocks.raw.mock.calls[0]![0]).toBe(`${endpoint}/exports/${receipt!.commandId}/download`)
  expect(revokeUrl).toHaveBeenCalledWith('blob:synthetic-admin-audit')
  expect(document.querySelector('a[download]')).toBe(null)
  expect(posts()).toHaveLength(1)
})
it('recovers a lost export response without creating a second export or downloading early', async () => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    const result = await original(path, options)
    if (options.method === 'POST') throw Error('synthetic_lost')
    return result
  })
  const w = await render()
  await exportReview(w)
  await w.get('[data-audit-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-audit-check]').exists()).toBe(true))
  await w.get('[data-audit-check]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-audit-download]').exists()).toBe(true))
  expect(posts()).toHaveLength(1)
  expect(mocks.raw).not.toHaveBeenCalled()
})
it('keeps an unknown command locked with no automatic retry or export download', async () => {
  mocks.request.mockImplementation(async (path: string, options: Options) => {
    if (options.method === 'POST') throw Error('synthetic_unknown')
    if (path.includes('/commands/')) return { source: 'cloudflare', outcome: 'unknown', receipt: null }
    return path === detailPath ? detail : snapshot
  })
  const w = await render()
  await review(w)
  await w.get('[data-audit-confirm]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-audit-check]').exists()).toBe(true))
  await w.get('[data-audit-check]').trigger('click')
  await flushPromises()
  expect(posts()).toHaveLength(1)
  expect(w.find('[data-audit-confirm]').exists()).toBe(false)
  expect(w.emitted('confirmed')).toBeUndefined()
  expect(mocks.raw).not.toHaveBeenCalled()
})
it('rejects changed CSV bytes even when the server repeats the confirmed digest header', async () => {
  const original = mocks.raw.getMockImplementation()!
  mocks.raw.mockImplementation(async () => {
    const value = await original(),
      bytes = new Uint8Array(value._data)
    bytes[4] = bytes[4]! ^ 1
    return value
  })
  const w = await render()
  await exportReview(w)
  await confirm(w)
  await w.get('[data-audit-download]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-audit-download-error]').exists()).toBe(true))
  expect(createUrl).not.toHaveBeenCalled()
})
it('fails closed rather than rendering an unredacted free-text reason from a malformed detail', async () => {
  const original = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (path: string, options: Options) =>
    path === detailPath ? { ...detail, item: { ...detail.item, reason: 'PRIVATE_SENTINEL' } } : original(path, options)
  )
  const w = await render()
  await load(w)
  await w.get(`[data-audit-open="${eventId}"]`).trigger('click')
  await flushPromises()
  expect(w.text()).not.toContain('PRIVATE_SENTINEL')
  expect(w.find('[data-audit-detail]').exists()).toBe(false)
})
it.each(['permission', 'unmount', 'server403'] as const)(
  'purges drafts, details, export receipts and intent after %s',
  async (kind) => {
    const w = await render()
    await review(w)
    if (kind === 'permission') {
      permission.value = false
      await flushPromises()
    }
    if (kind === 'unmount') w.unmount()
    if (kind === 'server403') {
      mocks.request.mockRejectedValue({ statusCode: 403 })
      await w.get('[data-audit-confirm]').trigger('click')
      await vi.waitFor(() => expect((w.vm.$.setupState as Record<string, unknown>).intent).toBe(null))
    }
    const state = w.vm.$.setupState as Record<string, unknown>
    expect(state.intent).toBe(null)
    expect(state.snapshot).toBe(null)
    expect(state.detail).toBe(null)
    expect(state.reviewReason).toBe('')
    expect(state.exportReason).toBe('')
    expect(state.exportReceipt).toBe(null)
  }
)
it('discards a late read when the session version changes', async () => {
  let resolve!: (value: unknown) => void
  mocks.request.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const w = await render()
  await w.get('[data-audit-load]').trigger('click')
  auth.session.value.sessionVersion = 2
  await flushPromises()
  resolve(snapshot)
  await flushPromises()
  expect((w.vm.$.setupState as Record<string, unknown>).snapshot).toBe(null)
})
