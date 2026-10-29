import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QuickOrderPanel from '../../app/components/QuickOrderPanel.vue'
import '#app/nuxt-vitest-app-entry'

// Matrix: explicit bounded CSV/lookup, exact variant + MOQ/prices, selection and
// explicit confirmation; no writes on errors, singleflight and real cart recovery;
// session/email/version boundaries, late read/write/unmount purge, honest Node gap.
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  add: vi.fn(),
  session: vi.fn(),
  blocked: false,
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.read)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useUserSession', () => mocks.session)
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({
    add: mocks.add,
    get pendingMutation() {
      return mocks.blocked
    },
    get blockedMutations() {
      return mocks.blocked
    }
  })
}))
const ID = '71000000-0000-4000-8000-000000000001',
  SESSION = '72000000-0000-4000-8000-000000000001'
const variants = [1, 2, 3].map((id) => ({
  uuid: `73000000-0000-4000-8000-00000000000${id}`,
  id,
  sku: `SKU-${id}`,
  ean: `841234567890${id}`,
  gtin: null,
  mpn: null,
  format: 'Caja',
  unitLabel: 'caja',
  price: 1210,
  priceTiers: [],
  pricingVersion: 'published-price-1',
  taxRateBasisPoints: 2100,
  minimumQuantity: 2,
  maximumQuantity: 10,
  quantityIncrement: 2,
  stock: 10,
  backorderAllowed: false
}))
const product = () => ({ slug: 'producto', name: 'Producto observado', variants })
let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref<{ id: string; email: string; emailVerified: boolean } | null>>
  session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number } | null>>
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const wrappers: Wrapper[] = []
async function render() {
  const wrapper = await mountSuspended(QuickOrderPanel)
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
async function preview(wrapper: Wrapper, csv = 'referencia,cantidad\nSKU-1,2') {
  await wrapper.get('[data-quick-csv]').setValue(csv)
  await wrapper.get('[data-quick-input]').trigger('submit')
  await flushPromises()
}
async function confirm(wrapper: Wrapper) {
  await wrapper.get('[data-quick-confirm]').setValue(true)
  await wrapper.get('[data-quick-add]').trigger('click')
  await flushPromises()
}
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((yes) => {
    resolve = yes
  })
  return { resolve, promise }
}
beforeEach(() => {
  mocks.read
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === '/api/search' ? { items: [{ slug: 'producto' }] } : product()
    )
  mocks.add.mockReset().mockResolvedValue(undefined)
  mocks.blocked = false
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
})
afterEach(() => wrappers.splice(0).forEach((w) => w.unmount()))
describe('public bounded quick order with existing cart recovery', () => {
  it('does no lookup or mutation until an explicit preview, with labelled CSV and limits', async () => {
    const w = await render()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
    expect(w.text()).toContain('10 filas')
    expect(w.text()).toContain('8 KiB')
    expect(w.get('label[for="quick-csv"]').text()).toContain('Referencias')
    expect(w.find('[data-quick-add]').exists()).toBe(false)
  })
  it('previews exact identifier, format, unit/MOQ/increment/max, observed net/gross/IVA with no contractual quote claim', async () => {
    const w = await render()
    await preview(w)
    expect(w.text()).toContain('SKU-1')
    expect(w.text()).toContain('Caja')
    expect(w.text()).toContain('caja')
    expect(w.text()).toContain('Mínimo 2')
    expect(w.text()).toContain('Incremento 2')
    expect(w.text()).toContain('Máximo 10')
    expect(w.text()).toContain('24,20')
    expect(w.text()).toContain('20,00')
    expect(w.text()).toContain('21')
    expect(w.text()).toContain('no son una cotización')
    expect(w.text()).toContain('portes')
    expect(mocks.add).not.toHaveBeenCalled()
    expect(w.get('[data-quick-add]').attributes('disabled')).toBeDefined()
  })
  it('adds only selected valid rows after explicit confirmation via cart.add, never direct POST', async () => {
    const w = await render()
    await preview(w, 'referencia,cantidad\nSKU-1,2\nSKU-2,4')
    await w.get('[data-quick-select="1"]').setValue(false)
    await confirm(w)
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith({ variantId: 1 }, 2)
    expect(mocks.read.mock.calls.every((call) => call[1].method === 'GET')).toBe(true)
    expect(w.text()).toContain('1 adición confirmada')
  })
  it('allows current ready guests without inventing MFA or account APIs', async () => {
    auth.loggedIn.value = false
    auth.user.value = null
    auth.session.value = null
    const w = await render()
    await preview(w)
    await confirm(w)
    expect(mocks.add).toHaveBeenCalledOnce()
  })
  it.each(['node', 'unexpected'])('does not fake a %s contract or fallback', async (runtime) => {
    mocks.runtime.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: runtime }
    })
    const w = await render()
    expect(w.find('[data-quick-csv]').exists()).toBe(false)
    expect(w.text()).toContain('Cloudflare')
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it.each(['loading', 'email', 'session', 'version'])(
    'withholds private draft/actions for invalid current authority %s',
    async (boundary) => {
      if (boundary === 'loading') auth.ready.value = false
      if (boundary === 'email') auth.user.value!.emailVerified = false
      if (boundary === 'session') auth.session.value = null
      if (boundary === 'version') auth.session.value!.sessionVersion = 0
      const w = await render()
      expect(w.find('[data-quick-csv]').exists()).toBe(false)
      expect(mocks.read).not.toHaveBeenCalled()
    }
  )
  it('does not read invalid CSV or silently truncate oversized batches', async () => {
    const w = await render()
    await preview(w, 'referencia,cantidad\nSKU-1,0')
    expect(w.get('[data-quick-error]').attributes('role')).toBe('alert')
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it('distinguishes loading, network error, malformed response and no exact match without writes', async () => {
    const waiting = deferred()
    mocks.read.mockReturnValueOnce(waiting.promise)
    const w = await render()
    await preview(w)
    expect(w.get('[data-quick-loading]').attributes('role')).toBe('status')
    waiting.resolve({ items: [] })
    await flushPromises()
    expect(w.text()).toContain('ninguna variante')
    expect(w.find('[data-quick-select]').exists()).toBe(false)
    mocks.read.mockRejectedValueOnce(new Error('offline'))
    await preview(w)
    expect(w.text()).toContain('consultar')
    mocks.read.mockResolvedValueOnce({ items: null })
    await preview(w)
    expect(w.text()).toContain('no válida')
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it('blocks fuzzy matches and invalid quantities but permits selection of another valid row', async () => {
    const w = await render()
    await preview(w, 'referencia,cantidad\nProducto,2\nSKU-2,3\nSKU-3,2')
    expect(w.findAll('[data-quick-select]')).toHaveLength(1)
    await confirm(w)
    expect(mocks.add).toHaveBeenCalledExactlyOnceWith({ variantId: 3 }, 2)
  })
  it('invalidates preview and confirmation immediately when the input changes', async () => {
    const w = await render()
    await preview(w)
    await w.get('[data-quick-confirm]').setValue(true)
    await w.get('[data-quick-csv]').setValue('referencia,cantidad\nSKU-2,2')
    expect(w.find('[data-quick-add]').exists()).toBe(false)
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it('invalidates confirmation when selection changes', async () => {
    const w = await render()
    await preview(w)
    await w.get('[data-quick-confirm]').setValue(true)
    await w.get('[data-quick-select="0"]').setValue(false)
    expect(w.get('[data-quick-confirm]').element).toHaveProperty('checked', false)
    expect(w.get('[data-quick-add]').attributes('disabled')).toBeDefined()
  })
  it('deduplicates preview and double click add while their real requests are in flight', async () => {
    const read = deferred()
    mocks.read.mockReturnValueOnce(read.promise)
    const w = await render()
    await preview(w)
    await w.get('[data-quick-input]').trigger('submit')
    expect(mocks.read).toHaveBeenCalledOnce()
    read.resolve({ items: [{ slug: 'producto' }] })
    await flushPromises()
    const add = deferred()
    mocks.add.mockReturnValueOnce(add.promise)
    await w.get('[data-quick-confirm]').setValue(true)
    await w.get('[data-quick-add]').trigger('click')
    await w.get('[data-quick-add]').trigger('click')
    expect(mocks.add).toHaveBeenCalledOnce()
    add.resolve(undefined)
    await flushPromises()
  })
  it('blocks all ADD if store already has a pending/recovery mutation', async () => {
    const w = await render()
    await preview(w)
    mocks.blocked = true
    await confirm(w)
    expect(mocks.add).not.toHaveBeenCalled()
    expect(w.text()).toContain('carrito')
  })
  it('stops at the first ambiguous ADD, preserves never attempted rows and never retries the uncertain line', async () => {
    const w = await render()
    await preview(w, 'referencia,cantidad\nSKU-1,2\nSKU-2,2\nSKU-3,2')
    mocks.add.mockImplementationOnce(async () => {
      mocks.blocked = true
      throw new Error('lost response')
    })
    await confirm(w)
    expect(mocks.add).toHaveBeenCalledOnce()
    expect(w.text()).toContain('resultado incierto')
    expect(w.text()).toContain('2 filas sin intentar')
    expect(w.text()).not.toContain('no añadida')
    await w.get('[data-quick-resume]').trigger('click')
    expect(mocks.read).toHaveBeenCalledTimes(4)
    mocks.blocked = false
    await w.get('[data-quick-resume]').trigger('click')
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledOnce()
    expect(w.text()).not.toContain('SKU-1')
    await confirm(w)
    expect(mocks.add.mock.calls.map((call) => call[0].variantId)).toEqual([1, 2, 3])
    expect(w.text()).not.toContain('3 adiciones confirmadas')
  })
  it('does not classify an attempted uncertain row as never attempted when a later line fails', async () => {
    const w = await render()
    await preview(w, 'referencia,cantidad\nSKU-1,2\nSKU-2,2\nSKU-3,2')
    mocks.add.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('uncertain'))
    await confirm(w)
    expect(mocks.add).toHaveBeenCalledTimes(2)
    expect(w.text()).toContain('1 adición confirmada')
    expect(w.text()).toContain('1 filas sin intentar')
    await w.get('[data-quick-resume]').trigger('click')
    await flushPromises()
    await confirm(w)
    expect(mocks.add.mock.calls.map((call) => call[0].variantId)).toEqual([1, 2, 3])
  })
  it.each(['identity', 'email', 'session', 'version', 'logout', 'loading'])(
    'purges drafts/results/confirmation on current scope boundary %s',
    async (boundary) => {
      const w = await render()
      await preview(w)
      if (boundary === 'identity') auth.user.value!.id = '71000000-0000-4000-8000-000000000002'
      if (boundary === 'email') auth.user.value!.emailVerified = false
      if (boundary === 'session') auth.session.value!.sessionId = '72000000-0000-4000-8000-000000000002'
      if (boundary === 'version') auth.session.value!.sessionVersion = 2
      if (boundary === 'logout') auth.loggedIn.value = false
      if (boundary === 'loading') auth.ready.value = false
      await flushPromises()
      expect(w.text()).not.toContain('Producto observado')
      expect(w.find('[data-quick-add]').exists()).toBe(false)
      if (w.find('[data-quick-csv]').exists()) expect(w.get('[data-quick-csv]').element).toHaveProperty('value', '')
      expect(mocks.read).toHaveBeenCalledTimes(2)
    }
  )
  it('ignores late search results and stops further detail reads after revocation', async () => {
    const wait = deferred()
    mocks.read.mockReturnValueOnce(wait.promise)
    const w = await render()
    await preview(w)
    auth.user.value!.emailVerified = false
    await flushPromises()
    wait.resolve({ items: [{ slug: 'producto' }] })
    await flushPromises()
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(w.text()).not.toContain('Producto observado')
  })
  it('stops remaining adds and late feedback after scope change while ADD awaits, without resetting store recovery', async () => {
    const wait = deferred()
    mocks.add.mockReturnValueOnce(wait.promise)
    const w = await render()
    await preview(w, 'referencia,cantidad\nSKU-1,2\nSKU-2,2')
    await w.get('[data-quick-confirm]').setValue(true)
    await w.get('[data-quick-add]').trigger('click')
    auth.session.value!.sessionVersion = 2
    await flushPromises()
    mocks.blocked = true
    wait.resolve(undefined)
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledOnce()
    expect(mocks.blocked).toBe(true)
    expect(w.text()).not.toContain('confirmada')
    expect(w.text()).not.toContain('Producto observado')
  })
  it('purges component state on unmount and ignores late reads', async () => {
    const wait = deferred()
    mocks.read.mockReturnValueOnce(wait.promise)
    const w = await render()
    await preview(w)
    const state = w.vm.$.setupState
    w.unmount()
    wait.resolve({ items: [{ slug: 'producto' }] })
    await flushPromises()
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(state.csv).toBe('')
    expect(state.rows).toEqual([])
  })
  it('has keyboard forms, live feedback and a bounded mobile list rather than a wide table', async () => {
    const w = await render()
    await preview(w)
    expect(w.get('[data-quick-input]').element.tagName).toBe('FORM')
    expect(w.get('[data-quick-results]').element.tagName).toBe('UL')
    expect(w.find('table').exists()).toBe(false)
    expect(w.find('[aria-live="polite"]').exists()).toBe(true)
    expect(w.get('[data-quick-results]').attributes('class')).toContain('break-words')
  })
})
