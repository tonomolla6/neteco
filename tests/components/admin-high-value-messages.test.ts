import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import AdminHighValueMessages from '../../app/components/AdminHighValueMessages.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const customer = '30000000-0000-4000-8000-000000000046',
  event = '11111111-1111-4111-8111-111111111111'
beforeEach(() => mocks.request.mockReset())
function fixtures() {
  mocks.request.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (!url) return {}
    if (opts?.method === 'POST')
      return url.endsWith('/high-value-messages')
        ? { status: 'fallback', fallback: 'manual', reason: 'consent_required' }
        : { version: 2 }
    if (url.endsWith('/high-value-consent/sms')) return { version: 1, granted: true }
    if (url.endsWith('/high-value-consent/whatsapp')) return { version: 0, granted: false }
    if (url.endsWith('/whatsapp-business/status'))
      return { version: 1, handoff: false, lastInboundAt: null, templates: [] }
    throw new Error('unknown')
  })
}
it('loads the customer and records a versioned opt-out', async () => {
  fixtures()
  const w = await mountSuspended(AdminHighValueMessages)
  await w.find('input[name=customer]').setValue(customer)
  await w.find('form[data-test=load]').trigger('submit')
  await flushPromises()
  expect(w.text()).toContain('SMS')
  await w.find('input[name=proof]').setValue('case-optout-123')
  await w.find('button[data-action=revoke-sms]').trigger('click')
  await flushPromises()
  const post = mocks.request.mock.calls.find((c) => c[1]?.method === 'POST')!
  expect(post[0]).toContain('/high-value-consent/sms')
  expect(post[1].body).toEqual({ action: 'revoke', expectedVersion: 1, proof: 'case-optout-123' })
})
it('simulates only an allowed event and displays a manual fallback', async () => {
  fixtures()
  const w = await mountSuspended(AdminHighValueMessages)
  await w.find('input[name=customer]').setValue(customer)
  await w.find('form[data-test=load]').trigger('submit')
  await flushPromises()
  await w.find('input[name=eventId]').setValue(event)
  await w.find('button[data-action=simulate-sms]').trigger('click')
  await flushPromises()
  expect(w.text()).toContain('gestión manual')
  const post = mocks.request.mock.calls.find((c) => c[1]?.method === 'POST')!
  expect(post[1].body).toMatchObject({ eventId: event, event: 'recall', channel: 'sms', consentVersion: 1 })
  expect(post[1].body).not.toHaveProperty('costMinor')
})
it('shows an accessible error when consent status cannot be loaded', async () => {
  mocks.request.mockImplementation(async (url: string) => {
    if (!url) return {}
    throw new Error('offline')
  })
  const w = await mountSuspended(AdminHighValueMessages)
  await w.find('input[name=customer]').setValue(customer)
  await w.find('form[data-test=load]').trigger('submit')
  await flushPromises()
  expect(w.find('[role=alert]').exists()).toBe(true)
  expect(w.find('button[data-action=simulate-sms]').exists()).toBe(false)
})
