import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DeliverySurveyPage from '../../app/pages/encuesta/[token].vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  route: { params: { token: 'valid_test_token_123456789012' } }
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRoute', () => () => mocks.route)

const sampleSurveyDetails = {
  orderId: '00000000-0000-4000-7000-000000000001',
  orderNumber: '00000001',
  recipientName: 'Carlos García',
  recipientEmail: 'carlos@example.invalid',
  customerSegment: 'particular',
  status: 'scheduled',
  scheduledAt: '2026-10-28T10:00:00Z',
  expiresAt: '2026-11-11T10:00:00Z',
  catalogReasons: [
    'damaged_product',
    'missing_items',
    'late_delivery',
    'wrong_product',
    'packaging_issue',
    'delivery_agent_issue',
    'billing_issue',
    'product_inquiry',
    'compliment',
    'other'
  ]
}

describe('Página pública app/pages/encuesta/[token].vue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.route.params = { token: 'valid_test_token_123456789012' }
    mocks.request.mockResolvedValue(sampleSurveyDetails)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('monta la página y muestra datos del pedido y el aviso no bloqueante', async () => {
    const wrapper = await mountSuspended(DeliverySurveyPage)
    await flushPromises()

    expect(wrapper.text()).toContain('00000001')
    expect(wrapper.text()).toContain('Carlos García')
    expect(wrapper.text()).toContain('Esta encuesta es voluntaria y nunca condiciona tu derecho')
    expect(wrapper.text()).toContain('1. Valoración general de la entrega')
    expect(wrapper.text()).toContain('2. ¿Llegó todo en buen estado?')
  })

  it('muestra mensaje específico si el token ya fue utilizado', async () => {
    mocks.request.mockRejectedValue({
      data: { error: { code: 'token_used' } }
    })

    const wrapper = await mountSuspended(DeliverySurveyPage)
    await flushPromises()

    expect(wrapper.text()).toContain('Esta encuesta ya ha sido completada')
  })

  it('muestra mensaje específico si el token ha caducado', async () => {
    mocks.request.mockRejectedValue({
      data: { error: { code: 'token_expired' } }
    })

    const wrapper = await mountSuspended(DeliverySurveyPage)
    await flushPromises()

    expect(wrapper.text()).toContain('Este enlace de encuesta ha caducado')
  })

  it('permite completar y enviar una valoración positiva sin ticket', async () => {
    const wrapper = await mountSuspended(DeliverySurveyPage)
    await flushPromises()

    // Seleccionar 5 estrellas
    const starBtn = wrapper.find('button[data-score="5"]')
    expect(starBtn.exists()).toBe(true)
    await starBtn.trigger('click')

    // Seleccionar llegó bien: Sí
    const goodBtn = wrapper.find('button[data-arrived-good="true"]')
    expect(goodBtn.exists()).toBe(true)
    await goodBtn.trigger('click')

    // Mock respuesta de submit
    mocks.request.mockResolvedValueOnce({
      ok: true,
      responseId: 'resp-123',
      hasProblem: false,
      supportTicket: null
    })

    const form = wrapper.find('form')
    expect(form.exists()).toBe(true)
    await form.trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('¡Muchas gracias por tu valoración!')
  })

  it('si indica problema, muestra la referencia del ticket de soporte generado', async () => {
    const wrapper = await mountSuspended(DeliverySurveyPage)
    await flushPromises()

    // Seleccionar 1 estrella y llegó mal
    await wrapper.find('button[data-score="1"]').trigger('click')
    await wrapper.find('button[data-arrived-good="false"]').trigger('click')

    // Mock respuesta con ticket de soporte vinculado
    mocks.request.mockResolvedValueOnce({
      ok: true,
      responseId: 'resp-456',
      hasProblem: true,
      supportTicket: {
        ticketId: 't-123',
        publicRef: 'SOP-ABCDEF123456789012345678',
        created: true,
        url: '/soporte/SOP-ABCDEF123456789012345678'
      }
    })

    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('Incidencia registrada automáticamente')
    expect(wrapper.text()).toContain('SOP-ABCDEF123456789012345678')
  })
})
