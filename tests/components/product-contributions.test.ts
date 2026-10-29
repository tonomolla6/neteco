import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProductContributionsPanel from '../../app/components/ProductContributionsPanel.vue'
import AdminProductContributionsPanel from '../../app/components/AdminProductContributionsPanel.vue'
import { productContributionIntentHash } from '../../shared/product-contributions'
import '#app/nuxt-vitest-app-entry'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => request)
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
const ID = '90000000-0000-4000-8000-000000000001',
  NOW = '2026-10-10T00:00:00Z'
function item(admin = false) {
  return {
    source: 'cloudflare',
    id: ID,
    productId: 1,
    kind: 'question',
    score: null,
    title: 'Consulta sintética',
    body: '¿Dónde se encuentra la documentación aprobada?',
    origin: 'unverified',
    answer: null,
    reply: null,
    questionStatus: 'open',
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    state: 'pending',
    slaDueAt: null,
    capabilities: { canReply: !admin, canModerate: admin },
    history: [{ action: 'submit', version: 1, recordedAt: NOW }]
  }
}
function list(admin = false) {
  return { source: 'cloudflare', page: 1, perPage: 25, total: 1, pages: 1, items: [item(admin)] }
}
beforeEach(() => request.mockReset())
afterEach(() => wrapper?.unmount())
async function panel(admin = false) {
  wrapper = await mountSuspended(admin ? AdminProductContributionsPanel : ProductContributionsPanel, {
    props: { scopeKey: 'actor:1', enabled: true, ...(admin ? {} : { productId: 1, customerEnabled: true }) }
  })
  return wrapper
}
async function click(text: string) {
  const button = wrapper!.findAll('button').find((b) => b.text() === text)
  expect(button).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}
async function draft() {
  await wrapper!.get('[data-contribution-title]').setValue('Consulta sintética')
  await wrapper!.get('[data-contribution-body]').setValue('¿Dónde se encuentra la documentación aprobada?')
  await wrapper!.get('[data-contribution-privacy]').setValue(true)
  await wrapper!.get('form[data-contribution-submit]').trigger('submit')
  await vi.waitFor(() => expect(wrapper!.text()).toContain('Confirmar aportación'))
}
describe('MKT024/025 explicit moderated contribution UI', () => {
  it('offers explicit reads and requires a confirmed product for new content', async () => {
    await panel()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper!.text()).toContain('Consultar reseñas y preguntas')
    await wrapper!.setProps({ productId: undefined })
    expect(wrapper!.find('form[data-contribution-submit]').exists()).toBe(false)
  })
  it('renders reviewed public origin and expert answer without HTML interpretation', async () => {
    await panel()
    const { source: _s, version: _v, state: _st, slaDueAt: _sla, capabilities: _c, history: _h, ...publicItem } = item()
    request.mockResolvedValueOnce({
      source: 'cloudflare',
      productId: 1,
      page: 1,
      perPage: 25,
      total: 1,
      pages: 1,
      items: [
        { ...publicItem, origin: 'verified_purchase', answer: 'Respuesta experta revisada <script>unsafe</script>' }
      ]
    })
    await click('Consultar reseñas y preguntas')
    expect(wrapper!.text()).toContain('Compra verificada')
    expect(wrapper!.text()).toContain('Respuesta experta revisada')
    expect(wrapper!.find('script').exists()).toBe(false)
  })
  it('freezes a confirmed submission and never repeats an uncertain POST', async () => {
    await panel()
    await draft()
    request.mockRejectedValueOnce(new Error('lost'))
    await click('Confirmar aportación')
    expect(wrapper!.text()).toContain('Resultado incierto')
    expect(request.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1)
    expect(wrapper!.text()).toContain('Comprobar aportación')
    await flushPromises()
    expect(request.mock.calls).toHaveLength(1)
  })
  it('recovers only exact receipt plus current detail and does not POST again', async () => {
    await panel()
    await draft()
    request.mockRejectedValueOnce(new Error('lost'))
    await click('Confirmar aportación')
    const [, options] = request.mock.calls[0]!,
      body = options.body,
      key = options.headers['Idempotency-Key']
    const receipt = {
      source: 'cloudflare',
      commandId: key,
      contributionId: ID,
      action: 'submit',
      expectedVersion: 0,
      version: 1,
      payloadHash: await productContributionIntentHash('submit', null, body),
      recordedAt: NOW,
      inventoryEffect: 'none',
      economicEffect: 'none',
      senderInvoked: false
    }
    request
      .mockResolvedValueOnce({ source: 'cloudflare', outcome: 'applied', receipt })
      .mockResolvedValueOnce(item())
      .mockResolvedValueOnce(list())
    await click('Comprobar aportación')
    expect(wrapper!.text()).toContain('Aportación confirmada')
    expect(request.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1)
    expect(request.mock.calls[1]![1].headers['X-Neteco-Command-Payload-Hash']).toBe(receipt.payloadHash)
  })
  it('does not treat unknown recovery as absence or success', async () => {
    await panel()
    await draft()
    request.mockRejectedValueOnce(new Error('lost'))
    await click('Confirmar aportación')
    request.mockResolvedValueOnce({ source: 'cloudflare', outcome: 'unknown', receipt: null })
    await click('Comprobar aportación')
    expect(wrapper!.text()).toContain('Resultado incierto')
    expect(wrapper!.text()).not.toContain('Aportación confirmada')
    expect(request.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1)
  })
  it('loads the admin queue and explicitly reviews an expert answer', async () => {
    await panel(true)
    request.mockResolvedValueOnce(list(true))
    await click('Consultar cola de moderación')
    await click('Revisar aportación')
    await wrapper!.get('[data-contribution-action]').setValue('answer')
    await wrapper!.get('[data-contribution-answer]').setValue('Respuesta experta revisada y documentada.')
    await wrapper!.get('[data-contribution-reason]').setValue('Revisión operativa explícita y documentada.')
    await wrapper!.get('[data-contribution-reference]').setValue('runbook-interno-1')
    await wrapper!.get('form[data-contribution-review]').trigger('submit')
    await vi.waitFor(() => expect(wrapper!.text()).toContain('Confirmar aportación'))
    expect(request.mock.calls).toHaveLength(1)
  })
  it('purges private drafts and ignores late reads after scope changes', async () => {
    await panel()
    await wrapper!.get('[data-contribution-body]').setValue('Contenido privado sintético pendiente')
    let resolve!: (v: unknown) => void
    request.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r
      })
    )
    await wrapper!
      .findAll('button')
      .find((b) => b.text() === 'Consultar mis aportaciones')!
      .trigger('click')
    await wrapper!.setProps({ scopeKey: 'actor:2', enabled: false })
    resolve(list())
    await flushPromises()
    expect(wrapper!.text()).not.toContain('Consulta sintética')
    expect(wrapper!.find('textarea').exists()).toBe(false)
    expect(wrapper!.emitted('pending')?.at(-1)).toEqual([false])
  })
  it('purges private content on confirmed authentication revocation', async () => {
    await panel()
    await draft()
    request.mockRejectedValueOnce({ statusCode: 403 })
    await click('Confirmar aportación')
    expect(wrapper!.text()).not.toContain('¿Dónde se encuentra')
    expect(wrapper!.text()).not.toContain('Comprobar aportación')
    expect(wrapper!.emitted('pending')?.at(-1)).toEqual([false])
  })
})
