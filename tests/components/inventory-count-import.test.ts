import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { computed, ref, type Ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import InventoryPage from '../../app/pages/admin/inventario.vue'
import {
  inventoryCountImportPreviewSchema,
  inventoryCountImportSnapshotSchema,
  inventoryCountImportListSchema,
  inventoryCountImportReceiptSchema,
  inventoryCountImportIntentHash
} from '../../shared/inventory-count-import'
import '#app/nuxt-vitest-app-entry'

// Mount the current page, not an absent component or a fabricated API. The first
// RED is the missing operational entry point. Exact preview/receipt fixtures will
// use the agreed shared schemas once published; no speculative endpoint stubs.
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  owner: null as unknown,
  navigation: null as unknown,
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('$fetch', () => mocks.request)
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.owner)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useRoute', () => () => ({ query: {} }))
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: () => mocks.navigation }))

const ACTOR = '10000000-0000-4000-8000-000000000010'
const SESSION = '20000000-0000-4000-8000-000000000010'
const ROOT = '/api/admin/inventory/count-imports'
const CSV = 'sku,countedPhysicalQuantity\nSKU-COUNT-10,18\n'
const IMPORT = '30000000-0000-4000-8000-000000000010'
const OTHER = '10000000-0000-4000-8000-000000000011'
const TIME = '2026-10-09T18:00:00Z'
const permission = ref(true)
function preview(error: 'unknown_sku' | 'duplicate_sku' | 'invalid_quantity' | null = null) {
  return inventoryCountImportPreviewSchema.parse({
    source: 'cloudflare',
    previewHash: 'a'.repeat(64),
    canPropose: error === null,
    rows: [
      {
        rowNumber: 2,
        sku: 'SKU-COUNT-10',
        countedPhysicalQuantity: 18,
        variantId: error ? null : 11,
        expectedBalanceVersion: error ? null : 1,
        physicalQuantity: error ? null : 20,
        physicalDelta: error ? null : -2,
        error
      }
    ]
  })
}
function snapshot(proposedBy = ACTOR, approved = false, stale = false) {
  return inventoryCountImportSnapshotSchema.parse({
    source: 'cloudflare',
    importId: IMPORT,
    version: approved ? 2 : 1,
    status: approved ? 'approved' : 'proposed',
    proposedBy,
    approvedBy: approved ? ACTOR : null,
    reason: 'Recuento físico sintético documentado',
    reference: 'COUNT-SYNTHETIC-10',
    createdAt: TIME,
    approvedAt: approved ? TIME : null,
    rows: [
      {
        ...preview().rows[0]!,
        currentBalanceVersion: approved || stale ? 2 : 1,
        currentPhysicalQuantity: approved ? 18 : stale ? 21 : 20,
        stale
      }
    ],
    capabilities: { approve: !approved && !stale && proposedBy !== ACTOR }
  })
}
function list(proposedBy?: string) {
  const { rows: _rows, capabilities: _capabilities, ...summary } = snapshot(proposedBy)
  return inventoryCountImportListSchema.parse({
    source: 'cloudflare',
    page: 1,
    perPage: 25,
    total: proposedBy ? 1 : 0,
    items: proposedBy ? [summary] : []
  })
}
function previewResponse(value: unknown) {
  mocks.request.mockImplementation(async (path) => (path === `${ROOT}/preview` ? value : list()))
}
let owner: {
  ready: Ref<boolean>
  loggedIn: Ref<boolean>
  user: Ref<{ id: string; emailVerified: boolean; mfaVerified: boolean }>
  session: Ref<{ sessionId: string; sessionVersion: number }>
}
const mounted: Array<{ unmount(): void }> = []
beforeEach(() => {
  owner = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ACTOR, emailVerified: true, mfaVerified: true }),
    session: ref({ sessionId: SESSION, sessionVersion: 1 })
  }
  mocks.owner = owner
  permission.value = true
  mocks.navigation = {
    status: ref('ready'),
    capabilities: computed(() => ({
      source: 'cloudflare',
      identityId: owner.user.value.id,
      sessionId: owner.session.value.sessionId,
      sessionVersion: owner.session.value.sessionVersion,
      state: 'ready',
      permissions: permission.value ? ['inventory.read'] : []
    }))
  }
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  mocks.request.mockReset()
  previewResponse(preview())
})
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))
async function render() {
  const page = await mountSuspended(InventoryPage, {
    global: { stubs: { InventoryAlertsPanel: true } }
  })
  mounted.push(page)
  await flushPromises()
  return page
}
it('offers a CSV count-import entry point without creating a proposal or stock adjustment on mount', async () => {
  const page = await render()
  expect(page.find('[aria-label="Importación de recuentos CSV"]').exists()).toBe(true)
  expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
})
it('keeps the Node inventory branch free of the D1 count-import entry point and calls', async () => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  })
  const page = await render()
  expect(page.find('[aria-label="Importación de recuentos CSV"]').exists()).toBe(false)
  expect(mocks.request).not.toHaveBeenCalled()
})

async function inspectCsv(page: Awaited<ReturnType<typeof render>>) {
  await page.get('[data-count-import-csv]').setValue(CSV)
  await page.get('[data-count-import-preview]').trigger('click')
  await flushPromises()
}
async function reviewProposal(page: Awaited<ReturnType<typeof render>>) {
  await inspectCsv(page)
  await page.get('[data-count-import-reason]').setValue('Recuento físico sintético documentado')
  await page.get('[data-count-import-reference]').setValue('COUNT-SYNTHETIC-10')
  await page.get('[data-count-import-review]').trigger('submit')
  await vi.waitFor(() => expect(page.find('[data-count-import-confirm]').exists()).toBe(true))
}
const proposals = () =>
  mocks.request.mock.calls.filter(([path, options]) => path === ROOT && options?.method === 'POST')

it('does not send CSV on editing and previews current differences without proposing or overwriting stock', async () => {
  const page = await render()
  mocks.request.mockClear()
  await page.get('[data-count-import-csv]').setValue(CSV)
  expect(mocks.request).not.toHaveBeenCalled()
  await page.get('[data-count-import-preview]').trigger('click')
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledWith(
    `${ROOT}/preview`,
    expect.objectContaining({ method: 'POST', body: { csv: CSV }, retry: 0 })
  )
  expect(page.text()).toContain('SKU-COUNT-10')
  expect(page.text()).toContain('-2')
  expect(proposals()).toHaveLength(0)
})
it('correlates a trimmed decomposed Unicode SKU with the server NFC preview', async () => {
  const data = preview()
  data.rows[0]!.sku = 'CAFÉ-COUNT'
  previewResponse(inventoryCountImportPreviewSchema.parse(data))
  const page = await render()
  await page.get('[data-count-import-csv]').setValue('sku,countedPhysicalQuantity\n  CAFE\u0301-COUNT  ,18\n')
  await page.get('[data-count-import-preview]').trigger('click')
  await flushPromises()
  expect(page.text()).toContain('CAFÉ-COUNT')
  expect(page.find('[data-count-import-review]').exists()).toBe(true)
  expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
})
it.each(['unknown_sku', 'duplicate_sku', 'invalid_quantity'] as const)(
  'blocks the entire proposal when any row contains %s',
  async (error) => {
    previewResponse(preview(error))
    const page = await render()
    await inspectCsv(page)
    expect(page.find('[data-count-import-confirm]').exists()).toBe(false)
    expect(page.find('[data-count-import-review]').exists()).toBe(false)
    expect(proposals()).toHaveLength(0)
  }
)
it('reports unchanged counts without manufacturing a zero-stock adjustment or proposal', async () => {
  const data = preview()
  data.canPropose = false
  data.rows[0]!.countedPhysicalQuantity = 20
  data.rows[0]!.physicalDelta = 0
  previewResponse(data)
  const page = await render()
  await inspectCsv(page)
  expect(page.text()).toContain('Sin diferencias')
  expect(page.find('[data-count-import-review]').exists()).toBe(false)
  expect(proposals()).toHaveLength(0)
})
it('shows a read-only valid preview without offering a proposal when the server denies its write flag', async () => {
  const data = preview()
  data.canPropose = false
  previewResponse(data)
  const page = await render()
  await inspectCsv(page)
  expect(page.text()).toContain('SKU-COUNT-10')
  expect(page.text()).toContain('-2')
  expect(page.find('[data-count-import-review]').exists()).toBe(false)
  expect(page.find('[data-count-import-confirm]').exists()).toBe(false)
  expect(proposals()).toHaveLength(0)
})
it('requires reason and reference before freezing a proposal and never auto-approves it', async () => {
  const page = await render()
  await inspectCsv(page)
  await page.get('[data-count-import-review]').trigger('submit')
  await flushPromises()
  expect(page.find('[data-count-import-confirm]').exists()).toBe(false)
  expect(proposals()).toHaveLength(0)
  expect(mocks.request.mock.calls.some(([path]) => String(path).endsWith('/approve'))).toBe(false)
})
it('retains the exact original proposal after response loss and only retries on an explicit click', async () => {
  const page = await render()
  await reviewProposal(page)
  expect(proposals()).toHaveLength(0)
  mocks.request.mockRejectedValue(new Error('response lost after possible commit'))
  await page.get('[data-count-import-confirm]').trigger('click')
  await vi.waitFor(() => expect(page.text()).toContain('incierto'))
  expect(proposals()).toHaveLength(1)
  const original = proposals()[0]![1]
  expect(original.body).toEqual({
    csv: CSV,
    previewHash: 'a'.repeat(64),
    reason: 'Recuento físico sintético documentado',
    reference: 'COUNT-SYNTHETIC-10'
  })
  expect(original.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  expect(original.retry).toBe(0)
  mocks.request.mockResolvedValue({ source: 'cloudflare', outcome: 'unknown', receipt: null })
  await page.get('[data-count-import-check]').trigger('click')
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledWith(
    `${ROOT}/commands/${original.headers['Idempotency-Key']}`,
    expect.objectContaining({
      headers: {
        'X-Neteco-Command-Payload-Hash': await inventoryCountImportIntentHash('propose', null, original.body)
      },
      retry: 0
    })
  )
  expect(page.text()).toContain('incierto')
  expect(proposals()).toHaveLength(1)
  mocks.request.mockRejectedValue(new Error('retry response lost'))
  await page.get('[data-count-import-retry]').trigger('click')
  await flushPromises()
  expect(proposals()).toHaveLength(2)
  expect(proposals()[1]![1].body).toEqual(original.body)
  expect(proposals()[1]![1].headers['Idempotency-Key']).toBe(original.headers['Idempotency-Key'])
  expect(page.text()).not.toContain('Recuento aprobado')
})
it.each(['outage', 'malformed'] as const)('does not turn a %s preview into empty or editable counts', async (mode) => {
  mocks.request.mockImplementation(async (path) => {
    if (path !== `${ROOT}/preview`) return list()
    if (mode === 'outage') throw new Error('private database failure')
    return { source: 'cloudflare', rows: [] }
  })
  const page = await render()
  await inspectCsv(page)
  expect(page.find('[data-count-import-review]').exists()).toBe(false)
  expect(page.find('[data-count-import-confirm]').exists()).toBe(false)
  expect(page.text()).not.toContain('Sin diferencias')
  expect(page.text()).not.toContain('private database')
  expect(proposals()).toHaveLength(0)
})
it.each(['session', 'email', 'grant'] as const)(
  'purges private CSV and rejects a late preview after %s changes',
  async (mode) => {
    let resolve!: (value: unknown) => void
    mocks.request.mockImplementation((path) =>
      path === `${ROOT}/preview`
        ? new Promise((yes) => {
            resolve = yes
          })
        : Promise.resolve(list())
    )
    const page = await render()
    await page.get('[data-count-import-csv]').setValue(CSV)
    await page.get('[data-count-import-preview]').trigger('click')
    if (mode === 'session') owner.session.value.sessionVersion++
    else if (mode === 'email') owner.user.value.emailVerified = false
    else permission.value = false
    resolve(preview())
    await flushPromises()
    expect(page.text()).not.toContain('SKU-COUNT-10')
    expect(page.find('[data-count-import-review]').exists()).toBe(false)
    expect(proposals()).toHaveLength(0)
  }
)

it('lists current imports for explicit selection without requiring a manually copied UUID', async () => {
  mocks.request.mockResolvedValue(list(OTHER))
  const page = await render()
  expect(mocks.request).toHaveBeenCalledWith(
    ROOT,
    expect.objectContaining({ query: { page: 1, perPage: 25 }, retry: 0 })
  )
  expect(page.find(`[data-count-import-open="${IMPORT}"]`).exists()).toBe(true)
  expect(proposals()).toHaveLength(0)
})
it.each(['same-actor', 'stale'] as const)('does not offer approval for a %s proposal', async (mode) => {
  const proposer = mode === 'same-actor' ? ACTOR : OTHER
  mocks.request.mockImplementation(async (path) =>
    path === `${ROOT}/${IMPORT}` ? snapshot(proposer, false, mode === 'stale') : list(proposer)
  )
  const page = await render()
  await page.get(`[data-count-import-open="${IMPORT}"]`).trigger('click')
  await flushPromises()
  expect(page.find('[data-count-import-review-approval]').exists()).toBe(false)
  expect(mocks.request.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})
it('confirms a proposal only through its exact receipt and fresh import, without reporting a stock write', async () => {
  const page = await render()
  await reviewProposal(page)
  mocks.request.mockImplementation(async (path, options) => {
    if (path === ROOT && options?.method === 'POST')
      return inventoryCountImportReceiptSchema.parse({
        source: 'cloudflare',
        commandId: options.headers['Idempotency-Key'],
        action: 'propose',
        importId: IMPORT,
        expectedVersion: 0,
        version: 1,
        payloadHash: await inventoryCountImportIntentHash('propose', null, options.body),
        rowCount: 1,
        changedCount: 1,
        recordedAt: TIME,
        inventoryEffect: 'none',
        economicEffect: 'none'
      })
    if (path === `${ROOT}/${IMPORT}`) return snapshot()
    return list(ACTOR)
  })
  await page.get('[data-count-import-confirm]').trigger('click')
  await vi.waitFor(() => expect(page.text()).toContain('Propuesta confirmada'))
  expect(page.text()).not.toContain('Recuento aprobado')
  expect(page.find('[data-count-import-review-approval]').exists()).toBe(false)
  expect(mocks.request.mock.calls.some(([path]) => String(path).endsWith('/approve'))).toBe(false)
})
it('requires independent explicit approval and confirms only the receipt plus current physical balances', async () => {
  let applied = false
  mocks.request.mockImplementation(async (path, options) => {
    if (path === `${ROOT}/${IMPORT}/approve`) {
      applied = true
      return inventoryCountImportReceiptSchema.parse({
        source: 'cloudflare',
        commandId: options.headers['Idempotency-Key'],
        action: 'approve',
        importId: IMPORT,
        expectedVersion: 1,
        version: 2,
        payloadHash: await inventoryCountImportIntentHash('approve', IMPORT, options.body),
        rowCount: 1,
        changedCount: 1,
        recordedAt: TIME,
        inventoryEffect: 'physical_adjustment',
        economicEffect: 'none'
      })
    }
    return path === `${ROOT}/${IMPORT}` ? snapshot(OTHER, applied) : list(OTHER)
  })
  const page = await render()
  await page.get(`[data-count-import-open="${IMPORT}"]`).trigger('click')
  await flushPromises()
  await page.get('[data-count-import-approval-reason]').setValue('Verificación independiente del recuento sintético')
  await page.get('[data-count-import-review-approval]').trigger('submit')
  await vi.waitFor(() => expect(page.find('[data-count-import-confirm]').exists()).toBe(true))
  expect(applied).toBe(false)
  await page.get('[data-count-import-confirm]').trigger('click')
  await vi.waitFor(() => expect(page.text()).toContain('Recuento aprobado'))
  expect(mocks.request).toHaveBeenCalledWith(
    `${ROOT}/${IMPORT}/approve`,
    expect.objectContaining({
      method: 'POST',
      body: {
        expectedVersion: 1,
        reason: 'Verificación independiente del recuento sintético'
      },
      retry: 0
    })
  )
  expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
})
it.each(['foreign-receipt', 'fresh-read-outage'] as const)(
  'keeps a %s proposal uncertain instead of showing confirmation',
  async (mode) => {
    const page = await render()
    await reviewProposal(page)
    mocks.request.mockImplementation(async (_path, options) => {
      if (options?.method !== 'POST') throw new Error('private fresh read error')
      return inventoryCountImportReceiptSchema.parse({
        source: 'cloudflare',
        commandId:
          mode === 'foreign-receipt' ? '40000000-0000-4000-8000-000000000010' : options.headers['Idempotency-Key'],
        action: 'propose',
        importId: IMPORT,
        expectedVersion: 0,
        version: 1,
        payloadHash: await inventoryCountImportIntentHash('propose', null, options.body),
        rowCount: 1,
        changedCount: 1,
        recordedAt: TIME,
        inventoryEffect: 'none',
        economicEffect: 'none'
      })
    })
    await page.get('[data-count-import-confirm]').trigger('click')
    await vi.waitFor(() => expect(page.text()).toContain('incierto'))
    expect(page.find('[data-count-import-check]').exists()).toBe(true)
    expect(page.text()).not.toContain('Propuesta confirmada')
    expect(page.text()).not.toContain('private fresh')
    expect(proposals()).toHaveLength(1)
  }
)
