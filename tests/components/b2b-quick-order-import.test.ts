import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import B2BQuickOrderImport from '../../app/components/B2BQuickOrderImport.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  add: vi.fn(),
  session: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.read)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useUserSession', () => mocks.session)
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({ add: mocks.add, pendingMutation: false, blockedMutations: false })
}))
const ID = '71000000-0000-4000-8000-000000000001',
  SESSION = '72000000-0000-4000-8000-000000000001'
const ready = (n: number, extra = {}) => ({
  index: n - 1,
  status: 'ready',
  reference: `SKU-${n}`,
  quantity: 2,
  variantId: `v-${n}`,
  legacyVariantId: n,
  sku: `SKU-${n}`,
  productSlug: `p-${n}`,
  name: `Producto ${n}`,
  format: 'Caja',
  unitLabel: 'caja',
  unitGrossCents: 1000,
  grossCents: 2000,
  netCents: 1653,
  taxCents: 347,
  taxRateBasisPoints: 2100,
  source: 'b2b_variant',
  stock: 10,
  backorderAllowed: false,
  minimumQuantity: 1,
  quantityIncrement: 1,
  maximumQuantity: null,
  ...extra
})
let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref<{ id: string; email: string; emailVerified: boolean } | null>>
  session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number } | null>>
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const wrappers: Wrapper[] = []
async function render() {
  const wrapper = await mountSuspended(B2BQuickOrderImport)
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
async function analyze(w: Wrapper, text: string) {
  await w.get('[data-import-text]').setValue(text)
  await w.get('[data-import-form]').trigger('submit')
  await flushPromises()
}
async function scan(w: Wrapper, code: string) {
  await w.get('[data-scan-input]').setValue(code)
  await w.get('[data-scan-form]').trigger('submit')
  await flushPromises()
}
beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue({ companyId: 'c', lines: [ready(1), ready(2)] })
  mocks.add.mockReset().mockResolvedValue(undefined)
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ID, email: 'synthetic@example.invalid', emailVerified: true }),
    session: ref({ sessionId: SESSION, sessionVersion: 1 })
  }
  mocks.session.mockReturnValue(auth)
  vi.stubGlobal('BarcodeDetector', undefined)
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  vi.unstubAllGlobals()
})

describe('SEA-018 B2B quick order: CSV import and barcode scan', () => {
  it('shows nothing actionable for anonymous or unverified sessions and makes no request', async () => {
    auth.loggedIn.value = false
    auth.user.value = null
    let w = await render()
    expect(w.find('[data-import-form]').exists()).toBe(false)
    expect(w.text()).toContain('empresa')
    wrappers.pop()?.unmount()
    auth.loggedIn.value = true
    auth.user.value = { id: ID, email: 'synthetic@example.invalid', emailVerified: false }
    w = await render()
    expect(w.find('[data-import-form]').exists()).toBe(false)
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('previews the CSV locally with per-line errors and never calls the server yet', async () => {
    const w = await render()
    await analyze(w, 'referencia;cantidad\nSKU-1;2\n;3\nSKU-3;0\nSKU-1;4')
    expect(w.get('[data-import-summary]').text()).toContain('1 válida')
    expect(w.get('[data-import-summary]').text()).toContain('3 con error')
    const errors = w.findAll('[data-import-error]').map((e) => e.text())
    expect(errors.join('|')).toContain('Línea 3')
    expect(errors.join('|')).toContain('Línea 4')
    expect(errors.join('|')).toContain('Línea 5')
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('asks for a column mapping when headers are ambiguous and applies it', async () => {
    const w = await render()
    await analyze(w, 'sku,ean,cantidad\nA1,8412345678905,2')
    expect(w.find('[data-mapping]').exists()).toBe(true)
    await w.get('[data-map-reference]').setValue('1')
    await w.get('[data-map-quantity]').setValue('2')
    await w.get('[data-map-apply]').trigger('click')
    await flushPromises()
    expect(w.find('[data-mapping]').exists()).toBe(false)
    expect(w.get('[data-import-summary]').text()).toContain('1 válida')
    expect(w.text()).toContain('8412345678905')
  })
  it('rejects an oversized file without reading it and reads a valid one', async () => {
    const w = await render()
    const big = new File(['x'], 'big.csv', { type: 'text/csv' })
    Object.defineProperty(big, 'size', { value: 70_000 })
    const textSpy = vi.spyOn(big, 'text')
    const input = w.get('[data-import-file]')
    Object.defineProperty(input.element, 'files', { value: [big], configurable: true })
    await input.trigger('change')
    await flushPromises()
    expect(textSpy).not.toHaveBeenCalled()
    expect(w.get('[data-import-error-general]').text()).toContain('64 KiB')
    const ok = new File(['referencia,cantidad\nSKU-9,3'], 'pedido.csv', { type: 'text/csv' })
    Object.defineProperty(input.element, 'files', { value: [ok], configurable: true })
    await input.trigger('change')
    await flushPromises()
    expect(w.get('[data-import-summary]').text()).toContain('1 válida')
  })
  it('adds scanned codes, increments repeats and refuses a bad checksum', async () => {
    const w = await render()
    await scan(w, '8412345678905')
    await scan(w, '8412345678905')
    expect(w.get('[data-line="0"]').text()).toContain('8412345678905')
    expect(w.get('[data-line-quantity="0"]').element).toHaveProperty('value', '2')
    await scan(w, '8412345678904')
    expect(w.get('[data-scan-error]').text()).toContain('dígito de control')
    expect(w.findAll('[data-line]')).toHaveLength(1)
  })
  it('hides the camera button when BarcodeDetector is unavailable', async () => {
    const w = await render()
    expect(w.find('[data-scan-camera]').exists()).toBe(false)
  })
  it('shows the camera button when BarcodeDetector exists', async () => {
    vi.stubGlobal('BarcodeDetector', function BarcodeDetector() {})
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
    const w = await render()
    expect(w.find('[data-scan-camera]').exists()).toBe(true)
  })
  it('lets the buyer edit quantity and remove a line before validating', async () => {
    const w = await render()
    await scan(w, 'SKU-1')
    await w.get('[data-line-quantity="0"]').setValue('5')
    await w.get('[data-line-remove="0"]').trigger('click')
    expect(w.findAll('[data-line]')).toHaveLength(0)
    expect(w.get('[data-validate]').attributes('disabled')).toBeDefined()
  })
  it('validates with the company endpoint sending only references and quantities', async () => {
    const w = await render()
    await analyze(w, 'referencia,cantidad\nSKU-1,2\nSKU-2,2')
    await w.get('[data-validate]').trigger('click')
    await flushPromises()
    expect(mocks.read).toHaveBeenCalledTimes(1)
    const [path, options] = mocks.read.mock.calls[0]!
    expect(path).toBe('/api/account/quick-order/company')
    expect(options.method).toBe('POST')
    expect(options.body).toEqual({
      lines: [
        { reference: 'SKU-1', quantity: 2 },
        { reference: 'SKU-2', quantity: 2 }
      ]
    })
    expect(JSON.stringify(options)).not.toMatch(/company|customer|price/i)
    expect(w.text()).toContain('Producto 1')
    expect(w.text()).toContain('precio de tu empresa')
  })
  it('explains line errors and company authorization failures', async () => {
    mocks.read.mockResolvedValueOnce({
      companyId: 'c',
      lines: [
        ready(1),
        { index: 1, status: 'error', reference: 'SKU-2', quantity: 2, code: 'insufficient_stock' },
        { index: 2, status: 'error', reference: 'SKU-3', quantity: 2, code: 'not_found' }
      ]
    })
    const w = await render()
    await analyze(w, 'referencia,cantidad\nSKU-1,2\nSKU-2,2\nSKU-3,2')
    await w.get('[data-validate]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Stock insuficiente')
    expect(w.text()).toContain('No se encontró')
    mocks.read.mockRejectedValueOnce({ statusCode: 403, data: { error: { code: 'company_not_approved' } } })
    await w.get('[data-validate]').trigger('click')
    await flushPromises()
    expect(w.get('[data-validate-error]').text()).toContain('empresa')
    expect(w.find('[data-result]').exists()).toBe(false)
  })
  it('adds only selected ready rows after explicit confirmation, via the cart', async () => {
    const w = await render()
    await analyze(w, 'referencia,cantidad\nSKU-1,2\nSKU-2,2')
    await w.get('[data-validate]').trigger('click')
    await flushPromises()
    expect(w.get('[data-add]').attributes('disabled')).toBeDefined()
    await w.get('[data-result-select="1"]').setValue(false)
    await w.get('[data-confirm]').setValue(true)
    await w.get('[data-add]').trigger('click')
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledTimes(1)
    expect(mocks.add).toHaveBeenCalledWith({ variantId: 1 }, 2)
  })
  it('stops at an uncertain cart result and never resends it', async () => {
    mocks.add.mockRejectedValueOnce(new Error('network'))
    const w = await render()
    await analyze(w, 'referencia,cantidad\nSKU-1,2\nSKU-2,2')
    await w.get('[data-validate]').trigger('click')
    await flushPromises()
    await w.get('[data-confirm]').setValue(true)
    await w.get('[data-add]').trigger('click')
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledTimes(1)
    expect(w.get('[data-add-notice]').text()).toContain('incierto')
  })
  it('purges lines and results when the session changes', async () => {
    const w = await render()
    await analyze(w, 'referencia,cantidad\nSKU-1,2')
    await w.get('[data-validate]').trigger('click')
    await flushPromises()
    auth.session.value = { sessionId: SESSION, sessionVersion: 2 }
    await flushPromises()
    expect(w.find('[data-result]').exists()).toBe(false)
    expect(w.findAll('[data-line]')).toHaveLength(0)
  })
  it('ignores a late response after the session changed', async () => {
    let release!: (value: unknown) => void
    mocks.read.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    const w = await render()
    await analyze(w, 'referencia,cantidad\nSKU-1,2')
    await w.get('[data-validate]').trigger('click')
    auth.session.value = { sessionId: SESSION, sessionVersion: 2 }
    await flushPromises()
    release({ companyId: 'c', lines: [ready(1)] })
    await flushPromises()
    expect(w.find('[data-result]').exists()).toBe(false)
  })
})
