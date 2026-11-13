import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QuickOrderPanel from '../../app/components/QuickOrderPanel.vue'
import QuickOrderPage from '../../app/pages/pedido-rapido.vue'
import '#app/nuxt-vitest-app-entry'

// Matrix: one screen, three entries (type, paste, file) in every runtime; exact variant with
// its quantity rules; unknown references never block the rest; adds go through cart.add one by
// one, stop at the first uncertain result and are never resent; session changes purge the list.
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  add: vi.fn(),
  session: vi.fn(),
  blocked: false,
  runtime: 'node' as 'node' | 'cloudflare'
}))
const nuxtRuntime = vi.hoisted(() => ({ original: null as null | (() => { public: Record<string, unknown> }) }))
mockNuxtImport('useRequestFetch', () => () => mocks.read)
mockNuxtImport('useRuntimeConfig', (original) => {
  nuxtRuntime.original = original as never
  return () => {
    const config = nuxtRuntime.original!()
    return { ...config, public: { ...config.public, serverRuntime: mocks.runtime, priceDisplayMode: 'gross' } }
  }
})
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
const variant = (id: number, overrides = {}) => ({
  uuid: `73000000-0000-4000-8000-0000000000${String(id).padStart(2, '0')}`,
  id,
  sku: `10${id}`,
  ean: null,
  gtin: null,
  mpn: null,
  format: 'Garrafa 5 L',
  unitLabel: 'L',
  price: 1210,
  priceTiers: [{ minimumQuantity: 6, unitGrossCents: 1089 }],
  pricingVersion: 'published-price-1',
  taxRateBasisPoints: 2100,
  minimumQuantity: 2,
  maximumQuantity: null,
  quantityIncrement: 2,
  stock: 40,
  backorderAllowed: false,
  ...overrides
})
/** Catalog: references 101…112 exist, one product each. Anything else is unknown. */
function catalog(path: string, options?: { query?: { q: string } }) {
  if (path === '/api/search') {
    const q = options!.query!.q
    const id = Number(q.slice(2))
    if (/^10\d{1,2}$/.test(q) && id >= 1 && id <= 12) return { items: [{ slug: `producto-${id}` }] }
    if (q === '10') return { items: [{ slug: 'producto-1' }] }
    return { items: [] }
  }
  const id = Number(path.split('-').at(-1))
  return { slug: `producto-${id}`, name: `Desengrasante ${id}`, variants: [variant(id)] }
}

let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref<{ id: string; email: string; emailVerified: boolean } | null>>
  session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number } | null>>
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const wrappers: Wrapper[] = []
async function render(component: typeof QuickOrderPanel | typeof QuickOrderPage = QuickOrderPanel) {
  const wrapper = await mountSuspended(component, { attachTo: document.body })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
const rows = (w: Wrapper) => w.findAll('[data-quick-row]')
async function type(w: Wrapper, index: number, reference: string) {
  const input = rows(w)[index]!.get('[data-quick-reference]')
  await input.setValue(reference)
  await input.trigger('keydown', { key: 'Enter' })
  await flushPromises()
  await nextTick()
}
async function paste(w: Wrapper, text: string) {
  await w.get('[data-quick-tab="paste"]').trigger('click')
  await w.get('[data-quick-paste]').setValue(text)
  await w.get('[data-quick-paste-apply]').trigger('click')
  await flushPromises()
  await nextTick()
}
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((yes) => {
    resolve = yes
  })
  return { resolve, promise }
}

beforeEach(() => {
  mocks.read.mockReset().mockImplementation(async (path: string, options?: never) => catalog(path, options))
  mocks.add.mockReset().mockResolvedValue(undefined)
  mocks.blocked = false
  mocks.runtime = 'node'
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ID, email: 'synthetic@example.invalid', emailVerified: true }),
    session: ref({ sessionId: SESSION, sessionVersion: 1 })
  }
  mocks.session.mockReturnValue(auth)
})
afterEach(() => wrappers.splice(0).forEach((w) => w.unmount()))

describe('quick order by reference', () => {
  it.each(['node', 'cloudflare'] as const)(
    'is one working screen in the %s runtime, in the customer language',
    async (runtime) => {
      mocks.runtime = runtime
      const w = await render(QuickOrderPage)
      expect(w.findAll('h1')).toHaveLength(1)
      expect(w.get('h1').text()).toBe('Pedido rápido por referencia')
      expect(w.text()).toContain('Escribe las referencias de tu albarán o pega la lista entera.')
      expect(w.findAll('[role="tab"]').map((tab) => tab.text())).toEqual(['Teclear', 'Pegar lista', 'Subir archivo'])
      expect(w.text()).not.toMatch(/Cloudflare|SKU|EAN|CSV|KiB|idempot/i)
      expect(rows(w)).toHaveLength(1)
      expect(mocks.read).not.toHaveBeenCalled()
    }
  )

  it('typing a reference and Enter shows product, format and price, and moves to the quantity', async () => {
    const w = await render()
    await type(w, 0, '101')
    const row = rows(w)[0]!
    expect(row.text()).toContain('Desengrasante 1')
    expect(row.text()).toContain('Garrafa 5 L')
    expect(row.text().replace(/\s+/g, ' ')).toContain('12,10 €')
    const quantity = row.get('input[inputmode="numeric"]')
    // the minimum of the variant, not an invalid 1
    expect((quantity.element as HTMLInputElement).value).toBe('2')
    expect(document.activeElement).toBe(quantity.element)
    // a fresh row is ready for the next reference; Enter on the quantity goes there
    expect(rows(w)).toHaveLength(2)
    await quantity.trigger('keydown', { key: 'Enter' })
    await nextTick()
    expect(document.activeElement).toBe(rows(w)[1]!.get('[data-quick-reference]').element)
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it('reprices the line with the volume tier as the quantity changes and totals the order', async () => {
    const w = await render()
    await type(w, 0, '101')
    await type(w, 1, '102')
    const text = () => w.get('[data-quick-total]').text().replace(/\s+/g, ' ')
    expect(text()).toContain('2 referencias')
    expect(text()).toContain('48,40 €')
    const quantity = rows(w)[0]!.get('input[inputmode="numeric"]')
    await quantity.setValue('6')
    await quantity.trigger('change')
    await nextTick()
    expect(rows(w)[0]!.text().replace(/\s+/g, ' ')).toContain('10,89 €')
    expect(rows(w)[0]!.text().replace(/\s+/g, ' ')).toContain('65,34 €')
    expect(text()).toContain('89,54 €')
  })

  it('pasting ten lines creates ten rows, each with its quantity', async () => {
    const w = await render()
    await paste(w, Array.from({ length: 10 }, (_, i) => `10${i + 1}\t${(i + 1) * 2}`).join('\n'))
    const filled = rows(w).filter((row) => row.find('[data-quick-line-total]').exists())
    expect(filled).toHaveLength(10)
    expect((filled[9]!.get('input[inputmode="numeric"]').element as HTMLInputElement).value).toBe('20')
    expect(w.get('[data-quick-tab="type"]').attributes('aria-selected')).toBe('true')
    expect(w.get('[data-quick-total]').text()).toContain('10 referencias')
  })

  it('an unknown reference is marked, suggests the closest one and never blocks the rest', async () => {
    const w = await render()
    await paste(w, '101 2\n10 2\n999 2\n102 4')
    const [first, near, unknown] = rows(w)
    expect(first!.find('[data-quick-line-total]').exists()).toBe(true)
    expect(near!.get('[role="alert"]').text()).toContain('No encontramos «10».')
    expect(near!.text()).toContain('¿Es 101 · Desengrasante 1?')
    expect(unknown!.get('[role="alert"]').text()).toBe('No encontramos «999».')
    await w.get('[data-quick-add]').trigger('click')
    await flushPromises()
    expect(mocks.add.mock.calls.map(([item, quantity]) => [item.variantId, quantity])).toEqual([
      [1, 2],
      [2, 4]
    ])
    expect(w.get('[data-quick-notice]').text()).toContain('2 referencias añadidas al carrito')
  })

  it('applies a suggestion only when the customer asks for it', async () => {
    const w = await render()
    await type(w, 0, '10')
    expect(mocks.add).not.toHaveBeenCalled()
    await rows(w)[0]!.get('[data-quick-suggestion]').trigger('click')
    await flushPromises()
    expect((rows(w)[0]!.get('[data-quick-reference]').element as HTMLInputElement).value).toBe('101')
    expect(rows(w)[0]!.text()).toContain('Desengrasante 1')
  })

  it('refuses the same product twice and a product without stock', async () => {
    mocks.read.mockImplementation(async (path: string, options?: never) => {
      const value = catalog(path, options) as { variants?: Array<Record<string, unknown>> }
      if (path.endsWith('producto-3')) value.variants = [variant(3, { stock: 0 })]
      return value
    })
    const w = await render()
    await type(w, 0, '101')
    await type(w, 1, '101')
    expect(rows(w)[1]!.get('[role="alert"]').text()).toBe('Esta referencia ya está en la lista.')
    await type(w, 1, '103')
    expect(rows(w)[1]!.get('[role="alert"]').text()).toBe('Esta referencia no se puede pedir online ahora mismo.')
    await w.get('[data-quick-add]').trigger('click')
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledTimes(1)
  })

  it('reads an uploaded text file like a pasted list and offers a template', async () => {
    const w = await render()
    await w.get('[data-quick-tab="file"]').trigger('click')
    expect(w.get('[data-quick-template]').attributes('download')).toBe('pedido-rapido.csv')
    const input = w.get('[data-quick-file]')
    const file = new File(['referencia;cantidad\n101;2\n102;4\n'], 'pedido.csv', { type: 'text/csv' })
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    await flushPromises()
    await vi.waitFor(() => expect(w.get('[data-quick-total]').text()).toContain('2 referencias'))
  })

  it('reports unusable pasted lines next to the list', async () => {
    const w = await render()
    await paste(w, '101 2\n102 muchas')
    expect(w.get('[data-quick-problems]').text()).toContain('Línea 2')
    expect(w.get('[data-quick-problems]').text()).toContain('La cantidad debe ser un número entero entre 1 y 999.')
    expect(w.get('[data-quick-total]').text()).toContain('1 referencia')
  })

  it('adds through the cart one by one, marks added rows and never sends them twice', async () => {
    const w = await render()
    await paste(w, '101 2\n102 4')
    await w.get('[data-quick-add]').trigger('click')
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledTimes(2)
    expect(mocks.add.mock.calls[0]![0]).toMatchObject({ variantId: 1, sku: '101', slug: 'producto-1' })
    expect(rows(w)[0]!.text()).toContain('Añadido al carrito')
    expect(w.find('a[href="/carrito"]').exists()).toBe(true)
    expect(w.get('[data-quick-add]').attributes('disabled')).toBeDefined()
    await w.get('[data-quick-add]').trigger('click')
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledTimes(2)
  })

  it('stops at the first uncertain addition, says so and does not resend that reference', async () => {
    mocks.add.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('timeout'))
    const w = await render()
    await paste(w, '101 2\n102 4\n103 2')
    await w.get('[data-quick-add]').trigger('click')
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledTimes(2)
    expect(w.get('[data-quick-notice]').text()).toContain('1 referencia añadida')
    expect(w.get('[data-quick-notice]').text()).toContain('No sabemos si la referencia 102 se añadió')
    expect(rows(w)[1]!.text()).toContain('Compruébala en el carrito')
    await w.get('[data-quick-add]').trigger('click')
    await flushPromises()
    expect(mocks.add.mock.calls.map(([item]) => item.variantId)).toEqual([1, 2, 3])
  })

  it('does not add while the cart is resolving a previous addition', async () => {
    mocks.blocked = true
    const w = await render()
    await type(w, 0, '101')
    await w.get('[data-quick-add]').trigger('click')
    await flushPromises()
    expect(mocks.add).not.toHaveBeenCalled()
    expect(w.get('[data-quick-notice]').text()).toContain('Revisa primero el carrito')
  })

  it('uses a single in-flight batch: a second click cannot double the order', async () => {
    const gate = deferred()
    mocks.add.mockReturnValueOnce(gate.promise)
    const w = await render()
    await paste(w, '101 2\n102 4')
    void w.get('[data-quick-add]').trigger('click')
    await nextTick()
    await w.get('[data-quick-add]').trigger('click')
    gate.resolve(undefined)
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledTimes(2)
  })

  it('drops a late catalog answer after the session changes and clears the list', async () => {
    const gate = deferred()
    mocks.read.mockReturnValueOnce(gate.promise)
    const w = await render()
    const input = rows(w)[0]!.get('[data-quick-reference]')
    await input.setValue('101')
    void input.trigger('keydown', { key: 'Enter' })
    await nextTick()
    auth.session.value = { sessionId: SESSION, sessionVersion: 2 }
    await nextTick()
    gate.resolve({ items: [{ slug: 'producto-1' }] })
    await flushPromises()
    expect(rows(w)).toHaveLength(1)
    expect(w.text()).not.toContain('Desengrasante 1')
    expect((rows(w)[0]!.get('[data-quick-reference]').element as HTMLInputElement).value).toBe('')
  })

  it('in the Cloudflare runtime asks an unverified account to verify before ordering', async () => {
    mocks.runtime = 'cloudflare'
    auth.user.value = { id: ID, email: 'synthetic@example.invalid', emailVerified: false }
    const w = await render()
    expect(w.find('[data-quick-row]').exists()).toBe(false)
    expect(w.get('[role="status"]').text()).toContain('Verifica el correo de tu cuenta')
  })

  it('says how to continue when the catalog cannot be read', async () => {
    mocks.read.mockRejectedValue(new Error('internal-stack'))
    const w = await render()
    await type(w, 0, '101')
    const alert = rows(w)[0]!.get('[role="alert"]').text()
    expect(alert).toBe('No hemos podido consultar el catálogo. Vuelve a intentarlo.')
    expect(w.text()).not.toContain('internal-stack')
  })
})
