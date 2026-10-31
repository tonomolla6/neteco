import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminDeveloperMetrics from '../../app/components/AdminDeveloperMetrics.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

describe('métricas del portal de plataforma', () => {
  beforeEach(() => mocks.request.mockReset())
  it('muestra métricas agregadas y fecha UTC', async () => {
    mocks.request.mockResolvedValue({ day: '2026-10-29', activeKeys: 2, requestsToday: 9 })
    const wrapper = await mountSuspended(AdminDeveloperMetrics)
    await flushPromises()
    expect(wrapper.text()).toContain('2026-10-29')
    expect(wrapper.text()).toContain('2')
    expect(wrapper.text()).toContain('9')
  })
  it('comunica error y permite reintentar', async () => {
    mocks.request
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ day: '2026-10-29', activeKeys: 0, requestsToday: 0 })
    const wrapper = await mountSuspended(AdminDeveloperMetrics)
    await flushPromises()
    expect(wrapper.text()).toContain('No se pudieron cargar las métricas')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('2026-10-29')
  })
  it('muestra carga mientras espera', async () => {
    let finish!: (value: unknown) => void
    mocks.request.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const wrapper = mount(AdminDeveloperMetrics)
    expect(wrapper.text()).toContain('Cargando métricas')
    finish({ day: '2026-10-29', activeKeys: 0, requestsToday: 0 })
    await flushPromises()
  })
})
