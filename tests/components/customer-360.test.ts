import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Customer360Panel from '../../app/components/Customer360Panel.vue'
import '#app/nuxt-vitest-app-entry'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => request)
const ID = '90000000-0000-4000-8000-000000000001',
  NOW = '2026-10-10T00:00:00Z'
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
const redacted = () => ({ visibility: 'redacted', data: null })
function context() {
  return {
    source: 'cloudflare',
    customer: { id: ID, name: 'Cliente sintético', status: 'active' },
    evaluatedAt: NOW,
    orders: redacted(),
    tickets: { visibility: 'visible', data: { page: 1, perPage: 25, total: 0, pages: 0, items: [] } },
    invoices: redacted(),
    value: redacted(),
    consent: redacted(),
    nextAction: { visibility: 'visible', data: null }
  }
}
function picker() {
  return {
    source: 'cloudflare',
    items: [{ id: ID, name: 'Cliente sintético', status: 'active' }],
    page: 1,
    perPage: 25,
    total: 1,
    pages: 1
  }
}
beforeEach(() => request.mockReset())
afterEach(() => wrapper?.unmount())
async function panel() {
  wrapper = await mountSuspended(Customer360Panel, { props: { enabled: true, scopeKey: 'operator:1' } })
  return wrapper
}
async function search() {
  request.mockResolvedValueOnce(picker())
  await wrapper!.get('[data-customer-query]').setValue('Cliente')
  await wrapper!.get('form[data-customer-search]').trigger('submit')
  await flushPromises()
}
async function choose() {
  request.mockResolvedValueOnce(context())
  await wrapper!.get(`[data-customer-select="${ID}"]`).trigger('click')
  await flushPromises()
}
describe('CUS017 customer360 privacy-aware readonly UI', () => {
  it('does not read automatically and offers a bounded real customer picker instead of a manual ID form', async () => {
    await panel()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper!.get('[data-customer-query]').attributes('maxlength')).toBe('80')
    expect(wrapper!.text()).toContain('Buscar clientes')
    expect(wrapper!.find('[data-customer-uuid-input]').exists()).toBe(false)
  })
  it('selects an identifiable API customer and reads its exact context with no POST', async () => {
    await panel()
    await search()
    expect(wrapper!.text()).toContain('Cliente sintético')
    expect(wrapper!.text()).toContain(ID)
    await choose()
    expect(request.mock.calls[1]![0]).toBe(`/api/admin/customer-context/${ID}`)
    expect(wrapper!.text()).toContain('Sin próxima acción registrada')
    expect(request.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true)
  })
  it('shows financial redaction explicitly rather than zero or unauthorized totals', async () => {
    await panel()
    await search()
    await choose()
    expect(wrapper!.text()).toContain('Valor financiero: oculto por permisos')
    expect(wrapper!.text()).toContain('Facturas: ocultas por permisos')
    expect(wrapper!.text()).not.toContain('0,00')
    expect(wrapper!.text()).toContain('Incidencias: 0')
  })
  it('clears stale context after an outage and never presents it as an empty successful customer', async () => {
    await panel()
    await search()
    await choose()
    request.mockRejectedValueOnce({ statusCode: 503 })
    await wrapper!.get('[data-customer-refresh]').trigger('click')
    await flushPromises()
    expect(wrapper!.text()).toContain('No se ha podido confirmar')
    expect(wrapper!.text()).not.toContain('Incidencias: 0')
    expect(wrapper!.text()).not.toContain('Sin próxima acción registrada')
  })
  it('purges all private fields and ignores late answers after authority scope changes', async () => {
    await panel()
    await search()
    let resolve!: (value: unknown) => void
    request.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r
      })
    )
    await wrapper!.get(`[data-customer-select="${ID}"]`).trigger('click')
    await wrapper!.setProps({ enabled: false, scopeKey: 'operator:2' })
    resolve(context())
    await flushPromises()
    expect(wrapper!.text()).not.toContain('Cliente sintético')
    expect(wrapper!.text()).not.toContain(ID)
    expect(wrapper!.find('input').exists()).toBe(false)
  })
  it('purges picker and selected customer on confirmed 403 revocation', async () => {
    await panel()
    await search()
    request.mockRejectedValueOnce({ statusCode: 403 })
    await wrapper!.get(`[data-customer-select="${ID}"]`).trigger('click')
    await flushPromises()
    expect(wrapper!.text()).not.toContain('Cliente sintético')
    expect(wrapper!.text()).not.toContain(ID)
    expect(wrapper!.find('input').exists()).toBe(false)
  })
})
