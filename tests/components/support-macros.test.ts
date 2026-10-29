import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import AdminSupportMacrosPanel from '../../app/components/AdminSupportMacrosPanel.vue'
import '#app/nuxt-vitest-app-entry'
import { ref } from 'vue'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('$fetch', () => request)
afterEach(() => request.mockReset())
const MACRO = '21111111-1111-4111-8111-111111111111',
  REVISION = '31111111-1111-4111-8111-111111111111',
  REF = 'SOP-' + 'A'.repeat(24)
const content = {
  title: 'Acuse de revisión',
  body: 'Ticket {{ticket.reference}}: {{personal.nextStep}}.',
  tone: 'Claro y cercano sin promesas no verificadas',
  personalizations: [{ key: 'nextStep', label: 'Siguiente paso', required: true }]
}
const review = {
  operationalReference: 'fixture-ops',
  legalReference: 'fixture-legal',
  reviewedAt: '2026-10-08T10:00:00Z',
  expiresAt: '2026-11-08T10:00:00Z'
}
const approved = () => ({
  source: 'cloudflare',
  truncated: false,
  macros: [
    {
      macroId: MACRO,
      revisionId: REVISION,
      version: 2,
      state: 'approved',
      snapshot: { content, review },
      history: [],
      historyTruncated: true
    }
  ]
})
async function panel() {
  const authority = ref(true)
  const wrapper = await mountSuspended(AdminSupportMacrosPanel, {
    props: {
      publicRef: REF,
      operatorId: '11111111-1111-4111-8111-111111111111',
      runtime: 'cloudflare',
      authorize: () => authority.value
    }
  })
  return { wrapper, authority }
}
it('loads only on explicit request and describes empty library without claiming legal approval', async () => {
  request.mockResolvedValue({ source: 'cloudflare', macros: [], truncated: false })
  const wrapper = await mountSuspended(AdminSupportMacrosPanel, {
    props: {
      publicRef: 'SOP-' + 'A'.repeat(24),
      operatorId: '11111111-1111-4111-8111-111111111111',
      runtime: 'cloudflare',
      authorize: () => true
    }
  })
  expect(request.mock.calls.filter((call) => call[0].startsWith('/api/admin/support'))).toHaveLength(0)
  await wrapper.get('[data-testid="macros-load"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('No hay plantillas')
  const calls = request.mock.calls.filter((call) => call[0].startsWith('/api/admin/support'))
  expect(calls).toHaveLength(1)
  expect(calls[0]?.[1]?.method ?? 'GET').toBe('GET')
  wrapper.unmount()
})
it('personalizes explicitly, previews without email side effects and requires a separate use action', async () => {
  request.mockResolvedValueOnce(approved())
  const { wrapper } = await panel()
  await wrapper.get('[data-testid="macros-load"]').trigger('click')
  await flushPromises()
  await wrapper.get('select').setValue(MACRO)
  await wrapper.get('input[maxlength="300"]').setValue('Revisar el pedido')
  const result = {
    source: 'cloudflare',
    publicRef: REF,
    ticketVersion: 1,
    message: 'Respuesta renderizada revisada',
    selection: { macroId: MACRO, revisionId: REVISION, personalizations: { nextStep: 'Revisar el pedido' } },
    review
  }
  request.mockResolvedValueOnce(result)
  await wrapper.get('[data-testid="macro-preview"]').trigger('click')
  await flushPromises()
  expect(wrapper.emitted('selected')).toBeUndefined()
  expect(request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(0)
  await wrapper.get('[data-testid="macro-use"]').trigger('click')
  expect(wrapper.emitted('selected')?.[0]).toEqual([result])
  wrapper.unmount()
})
it('does not restore a stale preview when personalization changed while its request was pending', async () => {
  request.mockResolvedValueOnce(approved())
  const { wrapper } = await panel()
  await wrapper.get('[data-testid="macros-load"]').trigger('click')
  await flushPromises()
  await wrapper.get('select').setValue(MACRO)
  await wrapper.get('input[maxlength="300"]').setValue('Paso anterior')
  let resolve!: (value: unknown) => void
  request.mockReturnValueOnce(
    new Promise((value) => {
      resolve = value
    })
  )
  await wrapper.get('[data-testid="macro-preview"]').trigger('click')
  await wrapper.get('input[maxlength="300"]').setValue('Paso actual diferente')
  resolve({
    source: 'cloudflare',
    publicRef: REF,
    ticketVersion: 1,
    message: 'Paso anterior',
    selection: { macroId: MACRO, revisionId: REVISION, personalizations: { nextStep: 'Paso anterior' } },
    review
  })
  await flushPromises()
  expect(wrapper.find('[data-testid="macro-use"]').exists()).toBe(false)
  wrapper.unmount()
})
it('clears private library when current operator authority disappears', async () => {
  request.mockResolvedValueOnce(approved())
  const { wrapper, authority } = await panel()
  await wrapper.get('[data-testid="macros-load"]').trigger('click')
  await flushPromises()
  authority.value = false
  await flushPromises()
  expect(wrapper.text()).not.toContain(content.title)
  expect(wrapper.find('[data-testid="macro-preview"]').exists()).toBe(false)
  wrapper.unmount()
})
it('keeps the exact command and key frozen after response loss, then GETs before manual replay', async () => {
  const empty = { source: 'cloudflare', macros: [], truncated: false }
  request.mockResolvedValueOnce(empty)
  const { wrapper } = await panel()
  await wrapper.get('[data-testid="macros-load"]').trigger('click')
  await flushPromises()
  await wrapper.get('input[maxlength="120"]').setValue('Borrador sintético')
  await wrapper.get('textarea[maxlength="4000"]').setValue('Texto fijo de revisión sintética.')
  await wrapper.get('input[maxlength="300"]').setValue('Claro y cercano, sin promesas no verificadas')
  await wrapper.get('input[maxlength="500"]').setValue('Motivo de edición documentado')
  await wrapper.get('[data-testid="macro-draft"]').trigger('click')
  expect(request).toHaveBeenCalledTimes(1)
  request.mockResolvedValueOnce(empty).mockRejectedValueOnce(new Error('response lost'))
  await wrapper.get('[data-testid="macro-confirm"]').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('Resultado incierto')
  expect(wrapper.find('textarea').exists()).toBe(false)
  const first = request.mock.calls.find((call) => call[1]?.method === 'PUT')!
  request
    .mockResolvedValueOnce(empty)
    .mockResolvedValueOnce({
      source: 'cloudflare',
      commandId: REVISION,
      macroId: first[0].split('/').at(-1),
      version: 1,
      state: 'draft',
      updated: true
    })
    .mockResolvedValueOnce(empty)
  await wrapper.get('[data-testid="macro-confirm"]').trigger('click')
  await flushPromises()
  const calls = request.mock.calls.filter((call) => call[1]?.method === 'PUT')
  expect(calls).toHaveLength(2)
  expect(calls[1]?.[1]?.body).toEqual(calls[0]?.[1]?.body)
  expect(calls[1]?.[1]?.headers).toEqual(calls[0]?.[1]?.headers)
  expect(request.mock.calls.map((call) => call[1]?.method ?? 'GET')).toEqual(['GET', 'GET', 'PUT', 'GET', 'PUT', 'GET'])
  wrapper.unmount()
})
it('navigates bounded library pages and requests older history explicitly', async () => {
  request.mockResolvedValueOnce({ ...approved(), nextMacroId: MACRO, truncated: true })
  const { wrapper } = await panel()
  await wrapper.get('[data-testid="macros-load"]').trigger('click')
  await flushPromises()
  request.mockResolvedValueOnce({ ...approved(), nextMacroId: null })
  await wrapper.get('[data-testid="macros-next"]').trigger('click')
  await flushPromises()
  expect(request.mock.calls.at(-1)?.[0]).toBe('/api/admin/support/macros?afterMacroId=' + MACRO)
  await wrapper.get('select').setValue(MACRO)
  request.mockResolvedValueOnce(approved())
  await wrapper.get('[data-testid="macro-history-load"]').trigger('click')
  await flushPromises()
  expect(request.mock.calls.at(-1)?.[0]).toBe('/api/admin/support/macros/' + MACRO)
  wrapper.unmount()
})
async function draftPanel() {
  request.mockResolvedValueOnce({ source: 'cloudflare', macros: [], truncated: false })
  const { wrapper } = await panel()
  await wrapper.get('[data-testid="macros-load"]').trigger('click')
  await flushPromises()
  await wrapper.get('input[maxlength="120"]').setValue('Borrador sintético')
  await wrapper.get('textarea[maxlength="4000"]').setValue('Texto fijo de revisión sintética.')
  await wrapper.get('input[maxlength="300"]').setValue('Claro y cercano, sin promesas no verificadas')
  await wrapper.get('input[maxlength="500"]').setValue('Motivo de edición documentado')
  await wrapper.get('[data-testid="macro-draft"]').trigger('click')
  return wrapper
}
it('never sends a command when unmounted while its preflight GET was pending', async () => {
  const wrapper = await draftPanel()
  let resolve!: (value: unknown) => void
  request.mockReturnValueOnce(
    new Promise((value) => {
      resolve = value
    })
  )
  await wrapper.get('[data-testid="macro-confirm"]').trigger('click')
  wrapper.unmount()
  resolve({ source: 'cloudflare', macros: [], truncated: false })
  await flushPromises()
  expect(request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(0)
  expect(wrapper.emitted('selected')).toBeUndefined()
  expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
})
it('does not follow up or emit selection after a pending PUT resolves on an unmounted panel', async () => {
  const wrapper = await draftPanel()
  let resolve!: (value: unknown) => void
  request.mockResolvedValueOnce({ source: 'cloudflare', macros: [], truncated: false }).mockReturnValueOnce(
    new Promise((value) => {
      resolve = value
    })
  )
  await wrapper.get('[data-testid="macro-confirm"]').trigger('click')
  await flushPromises()
  const call = request.mock.calls.find((call) => call[1]?.method === 'PUT')!
  wrapper.unmount()
  resolve({
    source: 'cloudflare',
    commandId: REVISION,
    macroId: call[0].split('/').at(-1),
    version: 1,
    state: 'draft',
    updated: true
  })
  await flushPromises()
  expect(request.mock.calls.filter((call) => (call[1]?.method ?? 'GET') === 'GET')).toHaveLength(2)
  expect(wrapper.emitted('selected')).toBeUndefined()
  expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
})
