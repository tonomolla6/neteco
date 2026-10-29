import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminGlobalSearch from '../../app/components/AdminGlobalSearch.vue'
import '#app/nuxt-vitest-app-entry'

// UI003 entity search: explicit bounded GET only, no keystroke requests; strict
// canonical DTO/query and parent authority, no local cache or optimistic links.
// Each query/scope/grant/verification change invalidates in-flight results.
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const ORDER = '10000000-0000-4000-8000-000000000001'
const product = () => ({
  kind: 'product',
  id: '123',
  label: 'Producto sintético',
  description: 'SKU-123',
  to: '/admin/productos/123'
})
const order = () => ({
  kind: 'order',
  id: ORDER,
  label: `Pedido ${ORDER}`,
  description: 'Pedido',
  to: `/admin/pedidos/${ORDER}`
})
const response = (query = 'SKU-123', items: unknown[] = [product()]) => ({ source: 'cloudflare', query, items })
const groups = () => [
  {
    label: 'Operación',
    links: [
      { to: '/admin/productos', label: 'Productos', icon: 'package' },
      { to: '/admin/pedidos', label: 'Pedidos', icon: 'receipt' }
    ]
  }
]
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
async function render(props = {}) {
  const wrapper = await mountSuspended(AdminGlobalSearch, {
    props: { scopeKey: 'identity/session/1', enabled: true, pending: false, groups: groups(), ...props },
    global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } }
  })
  mounted.push(wrapper)
  return wrapper
}
async function search(wrapper: Wrapper, value = 'SKU-123') {
  await wrapper.get('input').setValue(value)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
beforeEach(() => {
  mocks.request.mockReset().mockResolvedValue(response())
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
})

describe('explicit authorized administrative entity search', () => {
  it('stays idle while typing and sends only one normalized bounded no-store GET on explicit submit', async () => {
    const wrapper = await render()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(wrapper.find('[data-search-empty]').exists()).toBe(false)
    await wrapper.get('input').setValue('  SKU-123  ')
    expect(mocks.request).not.toHaveBeenCalled()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      '/api/admin/global-search',
      expect.objectContaining({
        method: 'GET',
        query: { q: 'SKU-123', limit: 10 },
        cache: 'no-store',
        retry: 0
      })
    )
  })
  it('labels the search input and renders canonical keyboard-accessible wrapping product/order links', async () => {
    mocks.request.mockResolvedValueOnce(response('SKU-123', [product(), order()]))
    const wrapper = await render()
    const input = wrapper.get('input')
    expect(wrapper.get(`label[for="${input.attributes('id')}"]`).text()).toContain('Buscar')
    await search(wrapper)
    expect(wrapper.get('section').attributes('aria-labelledby')).toBeTruthy()
    const links = wrapper.findAll('[data-search-item] a')
    expect(links.map((link) => link.attributes('href'))).toEqual([product().to, order().to])
    expect(links.every((link) => link.attributes('tabindex') !== '-1')).toBe(true)
    expect(wrapper.text()).toContain('SKU-123')
    expect(wrapper.get('[data-search-item]').classes()).toContain('break-words')
  })
  it.each(['', 'a', 'x'.repeat(101), 'ab\u0000', 'ab\u007f'])('does not request an invalid query %j', async (query) => {
    const wrapper = await render()
    await search(wrapper, query)
    expect(mocks.request).not.toHaveBeenCalled()
    expect(wrapper.find('[data-search-empty]').exists()).toBe(false)
  })
  it('normalizes Unicode NFC and trim without changing case or literal punctuation', async () => {
    const query = 'Ácido %_\\'
    mocks.request.mockResolvedValueOnce(response(query, []))
    const wrapper = await render()
    await search(wrapper, '  A\u0301cido %_\\  ')
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/admin/global-search',
      expect.objectContaining({ query: { q: query, limit: 10 } })
    )
    expect(wrapper.find('[data-search-empty]').exists()).toBe(true)
  })
  it('singleflights submit and distinguishes loading from confirmed empty', async () => {
    const pending = deferred()
    mocks.request.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    await search(wrapper)
    await wrapper.get('form').trigger('submit')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-search-loading]').attributes('role')).toBe('status')
    expect(wrapper.get('[data-search-loading]').attributes('aria-busy')).toBe('true')
    expect(wrapper.find('[data-search-empty]').exists()).toBe(false)
    pending.resolve(response('SKU-123', []))
    await flushPromises()
    expect(wrapper.get('[data-search-empty]').text()).toContain('No se han encontrado')
  })
  it.each([401, 403, 429, 503])(
    'shows generic read error %s, never a false empty or server-private text',
    async (statusCode) => {
      mocks.request.mockRejectedValueOnce({ statusCode, message: 'SQL token customer@example.invalid' })
      const wrapper = await render()
      await search(wrapper)
      expect(wrapper.get('[data-search-error]').attributes('role')).toBe('alert')
      expect(wrapper.find('[data-search-empty]').exists()).toBe(false)
      expect(wrapper.text()).not.toMatch(/SQL|token|customer@/)
    }
  )
  it('retries the exact failed GET explicitly without concurrent requests', async () => {
    mocks.request.mockRejectedValueOnce(new Error('offline'))
    const wrapper = await render()
    await search(wrapper, '  SKU-123 ')
    const pending = deferred()
    mocks.request.mockReturnValueOnce(pending.promise)
    const retry = wrapper.get('[data-search-retry]')
    await retry.trigger('click')
    await retry.trigger('click')
    expect(mocks.request).toHaveBeenCalledTimes(2)
    expect(mocks.request.mock.calls[1]?.[1].query).toEqual({ q: 'SKU-123', limit: 10 })
    pending.resolve(response())
    await flushPromises()
    expect(wrapper.find('a').exists()).toBe(true)
  })
  it.each(['query', 'source', 'to', 'kind', 'id', 'private', 'overflow', 'duplicate', 'requested-limit'])(
    'rejects unconfirmed DTO %s before displaying any result',
    async (mode) => {
      const dto = response() as { source: string; query: string; items: unknown[] }
      if (mode === 'query') dto.query = 'other'
      if (mode === 'source') dto.source = 'node'
      if (mode === 'to') dto.items = [{ ...product(), to: '/admin/productos/123?token=secret' }]
      if (mode === 'kind') dto.items = [{ ...product(), kind: 'customer' }]
      if (mode === 'id') dto.items = [{ ...product(), id: '124' }]
      if (mode === 'private') dto.items = [{ ...product(), email: 'private@example.invalid' }]
      if (mode === 'duplicate') dto.items = [product(), product()]
      if (mode === 'overflow' || mode === 'requested-limit')
        dto.items = Array.from({ length: mode === 'overflow' ? 21 : 11 }, (_, index) => ({
          ...product(),
          id: String(index + 1),
          to: `/admin/productos/${index + 1}`
        }))
      mocks.request.mockResolvedValueOnce(dto)
      const wrapper = await render()
      await search(wrapper)
      expect(wrapper.find('[data-search-error]').exists()).toBe(true)
      expect(wrapper.find('a').exists()).toBe(false)
      expect(wrapper.text()).not.toMatch(/secret|private@/)
    }
  )
  it.each([{ enabled: false }, { pending: true }, { scopeKey: '' }, { groups: [] }])(
    'does not expose controls or read without current authority %j',
    async (props) => {
      const wrapper = await render(props)
      expect(wrapper.text()).toBe('')
      expect(mocks.request).not.toHaveBeenCalled()
    }
  )
  it('does not show an entity outside the currently authorized navigation sections', async () => {
    mocks.request.mockResolvedValueOnce(response('SKU-123', [order()]))
    const wrapper = await render({ groups: [{ label: 'Catálogo', links: [groups()[0]!.links[0]!] }] })
    await search(wrapper)
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.find('[data-search-error]').exists()).toBe(true)
  })
  it.each(['scope', 'pending', 'enabled', 'groups', 'query'])(
    'purges results on %s change and never automatically repeats the search',
    async (mode) => {
      const wrapper = await render()
      await search(wrapper)
      expect(wrapper.find('a').exists()).toBe(true)
      if (mode === 'query') await wrapper.get('input').setValue('other')
      else
        await wrapper.setProps(
          mode === 'scope'
            ? { scopeKey: 'new/session/2' }
            : mode === 'pending'
              ? { pending: true }
              : mode === 'enabled'
                ? { enabled: false }
                : { groups: [] }
        )
      expect(wrapper.find('a').exists()).toBe(false)
      expect(wrapper.find('[data-search-empty]').exists()).toBe(false)
      expect(mocks.request).toHaveBeenCalledTimes(1)
      if (mode === 'pending') await wrapper.setProps({ pending: false })
      if (mode === 'enabled') await wrapper.setProps({ enabled: true })
      await flushPromises()
      expect(mocks.request).toHaveBeenCalledTimes(1)
    }
  )
  it.each(['scope', 'pending', 'enabled', 'groups', 'query', 'unmount'])(
    'aborts and ignores a late response after %s invalidation',
    async (mode) => {
      const old = deferred()
      mocks.request.mockReturnValueOnce(old.promise)
      const wrapper = await render()
      await search(wrapper)
      const signal = mocks.request.mock.calls[0]?.[1].signal as AbortSignal
      if (mode === 'query') await wrapper.get('input').setValue('other')
      else if (mode === 'unmount') wrapper.unmount()
      else
        await wrapper.setProps(
          mode === 'scope'
            ? { scopeKey: 'new/session/2' }
            : mode === 'pending'
              ? { pending: true }
              : mode === 'enabled'
                ? { enabled: false }
                : { groups: [] }
        )
      expect(signal.aborted).toBe(true)
      old.resolve(response())
      await flushPromises()
      expect(wrapper.find('a').exists()).toBe(false)
      expect(mocks.request).toHaveBeenCalledTimes(1)
    }
  )
  it('never replaces a new explicit search with an older query response', async () => {
    const old = deferred()
    mocks.request.mockReturnValueOnce(old.promise)
    const wrapper = await render()
    await search(wrapper)
    mocks.request.mockResolvedValueOnce(response('new-query', []))
    await search(wrapper, 'new-query')
    expect(wrapper.find('[data-search-empty]').exists()).toBe(true)
    old.resolve(response())
    await flushPromises()
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.find('[data-search-empty]').exists()).toBe(true)
  })
})
