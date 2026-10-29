import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import AdminSupportSection from '../../app/components/AdminSupportSection.vue'
import CustomerSupportSection from '../../app/components/CustomerSupportSection.vue'
import SupportContactSection from '../../app/components/SupportContactSection.vue'
import AdminSupportPanel from '../../app/components/AdminSupportPanel.vue'
import CustomerSupportPanel from '../../app/components/CustomerSupportPanel.vue'
import {
  ACTOR,
  OTHER,
  REF,
  options,
  adminContext,
  customerContext,
  listContext,
  receipt,
  deferred
} from './support-operations-fixture'
import '#app/nuxt-vitest-app-entry'
const { read, post, sessionMock } = vi.hoisted(() => ({ read: vi.fn(), post: vi.fn(), sessionMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => read)
mockNuxtImport('$fetch', () => post)
mockNuxtImport('useUserSession', () => sessionMock)
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
let actor: ReturnType<typeof session>
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  actor = session()
  sessionMock.mockImplementation(() => actor)
  read.mockReset()
  post.mockReset()
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
async function admin(props: Record<string, unknown> = {}) {
  if (!read.getMockImplementation())
    read.mockImplementation(async (url) => (url === '/api/admin/support' ? listContext(true) : adminContext()))
  const wrapper = await mountSuspended(AdminSupportSection, {
    props: { runtime: 'cloudflare', ...props },
    global: { components: { AdminSupportPanel }, stubs: { AdminSupportPanel: false } }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
async function customer(props: Record<string, unknown> = {}) {
  if (!read.getMockImplementation())
    read.mockImplementation(async (url) => (url === '/api/account/support' ? listContext() : customerContext()))
  const wrapper = await mountSuspended(CustomerSupportSection, {
    props: { runtime: 'cloudflare', ...props },
    global: { components: { CustomerSupportPanel }, stubs: { CustomerSupportPanel: false } }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
async function select(wrapper: Awaited<ReturnType<typeof admin>>) {
  const button = wrapper.findAll('button').find((item) => item.text().includes(REF))!
  await button.trigger('click')
  await flushPromises()
}
describe('support sections confirmed server reads and ownership lifetimes', () => {
  it('admin list and selected publicRef are strict fresh GETs, never legacy UUID', async () => {
    const wrapper = await admin()
    expect(read.mock.calls[0]).toMatchObject(['/api/admin/support', { method: 'GET', retry: 0, cache: 'no-store' }])
    await select(wrapper)
    expect(read.mock.calls[1]?.[0]).toBe('/api/admin/support/' + REF)
    expect(wrapper.text()).toContain('PRIVATE_INTERNAL_SENTINEL')
    expect(post).not.toHaveBeenCalled()
  })
  it('customer portal reads real private namespace and public-only confirmed detail', async () => {
    const wrapper = await customer()
    await select(wrapper)
    expect(read.mock.calls[1]?.[0]).toBe('/api/account/support/' + REF)
    expect(wrapper.text()).toContain('Producto histórico')
    expect(wrapper.text()).not.toContain('PRIVATE_INTERNAL_SENTINEL')
  })
  it.each(['node', 'unknown'])('does not fetch foreign runtime %s', async (runtime) => {
    const wrapper = await admin({ runtime })
    expect(read).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain(REF)
  })
  it('admin requires verified email and MFA before any read', async () => {
    actor.user.value!.mfaVerified = false
    await admin()
    expect(read).not.toHaveBeenCalled()
  })
  it('customer verified ownership does not invent an MFA requirement', async () => {
    actor.user.value!.mfaVerified = false
    const wrapper = await customer()
    expect(read).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain(REF)
  })
  it('unverified customer blocks before reads', async () => {
    actor.user.value!.emailVerified = false
    await customer()
    expect(read).not.toHaveBeenCalled()
  })
  it('undefined/invalid list is failure, never empty history', async () => {
    read.mockResolvedValueOnce(undefined)
    const wrapper = await admin()
    expect(wrapper.find('[data-testid="admin-support-read-error"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Cola confirmada sin coincidencias')
  })
  it('manual GET is single-flight and old writable facts disappear immediately', async () => {
    const wrapper = await admin(),
      hold = deferred<unknown>()
    read.mockReturnValueOnce(hold.promise)
    await wrapper.get('[data-testid="admin-support-refresh"]').trigger('click')
    await wrapper.get('[data-testid="admin-support-refresh"]').trigger('click')
    expect(read).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain(REF)
    hold.resolve(undefined)
    await flushPromises()
    expect(wrapper.find('[data-testid="admin-support-read-error"]').exists()).toBe(true)
  })
  it('logout clears private contact and late GET cannot restore prior facts', async () => {
    const wrapper = await admin()
    await select(wrapper)
    const hold = deferred<unknown>()
    read.mockReturnValueOnce(hold.promise)
    const refresh = wrapper.findAll('button').find((button) => button.text() === 'Actualizar ticket')!
    await refresh.trigger('click')
    actor.loggedIn.value = false
    actor.user.value = null
    hold.resolve(adminContext())
    await flushPromises()
    expect(wrapper.text()).not.toContain('private@example.invalid')
    expect(wrapper.text()).not.toContain(REF)
    expect(wrapper.findComponent(AdminSupportPanel).exists()).toBe(false)
  })
  it('changing identity clears selected ticket and discards old pending context', async () => {
    const wrapper = await admin()
    await select(wrapper)
    actor.user.value!.id = OTHER
    await flushPromises()
    expect(wrapper.findComponent(AdminSupportPanel).exists()).toBe(false)
    expect(read.mock.calls.at(-1)?.[0]).toBe('/api/admin/support')
  })
  it('temporary MFA loss hides detail but keeps panel instance for same actor', async () => {
    const wrapper = await admin()
    await select(wrapper)
    const uid = wrapper.findComponent(AdminSupportPanel).vm.$.uid
    actor.user.value!.mfaVerified = false
    await flushPromises()
    expect(wrapper.findComponent(AdminSupportPanel).vm.$.uid).toBe(uid)
    expect(wrapper.text()).not.toContain('PRIVATE_INTERNAL_SENTINEL')
    actor.user.value!.mfaVerified = true
    await flushPromises()
    expect(wrapper.findComponent(AdminSupportPanel).vm.$.uid).toBe(uid)
    expect(wrapper.text()).toContain('PRIVATE_INTERNAL_SENTINEL')
  })
  it('customer failed list never renders an artificial empty-state', async () => {
    read.mockRejectedValueOnce(new Error('D1_unconfirmed'))
    const wrapper = await customer()
    expect(wrapper.find('[data-testid="customer-support-read-error"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('No hay consultas confirmadas')
  })
  it('customer stale read after identity change is ignored', async () => {
    const wrapper = await customer(),
      hold = deferred<unknown>()
    read.mockReturnValueOnce(hold.promise)
    await wrapper.get('[data-testid="customer-support-refresh"]').trigger('click')
    actor.user.value!.id = OTHER
    read.mockResolvedValueOnce({
      ...listContext(),
      items: [],
      pagination: { page: 1, perPage: 25, total: 0, pages: 0 }
    })
    await flushPromises()
    hold.resolve(listContext())
    await flushPromises()
    expect(wrapper.text()).not.toContain(REF)
  })
  it('anonymous contact reads policy only and never claims identity by cookie', async () => {
    actor.loggedIn.value = false
    actor.user.value = null
    read.mockResolvedValueOnce(options())
    const wrapper = await mountSuspended(SupportContactSection, { props: { runtime: 'cloudflare' } })
    mounted.push(wrapper)
    await flushPromises()
    expect(read.mock.calls[0]?.[0]).toBe('/api/support/options')
    expect(post).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Producto histórico')
  })
  it('contact missing policy/unavailable GET blocks mutation instead of cached writable form', async () => {
    read.mockRejectedValueOnce(new Error('edge_limiter_unavailable'))
    const wrapper = await mountSuspended(SupportContactSection, { props: { runtime: 'cloudflare' } })
    mounted.push(wrapper)
    await flushPromises()
    expect(wrapper.find('[data-testid="support-options-error"]').exists()).toBe(true)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })
  it('contact session not ready does not silently downgrade authenticated user to guest', async () => {
    actor.ready.value = false
    const wrapper = await mountSuspended(SupportContactSection, { props: { runtime: 'cloudflare' } })
    mounted.push(wrapper)
    await flushPromises()
    expect(read).not.toHaveBeenCalled()
  })
  it('catalogue intake freezes exact slugs and explicitly recovers the same key and body', async () => {
    read.mockResolvedValue(options())
    const wrapper = await mountSuspended(SupportContactSection, {
      props: { runtime: 'cloudflare', productSlug: 'limpiador-neutro', categorySlug: 'higiene' }
    })
    mounted.push(wrapper)
    await flushPromises()
    await prepareContact(wrapper)
    expect(post).not.toHaveBeenCalled()
    post.mockRejectedValueOnce(new Error('lost_response'))
    await wrapper.get('[data-testid="support-contact-send"]').trigger('click')
    await flushPromises()
    expect(post).toHaveBeenCalledTimes(1)
    const original = post.mock.calls[0]![1]
    expect(original.body).toMatchObject({ productSlug: 'limpiador-neutro', categorySlug: 'higiene' })
    expect(original.body).not.toHaveProperty('orderId')
    post.mockResolvedValueOnce(receipt(1))
    await wrapper.get('[data-testid="support-contact-recover"]').trigger('click')
    await flushPromises()
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1]![1]).toMatchObject({ body: original.body, headers: original.headers })
  })
  it('a new catalogue context discards the previous prepared private draft without sending', async () => {
    read.mockResolvedValue(options())
    const wrapper = await mountSuspended(SupportContactSection, {
      props: { runtime: 'cloudflare', productSlug: 'producto-anterior', categorySlug: 'higiene' }
    })
    mounted.push(wrapper)
    await flushPromises()
    await prepareContact(wrapper)
    expect(wrapper.find('[data-testid="support-contact-send"]').exists()).toBe(true)
    await wrapper.setProps({ productSlug: 'producto-actual', categorySlug: 'papel' })
    await flushPromises()
    expect(wrapper.find('[data-testid="support-contact-send"]').exists()).toBe(false)
    expect((wrapper.get('[data-testid="support-email"]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('[data-testid="support-body"]').element as HTMLTextAreaElement).value).toBe('')
    expect(post).not.toHaveBeenCalled()
  })
  it('lost authority hides private intake and ignores a late response from the old context', async () => {
    const hold = deferred<unknown>()
    read.mockResolvedValue(options())
    const wrapper = await mountSuspended(SupportContactSection, {
      props: { runtime: 'cloudflare', productSlug: 'limpiador-neutro' }
    })
    mounted.push(wrapper)
    await flushPromises()
    await prepareContact(wrapper)
    post.mockReturnValueOnce(hold.promise)
    await wrapper.get('[data-testid="support-contact-send"]').trigger('click')
    await flushPromises()
    actor.loggedIn.value = false
    actor.user.value = null
    await flushPromises()
    hold.resolve(receipt(1))
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.find('[data-testid="support-contact-recover"]').exists()).toBe(false)
    expect((wrapper.get('[data-testid="support-email"]').element as HTMLInputElement).value).toBe('')
    expect(post).toHaveBeenCalledTimes(1)
  })
  it('email verification revocation purges private draft even when the same actor regains access', async () => {
    read.mockResolvedValue(options())
    const wrapper = await mountSuspended(SupportContactSection, {
      props: { runtime: 'cloudflare', categorySlug: 'higiene' }
    })
    mounted.push(wrapper)
    await flushPromises()
    await wrapper.get('[data-testid="support-email"]').setValue('private-draft@example.invalid')
    await wrapper.get('[data-testid="support-body"]').setValue('Private draft to purge')
    actor.user.value!.emailVerified = false
    await flushPromises()
    expect(wrapper.find('[data-testid="support-email"]').exists()).toBe(false)
    actor.user.value!.emailVerified = true
    await flushPromises()
    expect((wrapper.get('[data-testid="support-email"]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('[data-testid="support-body"]').element as HTMLTextAreaElement).value).toBe('')
    expect(post).not.toHaveBeenCalled()
  })
  it('same actor cannot send an old prepared intention after verification revocation and restoration', async () => {
    read.mockResolvedValue(options())
    const wrapper = await mountSuspended(SupportContactSection, {
      props: { runtime: 'cloudflare', productSlug: 'limpiador-neutro' }
    })
    mounted.push(wrapper)
    await flushPromises()
    await prepareContact(wrapper)
    actor.user.value!.emailVerified = false
    await flushPromises()
    actor.user.value!.emailVerified = true
    await flushPromises()
    expect(wrapper.find('[data-testid="support-contact-send"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="support-contact-recover"]').exists()).toBe(false)
    expect((wrapper.get('[data-testid="support-email"]').element as HTMLInputElement).value).toBe('')
    expect(post).not.toHaveBeenCalled()
  })
})

async function prepareContact(wrapper: Awaited<ReturnType<typeof mountSuspended>>) {
  await wrapper.get('[data-testid="support-name"]').setValue('Cliente sintético')
  await wrapper.get('[data-testid="support-email"]').setValue('buyer@example.invalid')
  await wrapper.get('[data-testid="support-subject"]').setValue('Consulta del catálogo')
  await wrapper.get('[data-testid="support-body"]').setValue('Consulta contextual de producto y categoría')
  await wrapper.get('[data-testid="support-privacy"]').setValue(true)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
