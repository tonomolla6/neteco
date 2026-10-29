import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrderFiscalSection from '../../app/components/OrderFiscalSection.vue'
import type { FiscalOrderView } from '../../shared/fiscal-issuance'
import '#app/nuxt-vitest-app-entry'

const { read, post, sessionMock } = vi.hoisted(() => ({ read: vi.fn(), post: vi.fn(), sessionMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => read)
mockNuxtImport('$fetch', () => post)
mockNuxtImport('useUserSession', () => sessionMock)
const ACTOR = '10000000-0000-4000-8000-000000000043',
  OTHER = '10000000-0000-4000-8000-000000000044',
  ORDER = '30000000-0000-4000-8000-000000000043',
  NEXT = '30000000-0000-4000-8000-000000000044'
const session = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref<{ id: string; emailVerified: boolean; mfaVerified: boolean } | null>({
    id: ACTOR,
    emailVerified: true,
    mfaVerified: true
  })
})
const context = (orderId = ORDER): FiscalOrderView => ({
  orderId,
  status: 'completed',
  intentId: '40000000-0000-4000-8000-000000000043',
  generation: 1,
  provider: 'beply',
  validationOnly: false,
  code: 'WEB-123',
  fiscalStatus: 'issued',
  amountCents: 12100,
  currency: 'EUR',
  pdfAvailable: true,
  lastErrorCode: null,
  capabilities: { reconcile: false, edit: false, issueRetry: false, creditNote: false }
})
let currentSession: ReturnType<typeof session>
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  currentSession = session()
  sessionMock.mockImplementation(() => currentSession)
  read.mockReset()
  post.mockReset()
  read.mockResolvedValue(context())
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
async function render(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(OrderFiscalSection, {
    props: { orderId: ORDER, runtime: 'cloudflare', audience: 'admin', ...props }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
describe('confirmed private fiscal order section', () => {
  it.each(['uncertain', 'reconciling'] as const)(
    'shows recovery without an issued/download claim when %s has a durable receipt',
    async (status) => {
      read.mockResolvedValue({
        ...context(),
        status,
        pdfAvailable: false,
        capabilities: { reconcile: status === 'uncertain', edit: false, issueRetry: false, creditNote: false }
      })
      const wrapper = await render()
      expect(wrapper.find('[data-testid="fiscal-read-error"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('WEB-123')
      expect(wrapper.text()).toContain('No reintentes la emisión')
      expect(wrapper.text()).not.toContain('Factura emitida')
      expect(wrapper.find('a').exists()).toBe(false)
    }
  )
  it('reads exact private admin endpoint without retry/cache and never invents an admin PDF route or mutation', async () => {
    const wrapper = await render()
    expect(read.mock.calls[0]).toEqual([
      `/api/admin/orders/${ORDER}/fiscal`,
      { method: 'GET', retry: 0, cache: 'no-store' }
    ])
    expect(wrapper.text()).toContain('Factura emitida')
    expect(wrapper.text()).toContain('WEB-123')
    expect(wrapper.find('a').exists()).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })
  it.each(['ready', 'loggedIn', 'emailVerified', 'mfaVerified'])(
    'does not fetch without current admin %s',
    async (flag) => {
      if (flag === 'ready') currentSession.ready.value = false
      if (flag === 'loggedIn') currentSession.loggedIn.value = false
      if (flag === 'emailVerified') currentSession.user.value!.emailVerified = false
      if (flag === 'mfaVerified') currentSession.user.value!.mfaVerified = false
      const wrapper = await render()
      expect(read).not.toHaveBeenCalled()
      expect(wrapper.text()).not.toContain('WEB-123')
    }
  )
  it.each([{ orderId: '../private' }, { runtime: 'node' }, { audience: 'other' }])(
    'rejects unowned inputs %#',
    async (props) => {
      const wrapper = await render(props)
      expect(read).not.toHaveBeenCalled()
      expect(wrapper.text()).not.toContain('WEB-123')
    }
  )
  it('customer download is only the protected same-origin endpoint without token or referrer', async () => {
    currentSession.user.value!.mfaVerified = false
    const wrapper = await render({ audience: 'customer', orderAccessConfirmed: true })
    expect(read.mock.calls[0]?.[0]).toBe(`/api/orders/${ORDER}/fiscal`)
    expect(wrapper.get('a').attributes()).toMatchObject({
      href: `/api/orders/${ORDER}/invoice`,
      referrerpolicy: 'no-referrer'
    })
    expect(wrapper.html()).not.toMatch(/token=|storage_key|fiscal\//)
  })
  it('guest uses only an explicitly confirmed current order and never assumes login grants ownership', async () => {
    currentSession.loggedIn.value = false
    currentSession.user.value = null
    const wrapper = await render({ audience: 'customer' })
    expect(read).not.toHaveBeenCalled()
    await wrapper.setProps({ orderAccessConfirmed: true })
    await flushPromises()
    expect(read.mock.calls[0]?.[0]).toBe(`/api/orders/${ORDER}/fiscal`)
    await wrapper.setProps({ orderAccessConfirmed: false })
    await flushPromises()
    expect(wrapper.find('a').exists()).toBe(false)
  })
  it.each(['synthetic', 'pending', 'uncertain'])('labels %s truthfully, never auto-retrying issuance', async (kind) => {
    if (kind === 'synthetic') read.mockResolvedValue({ ...context(), provider: 'local_fake', validationOnly: true })
    if (kind === 'pending') read.mockResolvedValue({ ...context(), fiscalStatus: 'fiscal_pending' })
    if (kind === 'uncertain')
      read.mockResolvedValue({
        ...context(),
        status: 'uncertain',
        code: null,
        fiscalStatus: null,
        pdfAvailable: false,
        capabilities: { reconcile: true, edit: false, issueRetry: false, creditNote: false }
      })
    const wrapper = await render()
    expect(wrapper.text()).not.toContain('Factura emitida')
    expect(wrapper.text()).toContain(
      kind === 'synthetic'
        ? 'Sin validez fiscal'
        : kind === 'pending'
          ? 'Estado fiscal pendiente'
          : 'No reintentes la emisión'
    )
    expect(post).not.toHaveBeenCalled()
    expect(wrapper.find('a').exists()).toBe(false)
  })
  it.each(['network', 'shape', 'other_order'])(
    'clears facts on %s instead of turning failure into a missing invoice',
    async (kind) => {
      const wrapper = await render()
      if (kind === 'network') read.mockRejectedValueOnce(new Error('secret SQL'))
      if (kind === 'shape') read.mockResolvedValueOnce({ status: 'completed' })
      if (kind === 'other_order') read.mockResolvedValueOnce(context(NEXT))
      await wrapper.get('[data-testid="fiscal-refresh"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="fiscal-read-error"]').exists()).toBe(true)
      expect(wrapper.text()).not.toMatch(/WEB-123|secret SQL|Pendiente de emisión/)
    }
  )
  it('clears old data before a manual read and coalesces reloads', async () => {
    const wrapper = await render(),
      pending = deferred<FiscalOrderView>()
    read.mockReturnValueOnce(pending.promise)
    await wrapper.get('[data-testid="fiscal-refresh"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('WEB-123')
    expect(wrapper.find('[data-testid="fiscal-loading"]').exists()).toBe(true)
    await wrapper.get('[data-testid="fiscal-refresh"]').trigger('click')
    expect(read).toHaveBeenCalledTimes(2)
    pending.resolve(context())
    await flushPromises()
    expect(wrapper.text()).toContain('WEB-123')
  })
  it.each(['logout', 'actor', 'order', 'mfa', 'unmount'])(
    'cannot restore private facts from a stale read after %s',
    async (change) => {
      const wrapper = await render(),
        pending = deferred<FiscalOrderView>()
      read.mockReturnValueOnce(pending.promise)
      await wrapper.get('[data-testid="fiscal-refresh"]').trigger('click')
      await flushPromises()
      if (change === 'logout') currentSession.loggedIn.value = false
      if (change === 'actor') {
        read.mockResolvedValue({ ...context(), code: 'NEW-ACTOR' })
        currentSession.user.value!.id = OTHER
      }
      if (change === 'order') {
        read.mockResolvedValue({ ...context(NEXT), code: 'NEW-ORDER' })
        await wrapper.setProps({ orderId: NEXT })
      }
      if (change === 'mfa') currentSession.user.value!.mfaVerified = false
      if (change === 'unmount') wrapper.unmount()
      await flushPromises()
      pending.resolve(context())
      await flushPromises()
      if (change !== 'unmount') expect(wrapper.text()).not.toContain('WEB-123')
      expect(post).not.toHaveBeenCalled()
    }
  )
})
