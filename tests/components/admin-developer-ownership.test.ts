import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminDeveloperOwnership from '../../app/components/AdminDeveloperOwnership.vue'
import '#app/nuxt-vitest-app-entry'

enableAutoUnmount(afterEach)
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
describe('responsables de servicios', () => {
  beforeEach(() => mocks.request.mockReset())
  it('presenta servicios sin asignación y guarda responsable con CAS', async () => {
    mocks.request.mockImplementation(async (_url: string, options?: { method?: string }) =>
      options?.method === 'POST' ? { serviceId: 'catalog', owner: 'platform.catalog', version: 1 } : { items: [] }
    )
    const wrapper = mount(AdminDeveloperOwnership)
    await flushPromises()
    expect(wrapper.text()).toContain('Sin responsable asignado')
    await wrapper.get('#developer-owner').setValue('platform.catalog')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/admin/developer-platform/ownership',
      expect.objectContaining({
        method: 'POST',
        body: { serviceId: 'catalog', owner: 'platform.catalog', expectedVersion: 0 }
      })
    )
  })
  it('presenta los responsables existentes', async () => {
    mocks.request.mockResolvedValue({ items: [{ serviceId: 'checkout', owner: 'ops.checkout', version: 2 }] })
    const wrapper = mount(AdminDeveloperOwnership)
    await flushPromises()
    expect(wrapper.text()).toContain('ops.checkout')
  })
  it('comunica un fallo de lectura y permite reintento', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url === '/api/admin/developer-platform/ownership') throw new Error('offline')
      return Promise.resolve({})
    })
    const wrapper = mount(AdminDeveloperOwnership)
    await flushPromises()
    expect(wrapper.text()).toContain('No se pudieron cargar los responsables')
  })
  it('conserva el identificador y contenido tras fallo ambiguo', async () => {
    mocks.request.mockImplementation(async (_url: string, options?: { method?: string }) =>
      options?.method === 'POST' ? Promise.reject(new Error('offline')) : { items: [] }
    )
    const wrapper = mount(AdminDeveloperOwnership)
    await flushPromises()
    await wrapper.get('#developer-owner').setValue('platform.catalog')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('resultado desconocido')
    await wrapper.get('[data-retry-owner]').trigger('click')
    await flushPromises()
    const posts = mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0]?.[1]).toEqual(posts[1]?.[1])
  })
})
