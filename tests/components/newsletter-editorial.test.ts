import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NewsletterPreferencesPanel from '../../app/components/NewsletterPreferencesPanel.vue'
import NewsletterCampaignEditor from '../../app/components/NewsletterCampaignEditor.vue'
import NewsletterCampaignPreview from '../../app/components/NewsletterCampaignPreview.vue'
import '#app/nuxt-vitest-app-entry'
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
const SUB = '10000000-0000-4000-8000-000000000050',
  ACTOR = '20000000-0000-4000-8000-000000000050',
  VERSION = '30000000-0000-4000-8000-000000000050'
const wrappers: Array<{ unmount: () => void }> = []
let authority: ReturnType<typeof ref<boolean>>
beforeEach(() => {
  authority = ref(true)
  fetchMock.mockReset()
})
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount()
})
const preference = (extra: Record<string, unknown> = {}) => ({
  source: 'cloudflare',
  subscriptionId: SUB,
  status: 'confirmed',
  revision: 0,
  preference: null,
  topics: [],
  canSave: true,
  canUnsubscribe: true,
  externalDelivery: false,
  ...extra
})
const admin = (extra: Record<string, unknown> = {}) => ({
  source: 'cloudflare',
  policyRevision: 0,
  policy: null,
  topics: [],
  campaigns: [],
  nextCursor: null,
  capabilities: { manage: true, preview: true, localDispatch: false, externalDelivery: false },
  ...extra
})
async function preferences() {
  const w = await mountSuspended(NewsletterPreferencesPanel, {
    props: { endpoint: '/api/account/newsletter/preferences', actorId: ACTOR, authorize: () => authority.value }
  })
  wrappers.push(w)
  await flushPromises()
  return w
}
async function editor() {
  const w = await mountSuspended(NewsletterCampaignEditor, {
    props: { actorId: ACTOR, authorize: () => authority.value }
  })
  wrappers.push(w)
  await flushPromises()
  return w
}
describe('newsletter preferences confirmed contracts', () => {
  it('does not choose an implied default frequency or manufacture consent', async () => {
    fetchMock.mockResolvedValue(preference())
    const w = await preferences()
    expect(w.find<HTMLSelectElement>('select[aria-label="Frecuencia newsletter"]').element.value).toBe('')
    expect(w.text()).toContain('Envío externo desactivado')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('Elige explícitamente')
  })
  it('never exposes preference writes without confirmed DOI', async () => {
    fetchMock.mockResolvedValue(preference({ status: 'pending', canSave: false }))
    const w = await preferences()
    expect(w.find('form').exists()).toBe(false)
    expect(w.text()).toContain('doble opt-in')
  })
  it('saves explicit frequency and re-reads a confirmed snapshot', async () => {
    let committed = false
    fetchMock.mockImplementation(async (_path, options) => {
      if (options?.method === 'PUT') {
        committed = true
        return { source: 'cloudflare', resourceId: SUB, revision: 1, action: 'save', updated: true }
      }
      return committed
        ? preference({ revision: 1, preference: { frequency: 'weekly', topics: [], locale: 'es', quietHours: null } })
        : preference()
    })
    const w = await preferences()
    await w.find('select[aria-label="Frecuencia newsletter"]').setValue('weekly')
    await w.find('form').trigger('submit')
    await flushPromises()
    const calls = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1].body).toEqual({
      action: 'save',
      expectedRevision: 0,
      preference: { frequency: 'weekly', topics: [], locale: 'es', quietHours: null }
    })
    expect(w.text()).toContain('guardadas y confirmadas')
  })
  it('manual retry preserves exact key and payload; no automatic retry', async () => {
    fetchMock.mockImplementation(async (_path, options) => {
      if (options?.method === 'PUT') throw new Error('ambiguous')
      return preference()
    })
    const w = await preferences()
    await w.find('select[aria-label="Frecuencia newsletter"]').setValue('monthly')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(1)
    await w
      .findAll('button')
      .find((b) => b.text() === 'Reintentar misma petición')!
      .trigger('click')
    await flushPromises()
    const calls = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')
    expect(calls).toHaveLength(2)
    expect(calls[1]![1].body).toEqual(calls[0]![1].body)
    expect(calls[1]![1].headers['Idempotency-Key']).toBe(calls[0]![1].headers['Idempotency-Key'])
  })
  it('requires an explicit second confirmation for irreversible unsubscribe', async () => {
    fetchMock.mockResolvedValue(preference())
    const w = await preferences()
    await w
      .findAll('button')
      .find((b) => b.text() === 'Darme de baja')!
      .trigger('click')
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(0)
    expect(w.text()).toContain('retira el consentimiento')
  })
  it('drops old identity results and capabilities when authority changes', async () => {
    fetchMock.mockResolvedValue(preference())
    const w = await preferences()
    authority.value = false
    await flushPromises()
    expect(w.find('form').exists()).toBe(false)
    expect(w.text()).not.toContain('Estado confirmado')
  })
  it('does not accept mismatched receipt ownership', async () => {
    fetchMock.mockImplementation(async (_path, options) =>
      options?.method === 'PUT'
        ? { source: 'cloudflare', resourceId: ACTOR, revision: 1, action: 'save', updated: true }
        : preference()
    )
    const w = await preferences()
    await w.find('select').setValue('weekly')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.text()).toContain('Resultado no confirmado')
    expect(w.text()).not.toContain('guardadas y confirmadas')
  })
  it('never treats a Node/partial response as server authority', async () => {
    fetchMock.mockResolvedValue({ preferences: [], source: 'node' })
    const w = await preferences()
    expect(w.find('form').exists()).toBe(false)
    expect(w.text()).toContain('No hay una lectura confirmada')
  })
  it('conclusive CAS denial discards only the rejected command and requires a fresh read', async () => {
    let reads = 0
    fetchMock.mockImplementation(async (_path, options) => {
      if (options?.method === 'PUT')
        throw Object.assign(new Error('CAS'), { statusCode: 409, data: { error: { code: 'version_conflict' } } })
      return preference({ revision: reads++ ? 2 : 0 })
    })
    const w = await preferences()
    await w.find('select').setValue('weekly')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.text()).toContain('rechazado el comando antes')
    expect(w.text()).not.toContain('Reintentar misma petición')
    expect(w.find('form').exists()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await w
      .findAll('button')
      .find((b) => b.text() === 'Actualizar estado confirmado')!
      .trigger('click')
    await flushPromises()
    await w.find('select').setValue('monthly')
    await w.find('form').trigger('submit')
    await flushPromises()
    const writes = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')
    expect(writes).toHaveLength(2)
    expect(writes[1]![1].body.expectedRevision).toBe(2)
    expect(writes[1]![1].headers['Idempotency-Key']).not.toBe(writes[0]![1].headers['Idempotency-Key'])
  })
  it.each(['idempotency_conflict', 'provider_outcome_unknown'])(
    'keeps exact envelope for nonconclusive 409 %s',
    async (code) => {
      fetchMock.mockImplementation(async (_path, options) => {
        if (options?.method === 'PUT')
          throw Object.assign(new Error('not conclusive'), { statusCode: 409, data: { error: { code } } })
        return preference()
      })
      const w = await preferences()
      await w.find('select').setValue('weekly')
      await w.find('form').trigger('submit')
      await flushPromises()
      expect(w.text()).toContain('Resultado no confirmado')
      await w
        .findAll('button')
        .find((b) => b.text() === 'Reintentar misma petición')!
        .trigger('click')
      await flushPromises()
      const writes = fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')
      expect(writes).toHaveLength(2)
      expect(writes[1]![1].body).toEqual(writes[0]![1].body)
      expect(writes[1]![1].headers['Idempotency-Key']).toBe(writes[0]![1].headers['Idempotency-Key'])
    }
  )
  it.each([401, 403])('removes private state after authenticated HTTP authority loss %s', async (statusCode) => {
    fetchMock.mockImplementation(async (_path, options) => {
      if (options?.method === 'PUT') throw Object.assign(new Error('authority lost'), { statusCode })
      return preference()
    })
    const w = await preferences()
    await w.find('select').setValue('weekly')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('form').exists()).toBe(false)
    expect(w.text()).not.toContain('Estado confirmado')
    expect(w.text()).not.toContain('Reintentar misma petición')
    expect(w.text()).toContain('retirado los datos privados')
  })
})
describe('newsletter campaign authoring and preview', () => {
  it('renders empty governance without approval defaults or delivery claims', async () => {
    fetchMock.mockResolvedValue(admin())
    const w = await editor()
    expect(w.text()).toContain('No existe una política aprobada')
    expect(w.text()).toContain('Entrega desactivada')
    expect(w.findAll<HTMLInputElement>('input[type="number"]').every((input) => input.element.value === '')).toBe(true)
  })
  it('does not show synthetic test/delivery controls without server capabilities', async () => {
    fetchMock.mockResolvedValue(admin())
    const w = await editor()
    expect(w.text()).not.toContain('Prueba sintética local')
    expect(w.text()).not.toContain('Procesar lote')
  })
  it('blocks approval and writing for partial/unconfirmed snapshots', async () => {
    fetchMock.mockResolvedValue({ ...admin(), capabilities: { manage: true } })
    const w = await editor()
    expect(w.findAll('form')).toHaveLength(0)
    expect(w.text()).toContain('Lectura no confirmada')
  })
  it('invalidates pending UI data on live authority loss', async () => {
    fetchMock.mockResolvedValue(admin())
    const w = await editor()
    authority.value = false
    await flushPromises()
    expect(w.text()).not.toContain('Política gobernante')
    expect(w.findAll('form')).toHaveLength(0)
  })
  it('preview supports desktop/mobile/plain text in an inert sandbox', async () => {
    const value = {
      source: 'cloudflare',
      campaignId: SUB,
      versionId: VERSION,
      synthetic: true,
      externalDelivery: false,
      subject: 'Preview sintético',
      html: '<p>Texto seguro</p>',
      text: 'Texto plano seguro',
      editorialPercent: 100,
      actionsEnabled: false
    }
    const w = await mountSuspended(NewsletterCampaignPreview, { props: { value } })
    wrappers.push(w)
    expect(w.find('iframe').attributes('sandbox')).toBe('')
    expect(w.find('iframe').attributes('referrerpolicy')).toBe('no-referrer')
    await w.find('select').setValue('mobile')
    expect(w.find('iframe').attributes('style')).toContain('375px')
    await w.find('select').setValue('text')
    expect(w.find('iframe').exists()).toBe(false)
    expect(w.text()).toContain('Texto plano seguro')
  })
  it('rejects a preview claiming real actions', async () => {
    const w = await mountSuspended(NewsletterCampaignPreview, {
      props: { value: { actionsEnabled: true, externalDelivery: true } }
    })
    wrappers.push(w)
    expect(w.find('iframe').exists()).toBe(false)
  })
  it('conclusive admin CAS clears stale capabilities and requires authoritative reload', async () => {
    fetchMock.mockImplementation(async (_path, options) => {
      if (options?.method === 'POST')
        throw Object.assign(new Error('CAS'), { statusCode: 409, data: { error: { code: 'version_conflict' } } })
      return admin()
    })
    const w = await editor(),
      form = w.findAll('form')[1]!
    await w.find('textarea[aria-label="Motivo editorial"]').setValue('Motivo sintético explícito')
    await form.findAll('input')[0]!.setValue('tema-explicito')
    await form.findAll('input')[1]!.setValue('Tema explícito')
    await form.trigger('submit')
    await flushPromises()
    expect(w.text()).toContain('rechazado el comando antes')
    expect(w.findAll('form')).toHaveLength(0)
    expect(w.text()).not.toContain('Reintentar mismo comando')
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(1)
  })
})
