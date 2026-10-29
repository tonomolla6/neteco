import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import PreferenceCenterPanel from '../../app/components/PreferenceCenterPanel.vue'
import ReplenishmentRemindersPanel from '../../app/components/ReplenishmentRemindersPanel.vue'
import CompanyDocumentsPanel from '../../app/components/CompanyDocumentsPanel.vue'
import SupportImpersonationBanner from '../../app/components/SupportImpersonationBanner.vue'
import SupportImpersonationStart from '../../app/components/SupportImpersonationStart.vue'
import {
  PREFERENCE_CENTER_CONSENT_TEXT as TEXT,
  PREFERENCE_CENTER_POLICY_VERSION as POLICY
} from '../../shared/preference-center'
import { deterministicUuid } from '../fixtures/deterministic'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const NOW = '2030-01-02T12:00:00Z'
type Opt = { method?: string; body?: Record<string, unknown>; headers?: Record<string, string> }
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.useRealTimers()
})
async function render(component: object, props: Record<string, unknown> = { enabled: true }) {
  const w = await mountSuspended(component as never, { props })
  mounted.push(w)
  await flushPromises()
  return w
}
const failure = (status: number, code: string) =>
  Object.assign(new Error(code), { statusCode: status, data: { error: { code } } })
const calls = (method: string) => mocks.request.mock.calls.filter(([, o]) => (o as Opt)?.method === method)

// ---------- CUS-015 ----------
const snap = (version = 0, over: Record<string, unknown> = {}) => ({
  source: 'cloudflare',
  version,
  preferences: {
    frequency: 'never',
    topics: [],
    sectors: [],
    channels: { email: false, sms: false, push: false },
    unsubscribeAll: false,
    ...over
  },
  policyVersion: POLICY,
  consentText: TEXT,
  updatedAt: version ? NOW : null,
  sync: version ? { esp: 'pending', cmp: 'pending' } : { esp: null, cmp: null }
})
const pcReceipt = (o: Opt) => ({
  source: 'cloudflare',
  commandId: o.headers!['Idempotency-Key'],
  expectedVersion: o.body!.expectedVersion,
  version: (o.body!.expectedVersion as number) + 1,
  preferences: o.body!.preferences,
  policyVersion: POLICY,
  recordedAt: NOW,
  sync: { esp: 'pending', cmp: 'pending' }
})
function pcServer() {
  let current = snap()
  mocks.request.mockReset().mockImplementation(async (_p: string, o: Opt = {}) => {
    if (o.method === 'PUT') {
      const r = pcReceipt(o)
      current = snap(r.version, o.body!.preferences as Record<string, unknown>)
      return r
    }
    return current
  })
}
beforeEach(pcServer)

it('preference centre starts fully opted out with no pre-ticked option and no acknowledgement shown', async () => {
  const w = await render(PreferenceCenterPanel)
  expect(w.text()).toContain(TEXT)
  for (const sel of ['[data-pc-topic]', '[data-pc-sector]', '[data-pc-channel]']) {
    const boxes = w.findAll(sel)
    expect(boxes.length).toBeGreaterThan(0)
    expect(boxes.every((b) => (b.element as HTMLInputElement).checked === false)).toBe(true)
  }
  expect((w.get('[data-pc-frequency="never"]').element as HTMLInputElement).checked).toBe(true)
  expect(w.find('[data-pc-ack]').exists()).toBe(false)
  expect(calls('PUT')).toHaveLength(0)
})
it('does not call the API when disabled', async () => {
  await render(PreferenceCenterPanel, { enabled: false })
  expect(mocks.request).not.toHaveBeenCalled()
})
it('requires an explicit acknowledgement only for newly enabled options and sends a frozen CAS body', async () => {
  const w = await render(PreferenceCenterPanel)
  await w.get('[data-pc-frequency="monthly"]').setValue(true)
  await w.get('[data-pc-topic="offers"]').setValue(true)
  await w.get('[data-pc-channel="email"]').setValue(true)
  await w.get('[data-pc-sector="hospitality"]').setValue(true)
  expect(w.get('[data-pc-save]').attributes('disabled')).toBeDefined()
  await w.get('[data-pc-ack]').setValue(true)
  expect(w.get('[data-pc-save]').attributes('disabled')).toBeUndefined()
  await w.get('form').trigger('submit')
  await flushPromises()
  const [[path, options]] = calls('PUT') as [[string, Opt]]
  expect(path).toBe('/api/account/preference-center')
  expect(options.body).toMatchObject({
    expectedVersion: 0,
    acknowledged: true,
    policyVersion: POLICY,
    preferences: {
      frequency: 'monthly',
      topics: ['offers'],
      sectors: ['hospitality'],
      channels: { email: true, sms: false, push: false },
      unsubscribeAll: false
    }
  })
  expect(options.headers!['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  expect(w.get('[data-pc-message]').text()).toContain('Preferencias guardadas (versión 1)')
  expect(w.get('[data-pc-sync]').text()).toContain('pendiente de sincronizar')
})
it('blocks topics without a frequency or channel with a visible reason', async () => {
  const w = await render(PreferenceCenterPanel)
  await w.get('[data-pc-topic="offers"]').setValue(true)
  expect(w.find('[data-pc-invalid]').exists()).toBe(true)
  expect(w.get('[data-pc-save]').attributes('disabled')).toBeDefined()
})
it('lets the customer leave everything in one click with no acknowledgement', async () => {
  mocks.request
    .mockReset()
    .mockImplementation(async (_p: string, o: Opt = {}) =>
      o.method === 'PUT'
        ? pcReceipt(o)
        : snap(1, { frequency: 'weekly', topics: ['offers'], channels: { email: true, sms: false, push: false } })
    )
  const w = await render(PreferenceCenterPanel)
  await w.get('[data-pc-unsubscribe]').trigger('click')
  await flushPromises()
  const [[, options]] = calls('PUT') as [[string, Opt]]
  expect(options.body).toMatchObject({
    expectedVersion: 1,
    acknowledged: false,
    preferences: { unsubscribeAll: true, frequency: 'never', topics: [], sectors: [] }
  })
})
it('shows a read failure as unknown, not as opted out, and offers a retry', async () => {
  mocks.request.mockReset().mockRejectedValueOnce(failure(503, 'unavailable')).mockResolvedValue(snap())
  const w = await render(PreferenceCenterPanel)
  expect(w.get('[role="alert"]').text()).toContain('no significa que estén desactivadas')
  expect(w.find('form').exists()).toBe(false)
  await w.get('[data-pc-retry]').trigger('click')
  await flushPromises()
  expect(w.find('form').exists()).toBe(true)
})
it('explains a version conflict and reuses the key for an identical retry only', async () => {
  const w = await render(PreferenceCenterPanel)
  mocks.request.mockImplementation(async (_p: string, o: Opt = {}) => {
    if (o.method === 'PUT') throw failure(409, 'conflict')
    return snap()
  })
  await w.get('[data-pc-unsubscribe]').trigger('click')
  await flushPromises()
  expect(w.get('[data-pc-message]').text()).toContain('han cambiado')
  await w.get('[data-pc-unsubscribe]').trigger('click')
  await flushPromises()
  const keys = calls('PUT').map(([, o]) => (o as Opt).headers!['Idempotency-Key'])
  expect(keys).toHaveLength(2)
  expect(keys[0]).toBe(keys[1])
})

// ---------- CUS-019 ----------
const plan = (over: Record<string, unknown> = {}) => ({
  id: deterministicUuid('plan'),
  variantId: 'v-1-1',
  sku: 'SKU-1-1',
  name: 'Desengrasante',
  source: 'declared',
  intervalDays: 30,
  status: 'active',
  nextDueAt: '2030-02-01T12:00:00Z',
  lastRemindedAt: null,
  version: 1,
  ...over
})
const list = (over: Record<string, unknown> = {}) => ({
  source: 'cloudflare',
  consent: { replenishment: true },
  cap: { maxQueued: 1, windowDays: 7 },
  plans: [plan()],
  recent: [],
  ...over
})
it('replenishment panel lists plans with the frequency cap and manages them with CAS', async () => {
  mocks.request.mockReset().mockImplementation(async (_p: string, o: Opt = {}) => (o.method === 'POST' ? {} : list()))
  const w = await render(ReplenishmentRemindersPanel)
  expect(w.get('[data-rr-cap]').text()).toContain('1 recordatorio cada 7 días')
  expect(w.get('[data-rr-plan]').text()).toContain('Desengrasante')
  await w.get('[data-rr-pause]').trigger('click')
  await flushPromises()
  const [[path, options]] = calls('POST') as [[string, Opt]]
  expect(path).toBe('/api/account/replenishment/plans')
  expect(options.body).toEqual({ variantId: 'v-1-1', action: 'pause', expectedVersion: 1 })
})
it('warns that no reminder is sent without consent', async () => {
  mocks.request.mockReset().mockResolvedValue(list({ consent: { replenishment: false } }))
  const w = await render(ReplenishmentRemindersPanel)
  expect(w.get('[data-rr-no-consent]').text()).toContain('no te enviaremos ningún recordatorio')
})
it('shows the empty state and creates a declared plan', async () => {
  mocks.request
    .mockReset()
    .mockImplementation(async (_p: string, o: Opt = {}) => (o.method === 'POST' ? {} : list({ plans: [] })))
  const w = await render(ReplenishmentRemindersPanel)
  expect(w.find('[data-rr-empty]').exists()).toBe(true)
  await w.get('[data-rr-variant]').setValue('v-1-1')
  await w.get('[data-rr-interval]').setValue('45')
  await w.get('[data-rr-create]').trigger('submit')
  await w.get('form').trigger('submit')
  await flushPromises()
  const [[, options]] = calls('POST') as [[string, Opt]]
  expect(options.body).toEqual({
    variantId: 'v-1-1',
    action: 'save',
    expectedVersion: 0,
    source: 'declared',
    intervalDays: 45
  })
})
it('explains insufficient history', async () => {
  mocks.request.mockReset().mockImplementation(async (_p: string, o: Opt = {}) => {
    if (o.method === 'POST') throw failure(422, 'insufficient_history')
    return list({ plans: [] })
  })
  const w = await render(ReplenishmentRemindersPanel, { enabled: true, variantId: 'v-1-1' })
  await w.get('[data-rr-source]').setValue('history')
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(w.get('[data-rr-message]').text()).toContain('no hay suficientes compras')
})
it('shows a read error with retry', async () => {
  mocks.request.mockReset().mockRejectedValue(failure(503, 'unavailable'))
  const w = await render(ReplenishmentRemindersPanel)
  expect(w.find('[data-rr-retry]').exists()).toBe(true)
})

// ---------- CUS-016 ----------
const docs = (over: Record<string, unknown> = {}) => ({
  source: 'cloudflare',
  companyStatus: 'pending',
  limit: 5,
  documents: [],
  ...over
})
it('company documents are optional, listed and removable', async () => {
  const document = {
    id: deterministicUuid('doc'),
    companyId: deterministicUuid('co'),
    kind: 'tax_certificate',
    fileName: 'cert.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    sha256: 'a'.repeat(64),
    status: 'active',
    createdAt: NOW,
    removedAt: null
  }
  mocks.request
    .mockReset()
    .mockImplementation(async (_p: string, o: Opt = {}) =>
      o.method === 'DELETE' ? {} : docs({ documents: [document] })
    )
  const w = await render(CompanyDocumentsPanel)
  expect(w.get('[data-cd-status]').text()).toContain('En revisión')
  expect(w.get('[data-cd-doc]').text()).toContain('cert.pdf')
  await w.get('[data-cd-remove]').trigger('click')
  await flushPromises()
  expect(calls('DELETE')[0]![0]).toBe(`/api/account/company/documents/${document.id}`)
})
it('company documents show the empty state, and hide the form once approved', async () => {
  mocks.request.mockReset().mockResolvedValue(docs())
  const w = await render(CompanyDocumentsPanel)
  expect(w.find('[data-cd-empty]').exists()).toBe(true)
  expect(w.find('form').exists()).toBe(true)
  expect(w.get('[data-cd-add]').attributes('disabled')).toBeDefined()
  mocks.request.mockReset().mockResolvedValue(docs({ companyStatus: 'approved' }))
  const approved = await render(CompanyDocumentsPanel)
  expect(approved.find('form').exists()).toBe(false)
})
it('company documents report a customer without company', async () => {
  mocks.request.mockReset().mockRejectedValue(failure(404, 'not_found'))
  const w = await render(CompanyDocumentsPanel)
  expect(w.find('[data-cd-no-company]').exists()).toBe(true)
})

// ---------- CUS-028 ----------
const session = (over: Record<string, unknown> = {}) => ({
  source: 'cloudflare',
  id: deterministicUuid('imp'),
  actorId: deterministicUuid('agent'),
  customerId: deterministicUuid('cust'),
  customerName: 'Cliente sintético',
  ticketRef: 'NET-1',
  reason: 'Reproducir el fallo',
  startedAt: NOW,
  expiresAt: '2030-01-02T12:10:00Z',
  endedAt: null,
  status: 'active',
  remainingSeconds: 125,
  banner:
    'Suplantación de soporte activa: actúas como Cliente sintético (ticket NET-1). Cada acción queda registrada; no se permiten cambios de credenciales ni pagos.',
  ...over
})
it('banner is invisible when there is no active session or the API refuses', async () => {
  mocks.request.mockReset().mockResolvedValue({ source: 'cloudflare', session: null })
  expect((await render(SupportImpersonationBanner, {})).find('[data-impersonation-banner]').exists()).toBe(false)
  mocks.request.mockReset().mockRejectedValue(failure(401, 'unauthenticated'))
  expect((await render(SupportImpersonationBanner, {})).find('[data-impersonation-banner]').exists()).toBe(false)
})
it('banner shows who is impersonated, counts down and ends the session', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let active = true
  mocks.request.mockReset().mockImplementation(async (path: string, o: Opt = {}) => {
    if (o.method === 'POST') {
      active = false
      return session({ status: 'ended' })
    }
    return { source: 'cloudflare', session: active ? session() : null }
  })
  const w = await render(SupportImpersonationBanner, {})
  expect(w.get('[data-impersonation-text]').text()).toContain('Cliente sintético')
  expect(w.get('[role="status"]').exists()).toBe(true)
  expect(w.get('[data-impersonation-clock]').text()).toBe('02:05')
  vi.advanceTimersByTime(5000)
  await flushPromises()
  expect(w.get('[data-impersonation-clock]').text()).toBe('02:00')
  await w.get('[data-impersonation-end]').trigger('click')
  await flushPromises()
  expect(calls('POST')[0]![0]).toBe(`/api/admin/support-impersonation/${session().id}/end`)
  expect(w.find('[data-impersonation-banner]').exists()).toBe(false)
})
it('start form posts the bounded request with an idempotency key and explains refusals', async () => {
  mocks.request.mockReset().mockResolvedValue(session())
  const w = await render(SupportImpersonationStart, { customerId: session().customerId, ticketRef: 'NET-1' })
  await w.get('[data-imp-reason]').setValue('Reproducir el fallo del cliente')
  await w.get('[data-imp-minutes]').setValue('5')
  await w.get('form').trigger('submit')
  await flushPromises()
  const [[path, options]] = calls('POST') as [[string, Opt]]
  expect(path).toBe('/api/admin/support-impersonation')
  expect(options.body).toEqual({
    customerId: session().customerId,
    ticketRef: 'NET-1',
    reason: 'Reproducir el fallo del cliente',
    minutes: 5
  })
  expect(options.headers!['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  expect(w.emitted('started')).toHaveLength(1)
  mocks.request.mockReset().mockRejectedValue(failure(403, 'forbidden'))
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(w.get('[data-imp-message]').text()).toContain('no permite suplantar')
})
