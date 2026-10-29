import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminB2bPublicKeys from '../../app/components/AdminB2bPublicKeys.vue'
import '#app/nuxt-vitest-app-entry'

enableAutoUnmount(afterEach)
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const key = { id: '11111111-1111-4111-8111-111111111111', environment: 'sandbox', scopes: 'requests.read requests.write', quotaDaily: 50, status: 'active', version: 1, createdAt: '2026-10-29T10:00:00Z' }
describe('claves B2B del portal', () => {
  beforeEach(() => mocks.request.mockReset())
  it('informa errores de carga', async () => {
    mocks.request.mockImplementation(() => { throw new Error('offline') })
    const wrapper = mount(AdminB2bPublicKeys)
    await flushPromises()
    expect(wrapper.text()).toContain('No se pudieron cargar las claves')
  })
  it('muestra estado vacío y crea una credencial que se muestra una vez', async () => {
    mocks.request.mockImplementation(async (_url: string, options?: { method?: string }) => options?.method === 'POST' ? { id: key.id, key: 'sbx_test' } : { items: [] })
    const wrapper = mount(AdminB2bPublicKeys)
    await flushPromises()
    expect(wrapper.text()).toContain('No hay claves')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('sbx_test')
    expect(wrapper.text()).toContain('solo se muestra una vez')
  })
  it('revoca con versión y muestra la lista', async () => {
    mocks.request.mockImplementation(async (_url: string, options?: { method?: string }) => options?.method === 'POST' ? { id: key.id, key: null } : { items: [key] })
    const wrapper = mount(AdminB2bPublicKeys)
    await flushPromises()
    expect(wrapper.text()).toContain(key.id)
    await wrapper.get('[data-revoke]').trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledWith('/api/admin/b2b-public/keys', expect.objectContaining({ method: 'POST', body: { action: 'revoke', id: key.id, expectedVersion: 1 } }))
  })
  it('reintenta un fallo ambiguo con el mismo comando y contenido', async () => {
    mocks.request.mockImplementation(async (_url: string, options?: { method?: string }) => options?.method === 'POST' ? Promise.reject(new Error('offline')) : { items: [] })
    const wrapper = mount(AdminB2bPublicKeys)
    await flushPromises()
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('resultado desconocido')
    await wrapper.get('[data-retry]').trigger('click')
    await flushPromises()
    const posts = mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0]?.[1]).toEqual(posts[1]?.[1])
  })
})
