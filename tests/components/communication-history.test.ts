import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCommunicationHistoryPanel from '../../app/components/AdminCommunicationHistoryPanel.vue'
import '#app/nuxt-vitest-app-entry'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => request)
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
beforeEach(() => request.mockReset())
afterEach(() => {
  wrapper?.unmount()
  request.mockReset()
})
const EVENT = 'email:' + 'a'.repeat(64),
  NOW = '2026-10-09T12:00:00Z'
function snapshot() {
  return {
    source: 'cloudflare',
    evaluatedAt: NOW,
    page: 1,
    perPage: 25,
    total: 1,
    items: [
      {
        eventId: EVENT,
        eventType: 'order.created',
        status: 'pending',
        createdAt: NOW,
        attempts: 2,
        availableAt: '2026-10-09T13:00:00Z',
        finishedAt: null,
        errorCode: 'preparation_failed',
        canRetry: true
      }
    ]
  }
}
async function panel() {
  wrapper = await mountSuspended(AdminCommunicationHistoryPanel, {
    props: { scopeKey: 'synthetic-operator:1', enabled: true, pending: false }
  })
  return wrapper
}
async function click(text: string) {
  const button = wrapper!.findAll('button').find((item) => item.text() === text)
  expect(button).toBeDefined()
  if (button!.attributes('type') === 'submit') {
    await wrapper!.get('form').trigger('submit')
  } else await button!.trigger('click')
  await flushPromises()
}
async function load() {
  request.mockResolvedValue(snapshot())
  await panel()
  await click('Consultar historial de comunicaciones')
}
async function review() {
  await click('Revisar preparación')
  await wrapper!.get('textarea').setValue('Revisada la causa transitoria de preparación local.')
  await wrapper!.get('form[data-communication-review]').trigger('submit')
  await vi.waitFor(() => expect(wrapper!.text()).toContain('Confirmar reprogramación'))
}
describe('COM-011 metadata-only explicit operational recovery', () => {
  it('offers an explicit read and does not read or write on mount', async () => {
    await panel()
    expect(wrapper!.find('[aria-label="Historial operativo de comunicaciones"]').exists()).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })
  it('shows actual preparation state, not a claim of provider delivery', async () => {
    await load()
    expect(wrapper!.text()).toContain('Preparación pendiente')
    expect(wrapper!.text()).toContain('2 intentos')
    expect(wrapper!.text()).toContain('No envía mensajes directamente')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('freezes a reviewed intention and never automatically repeats an unknown POST', async () => {
    await load()
    await review()
    request.mockRejectedValueOnce(new Error('synthetic-transport-loss'))
    await click('Confirmar reprogramación')
    expect(wrapper!.text()).toContain('Resultado incierto')
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
    expect(wrapper!.findAll('button').some((button) => button.text() === 'Comprobar reprogramación')).toBe(true)
    await flushPromises()
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  })
  it('purges private reason and frozen intention on scope revocation without writing on recovery', async () => {
    await load()
    await review()
    await wrapper!.setProps({ enabled: false })
    await flushPromises()
    expect(wrapper!.find('textarea').exists()).toBe(false)
    expect(wrapper!.text()).not.toContain(EVENT)
    expect(wrapper!.vm.$.setupState.intent).toBeNull()
    expect(wrapper!.vm.$.setupState.reason).toBe('')
    await wrapper!.setProps({ scopeKey: 'another-operator:2', enabled: true })
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not offer retry for sent, ambiguous or unsupported source rows', async () => {
    const value = snapshot()
    value.items[0]!.canRetry = false
    value.items[0]!.status = 'manual_review'
    value.items[0]!.errorCode = 'provider_outcome_unknown'
    request.mockResolvedValue(value)
    await panel()
    await click('Consultar historial de comunicaciones')
    expect(wrapper!.findAll('button').some((button) => button.text() === 'Revisar preparación')).toBe(false)
    expect(wrapper!.text()).toContain('Revisión manual')
  })
  it('shows an unavailable reading rather than confirmed empty history', async () => {
    request.mockRejectedValue({ statusCode: 503 })
    await panel()
    await click('Consultar historial de comunicaciones')
    expect(wrapper!.text()).toContain('No se ha podido consultar')
    expect(wrapper!.text()).not.toContain('No hay comunicaciones')
  })
})
