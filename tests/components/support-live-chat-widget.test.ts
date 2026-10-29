import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SupportLiveChatWidget from '../../app/components/SupportLiveChatWidget.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  fetch: vi.fn()
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('$fetch', () => mocks.fetch)

describe('Componente SupportLiveChatWidget.vue (SUP-011)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('muestra aviso humano y disclaimer cuando el chat está disponible', async () => {
    mocks.request.mockResolvedValueOnce({
      isOpen: true,
      operatingHours: { schedule: 'L-V 08:00 - 18:00', timezone: 'Europe/Madrid' },
      queue: { length: 0, estimatedWaitSeconds: 60 },
      disclaimer: 'Atención exclusivamente humana por el equipo de Neteco. No utilizamos bots simulando ser personas.'
    })

    const wrapper = await mountSuspended(SupportLiveChatWidget)
    await flushPromises()

    expect(wrapper.text()).toContain('Atención exclusivamente humana')
    expect(wrapper.text()).toContain('No utilizamos bots')
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(true) // Consent checkbox
  })

  it('muestra aviso de fuera de horario y no permite iniciar sesión cuando está cerrado', async () => {
    mocks.request.mockResolvedValueOnce({
      isOpen: false,
      nextOpeningAt: '2026-11-02T08:00:00Z',
      operatingHours: { schedule: 'L-V 08:00 - 18:00', timezone: 'Europe/Madrid' },
      queue: { length: 0, estimatedWaitSeconds: 0 },
      disclaimer: 'Atención exclusivamente humana por el equipo de Neteco. No utilizamos bots simulando ser personas.'
    })

    const wrapper = await mountSuspended(SupportLiveChatWidget)
    await flushPromises()

    expect(wrapper.text()).toContain('Fuera de horario de atención')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
  })

  it('inicia sesión con consentimiento y muestra posición en cola y tiempo estimado', async () => {
    mocks.request.mockResolvedValueOnce({
      isOpen: true,
      operatingHours: { schedule: 'L-V 08:00 - 18:00', timezone: 'Europe/Madrid' },
      queue: { length: 2, estimatedWaitSeconds: 360 },
      disclaimer: 'Atención exclusivamente humana por el equipo de Neteco. No utilizamos bots simulando ser personas.'
    })

    mocks.fetch.mockResolvedValueOnce({
      session: {
        id: '11111111-1111-4000-8000-111111111111',
        publicRef: 'CHAT-0000000000000000001',
        status: 'waiting_operator',
        queuePosition: 3,
        estimatedWaitSeconds: 360,
        currentVersion: 1
      }
    })

    const wrapper = await mountSuspended(SupportLiveChatWidget)
    await flushPromises()

    // Accept consent
    const consent = wrapper.find('input[type="checkbox"]')
    await consent.setValue(true)

    // Fill customer name
    const nameInput = wrapper.find('input[name="customerName"]')
    if (nameInput.exists()) await nameInput.setValue('Juan Cliente')

    // Submit form
    await wrapper.find('form').trigger('submit.prevent')
    await flushPromises()

    expect(wrapper.text()).toContain('CHAT-0000000000000000001')
    expect(wrapper.text()).toContain('Posición en cola: 3')
    expect(wrapper.text()).toContain('Tiempo estimado')
  })
})
