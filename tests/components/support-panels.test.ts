import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, describe, it, expect, vi } from 'vitest'
import AdminSupportPanel from '../../app/components/AdminSupportPanel.vue'
import CustomerSupportPanel from '../../app/components/CustomerSupportPanel.vue'
import SupportContactPanel from '../../app/components/SupportContactPanel.vue'
import {
  ACTOR,
  OTHER,
  REF,
  NEXT_REF,
  options,
  adminContext,
  customerContext,
  receipt,
  deferred
} from './support-operations-fixture'
import '#app/nuxt-vitest-app-entry'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('$fetch', () => request)
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  request.mockReset()
})
async function admin(props: Record<string, unknown> = {}) {
  const authority = ref(true),
    data = ref(adminContext()),
    reload = vi.fn(async () => data.value)
  const wrapper = await mountSuspended(AdminSupportPanel, {
    props: {
      snapshot: data.value,
      publicRef: REF,
      operatorId: ACTOR,
      runtime: 'cloudflare',
      authorize: () => authority.value,
      reload,
      ...props
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  request.mockClear()
  return { wrapper, authority, data, reload }
}
async function customer(props: Record<string, unknown> = {}) {
  const authority = ref(true),
    data = ref(customerContext()),
    reload = vi.fn(async () => data.value)
  const wrapper = await mountSuspended(CustomerSupportPanel, {
    props: {
      snapshot: data.value,
      publicRef: REF,
      operatorId: ACTOR,
      runtime: 'cloudflare',
      authorize: () => authority.value,
      reload,
      ...props
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  request.mockClear()
  return { wrapper, authority, data, reload }
}
async function contact(props: Record<string, unknown> = {}) {
  const data = ref(options()),
    reload = vi.fn(async () => data.value)
  const wrapper = await mountSuspended(SupportContactPanel, {
    props: {
      snapshot: data.value,
      actorId: 'anonymous-contact',
      runtime: 'cloudflare',
      authorize: () => true,
      reload,
      ...props
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  request.mockClear()
  return { wrapper, data, reload }
}
async function prepareAdmin(wrapper: Awaited<ReturnType<typeof admin>>['wrapper'], action = 'reply') {
  await wrapper.get('[data-testid="admin-support-action"]').setValue(action)
  await wrapper.get('[data-testid="admin-support-reason"]').setValue('Documented operational reason')
  if (action !== 'update')
    await wrapper.get('[data-testid="admin-support-body"]').setValue('Public or internal response text')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
async function prepareCustomer(wrapper: Awaited<ReturnType<typeof customer>>['wrapper']) {
  await wrapper.get('[data-testid="customer-support-body"]').setValue('Respuesta de cliente')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
async function prepareContact(wrapper: Awaited<ReturnType<typeof contact>>['wrapper']) {
  await wrapper.get('[data-testid="support-name"]').setValue('Cliente sintético')
  await wrapper.get('[data-testid="support-email"]').setValue('buyer@example.invalid')
  await wrapper.get('[data-testid="support-subject"]').setValue('Consulta de fixture local')
  await wrapper.get('[data-testid="support-body"]').setValue('Descripción pública de la consulta local')
  await wrapper.get('[data-testid="support-privacy"]').setValue(true)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
describe('support panels strict context and same-key mutations', () => {
  it('admin confirms exact public reply only after review and fresh GET', async () => {
    const { wrapper, data, reload } = await admin()
    await prepareAdmin(wrapper)
    expect(request).not.toHaveBeenCalled()
    request.mockImplementation(async () => {
      data.value = adminContext(2)
      return receipt()
    })
    await wrapper.get('[data-testid="admin-support-send"]').trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]).toMatchObject([
      '/api/admin/support/' + REF,
      {
        method: 'PUT',
        retry: 0,
        body: {
          action: 'reply',
          expectedVersion: 1,
          reason: 'Documented operational reason',
          message: 'Public or internal response text'
        }
      }
    ])
    expect(reload).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('confirmed')?.[0]).toEqual([receipt()])
    expect(wrapper.text()).toContain('no confirma entrega')
  })
  it('internal note uses explicit separate action, never fabricated email authority', async () => {
    const { wrapper, data } = await admin()
    await prepareAdmin(wrapper, 'note')
    request.mockImplementation(async () => {
      data.value = adminContext(2)
      return { ...receipt(), emailStatus: 'not_requested' }
    })
    await wrapper.get('[data-testid="admin-support-send"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[0]?.[1].body.action).toBe('note')
    expect(wrapper.text()).toContain('Sin envío de correo solicitado')
  })
  it.each([
    { runtime: 'node' },
    { authorize: () => false },
    { operatorId: 'invalid' },
    { snapshot: { ...adminContext(), economicAuthority: true } },
    { snapshot: adminContext(1, NEXT_REF) }
  ])('admin fails closed context %#', async (props) => {
    const { wrapper } = await admin(props)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('private@example.invalid')
    expect(request).not.toHaveBeenCalled()
  })
  it('stale confirmed version prevents sending a new admin intent', async () => {
    const { wrapper, data } = await admin()
    await prepareAdmin(wrapper)
    data.value = adminContext(3)
    await wrapper.get('[data-testid="admin-support-send"]').trigger('click')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
  })
  it('uncertain mutation recovers exact frozen body/key after version has advanced', async () => {
    const { wrapper, data } = await admin()
    await prepareAdmin(wrapper)
    request.mockRejectedValueOnce(new Error('lost_response'))
    await wrapper.get('[data-testid="admin-support-send"]').trigger('click')
    await flushPromises()
    const original = request.mock.calls[0]![1]
    expect(Object.isFrozen(original.body)).toBe(true)
    data.value = adminContext(5)
    request.mockResolvedValueOnce(receipt())
    await wrapper.get('[data-testid="admin-support-recover"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[1]![1]).toMatchObject({ body: original.body, headers: original.headers, retry: 0 })
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
  })
  it('known version rejection is definite; malformed receipt is recoverable', async () => {
    const first = await admin()
    await prepareAdmin(first.wrapper)
    request.mockImplementationOnce(async (_endpoint, args) => {
      args.onResponseError({ response: { _data: { error: { code: 'version_conflict' } } } })
      throw new Error('409')
    })
    await first.wrapper.get('[data-testid="admin-support-send"]').trigger('click')
    await flushPromises()
    expect(first.wrapper.find('[data-testid="admin-support-recover"]').exists()).toBe(false)
    const second = await admin()
    await prepareAdmin(second.wrapper)
    request.mockResolvedValueOnce({ ...receipt(), inventoryEffect: 'changed' })
    await second.wrapper.get('[data-testid="admin-support-send"]').trigger('click')
    await flushPromises()
    expect(second.wrapper.find('[data-testid="admin-support-recover"]').exists()).toBe(true)
    expect(second.wrapper.emitted('confirmed')).toBeUndefined()
  })
  it('MFA lost after fresh GET never sends and hides all facts', async () => {
    const hold = deferred<unknown>(),
      { wrapper, authority, reload } = await admin()
    await prepareAdmin(wrapper)
    reload.mockImplementationOnce(() => hold.promise as Promise<ReturnType<typeof adminContext>>)
    await wrapper.get('[data-testid="admin-support-send"]').trigger('click')
    authority.value = false
    hold.resolve(adminContext())
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('PRIVATE_INTERNAL_SENTINEL')
  })
  it('identity changes discard pending intent and late response cannot announce success', async () => {
    const hold = deferred<unknown>(),
      { wrapper } = await admin()
    await prepareAdmin(wrapper)
    request.mockReturnValueOnce(hold.promise)
    await wrapper.get('[data-testid="admin-support-send"]').trigger('click')
    await flushPromises()
    await wrapper.setProps({ operatorId: OTHER, snapshot: null })
    hold.resolve(receipt())
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.find('[data-testid="admin-support-recover"]').exists()).toBe(false)
  })
  it('customer displays public history only, with no administrative controls', async () => {
    const { wrapper } = await customer()
    expect(wrapper.text()).toContain('Mensaje público inicial')
    expect(wrapper.text()).not.toContain('PRIVATE_INTERNAL_SENTINEL')
    expect(wrapper.find('[data-testid="admin-support-action"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('private@example.invalid')
  })
  it('customer response is actual POST with strict expectedVersion and no private flag', async () => {
    const { wrapper, data } = await customer()
    await prepareCustomer(wrapper)
    request.mockImplementation(async () => {
      data.value = customerContext(2)
      return { ...receipt(), emailStatus: 'not_requested' }
    })
    await wrapper.get('[data-testid="customer-support-send"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[0]).toMatchObject([
      '/api/account/support/' + REF,
      {
        method: 'POST',
        retry: 0,
        body: {
          expectedVersion: 1,
          message: 'Respuesta de cliente'
        }
      }
    ])
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
  })
  it('hostile customer DTO containing internal event is rejected wholly', async () => {
    const { wrapper } = await customer({ snapshot: { ...customerContext(), timeline: adminContext().timeline } })
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('PRIVATE_INTERNAL_SENTINEL')
  })
  it('customer receipt cannot name another ticket or alter economic effects', async () => {
    const { wrapper } = await customer()
    await prepareCustomer(wrapper)
    request.mockResolvedValueOnce(receipt(2, NEXT_REF))
    await wrapper.get('[data-testid="customer-support-send"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.find('[data-testid="customer-support-recover"]').exists()).toBe(true)
  })
  it('contact prepares strict anonymous declaration without fabricated order ownership', async () => {
    const { wrapper } = await contact({ orderId: '30000000-0000-4000-8000-000000000049', orderReference: 'Declarada' })
    await prepareContact(wrapper)
    expect(request).not.toHaveBeenCalled()
    request.mockResolvedValueOnce(receipt(1))
    await wrapper.get('[data-testid="support-contact-send"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[0]?.[1].body).toMatchObject({
      privacyAcknowledged: true,
      website: '',
      orderReference: 'Declarada'
    })
    expect(request.mock.calls[0]?.[1].body).not.toHaveProperty('orderId')
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
  })
  it('contact blocks absent policy rather than accepting invented privacy terms', async () => {
    const { wrapper } = await contact({ snapshot: { ...options(), policy: null, privacyReviewRequired: true } })
    expect(wrapper.get('[data-testid="support-contact-prepare"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Formulario deshabilitado')
    expect(request).not.toHaveBeenCalled()
  })
  it('invalid contact fields never prepare or send an attempt', async () => {
    const { wrapper } = await contact()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-testid="support-contact-send"]').exists()).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
  it('unconfirmed contact POST keeps same-key recovery, no automatic retries', async () => {
    const { wrapper } = await contact()
    await prepareContact(wrapper)
    request.mockRejectedValueOnce(new Error('network'))
    await wrapper.get('[data-testid="support-contact-send"]').trigger('click')
    await flushPromises()
    const original = request.mock.calls[0]![1]
    expect(request).toHaveBeenCalledTimes(1)
    request.mockResolvedValueOnce(receipt(1))
    await wrapper.get('[data-testid="support-contact-recover"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[1]![1]).toMatchObject({ body: original.body, headers: original.headers })
  })
})
