import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SupportFaqAssistant from '../../app/components/SupportFaqAssistant.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const source = {
  pageId: '10000000-0000-4000-8000-000000000001',
  versionId: '20000000-0000-4000-8000-000000000001',
  slug: 'plazos-de-envio',
  title: 'Plazos de envío',
  category: 'envios',
  reviewedAt: '2026-10-01T00:00:00Z'
}
const answered = {
  turnId: '30000000-0000-4000-8000-000000000001',
  outcome: 'answered',
  reason: 'grounded',
  answer: 'El envío por agencia tarda de 2 a 4 días.',
  confidenceBp: 9000,
  sources: [source],
  notice: null,
  handoff: { available: true, handoffId: null },
  createdAt: '2026-10-29T12:00:00Z'
}
const uncertain = { ...answered, outcome: 'uncertain', reason: 'no_match', answer: null, confidenceBp: 0, sources: [] }
const emergency = {
  ...uncertain,
  outcome: 'handoff_required',
  reason: 'emergency',
  notice: 'Si hay una persona afectada o en peligro, llama al 112 ahora.'
}

async function ask(wrapper: Awaited<ReturnType<typeof mountSuspended>>, question: string) {
  await wrapper.find('textarea').setValue(question)
  await wrapper.find('form').trigger('submit')
  await flushPromises()
}
beforeEach(() => mocks.request.mockReset())

describe('SupportFaqAssistant (SUP-012)', () => {
  it('states its limits before any question', async () => {
    const wrapper = await mountSuspended(SupportFaqAssistant)
    expect(wrapper.text()).toMatch(/solo responde con información revisada/i)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
  it('sends the question with an idempotency key and cites the source of the answer', async () => {
    mocks.request.mockResolvedValue(answered)
    const wrapper = await mountSuspended(SupportFaqAssistant)
    await ask(wrapper, '¿Cuánto tarda el envío por agencia?')
    const [url, options] = mocks.request.mock.calls[0]!
    expect(url).toBe('/api/support/assistant/ask')
    expect(options.method).toBe('POST')
    expect(options.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(options.body).toEqual({ question: '¿Cuánto tarda el envío por agencia?' })
    expect(wrapper.text()).toContain('El envío por agencia tarda de 2 a 4 días.')
    expect(wrapper.text()).toContain('Fuente: Plazos de envío')
  })
  it('admits uncertainty and offers a person instead of an answer', async () => {
    mocks.request.mockResolvedValue(uncertain)
    const wrapper = await mountSuspended(SupportFaqAssistant)
    await ask(wrapper, '¿Qué pintura epoxi recomendáis?')
    expect(wrapper.text()).toMatch(/no tengo información aprobada/i)
    expect(wrapper.find('[data-test="handoff-open"]').exists()).toBe(true)
  })
  it('shows the emergency notice prominently', async () => {
    mocks.request.mockResolvedValue(emergency)
    const wrapper = await mountSuspended(SupportFaqAssistant)
    await ask(wrapper, 'Mi hijo ha bebido lejía')
    expect(wrapper.find('[data-test="notice"]').text()).toContain('112')
    expect(wrapper.text()).not.toContain('El envío por agencia')
  })
  it('hands off to a human with the e-mail and confirms', async () => {
    mocks.request.mockResolvedValueOnce(uncertain).mockResolvedValueOnce({
      handoffId: '40000000-0000-4000-8000-000000000001',
      status: 'open',
      slaDueAt: '2026-10-30T12:00:00Z',
      version: 1
    })
    const wrapper = await mountSuspended(SupportFaqAssistant)
    await ask(wrapper, '¿Qué pintura epoxi recomendáis?')
    await wrapper.find('[data-test="handoff-open"]').trigger('click')
    await wrapper.find('input[type="email"]').setValue('ana@example.com')
    await wrapper.find('[data-test="handoff-form"]').trigger('submit')
    await flushPromises()
    expect(mocks.request.mock.calls[1]![0]).toBe('/api/support/assistant/handoff')
    expect(mocks.request.mock.calls[1]![1].body).toEqual({ turnId: uncertain.turnId, contactEmail: 'ana@example.com' })
    expect(wrapper.find('[role="status"]').text()).toMatch(/una persona/i)
  })
  it('records whether the answer helped, once', async () => {
    mocks.request
      .mockResolvedValueOnce(answered)
      .mockResolvedValueOnce({ turnId: answered.turnId, helpful: true, recorded: true })
    const wrapper = await mountSuspended(SupportFaqAssistant)
    await ask(wrapper, '¿Cuánto tarda el envío por agencia?')
    await wrapper.find('[data-test="helpful-yes"]').trigger('click')
    await flushPromises()
    expect(mocks.request.mock.calls[1]![0]).toBe('/api/support/assistant/feedback')
    expect(wrapper.find('[data-test="helpful-yes"]').exists()).toBe(false)
    expect(wrapper.text()).toMatch(/gracias/i)
  })
  it('shows an error without leaving a stale answer and keeps the form usable', async () => {
    mocks.request
      .mockResolvedValueOnce(answered)
      .mockRejectedValueOnce({ data: { error: { code: 'knowledge_unavailable' } } })
    const wrapper = await mountSuspended(SupportFaqAssistant)
    await ask(wrapper, '¿Cuánto tarda el envío por agencia?')
    await ask(wrapper, '¿Y por reparto propio?')
    expect(wrapper.find('[role="alert"]').text()).toMatch(/no está disponible/i)
    expect(wrapper.text()).not.toContain('2 a 4 días')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined()
  })
  it('rejects too short questions locally and disables sending while loading', async () => {
    let finish!: (v: unknown) => void
    mocks.request.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const wrapper = await mountSuspended(SupportFaqAssistant)
    await ask(wrapper, 'ab')
    expect(mocks.request).not.toHaveBeenCalled()
    await ask(wrapper, '¿Cuánto tarda el envío?')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
    finish(answered)
    await flushPromises()
  })
})
