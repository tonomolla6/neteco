import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCategoryMerchandising from '../../app/components/AdminCategoryMerchandising.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useUserSession', () => mocks.session)

const CAT = 'c0700000-0000-4000-8000-000000000001'
const RULE = 'd0700000-0000-4000-8000-000000000001'
const P1 = 'e0700000-0000-4000-8000-000000000001'
const P2 = 'e0700000-0000-4000-8000-000000000002'
const categories = { items: [{ id: CAT, name: 'Limpieza', slug: 'limpieza', parentId: null }] }
const rule = (extra = {}) => ({
  id: RULE,
  categoryId: CAT,
  weights: { stock: 0, margin: 5, popularity: 3, contract: 0, campaign: 0 },
  guardrails: { minStock: 5, minMarginBps: 1500, maxBoosted: 6 },
  campaign: { campaignId: null, productIds: [] },
  reason: 'Priorizar rentabilidad',
  validFrom: '2026-10-01T00:00:00Z',
  validUntil: '2099-01-01T00:00:00Z',
  status: 'active',
  authorId: 'a0700000-0000-4000-8000-000000000001',
  version: 2,
  updatedAt: '2026-10-02T00:00:00Z',
  state: 'live',
  ...extra
})
const previewResult = {
  source: 'cloudflare',
  rule: null,
  truncated: false,
  items: [
    {
      productId: P1,
      name: 'Lejía profesional',
      slug: 'lejia',
      position: 1,
      baselineRank: 2,
      score: 82.5,
      group: 'boosted',
      guardrails: [],
      contributions: [],
      sellableStock: 40,
      backorderAllowed: false,
      marginBps: 4000,
      units30d: 12,
      contract: false,
      campaign: false
    },
    {
      productId: P2,
      name: 'Fregasuelos',
      slug: 'fregasuelos',
      position: 2,
      baselineRank: 1,
      score: 0,
      group: 'demoted',
      guardrails: ['out_of_stock'],
      contributions: [],
      sellableStock: 0,
      backorderAllowed: false,
      marginBps: null,
      units30d: 0,
      contract: false,
      campaign: false
    }
  ]
}
let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref<{ id: string; emailVerified: boolean } | null>>
  session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number } | null>>
}
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const wrappers: Wrapper[] = []
function route(handlers: Record<string, unknown> = {}) {
  mocks.request.mockImplementation(async (path: string, options?: { method?: string }) => {
    const key = `${options?.method ?? 'GET'} ${path.split('?')[0]}`
    if (key in handlers) {
      const value = handlers[key]
      if (value instanceof Error) throw value
      return typeof value === 'function' ? (value as () => unknown)() : value
    }
    if (key === 'GET /api/admin/category-merchandising/categories') return categories
    if (key === 'GET /api/admin/category-merchandising')
      return { source: 'cloudflare', items: [], total: 0, page: 1, perPage: 25 }
    throw new Error(`unexpected ${key}`)
  })
}
async function mount() {
  const wrapper = await mountSuspended(AdminCategoryMerchandising)
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  mocks.request.mockReset()
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: '71000000-0000-4000-8000-000000000001', emailVerified: true }),
    session: ref({ sessionId: '72000000-0000-4000-8000-000000000001', sessionVersion: 1 })
  }
  mocks.session.mockReturnValue(auth)
})
afterEach(() => wrappers.splice(0).forEach((w) => w.unmount()))

describe('SEA-015 admin category merchandising UI', () => {
  it('loads categories and rules with a loading state and an empty state', async () => {
    route()
    const w = await mount()
    expect(w.find('[data-cm-loading]').exists()).toBe(false)
    expect(w.get('[data-cm-category]').text()).toContain('Limpieza')
    expect(w.get('[data-cm-empty]').text()).toContain('No hay reglas')
  })
  it('does nothing for anonymous sessions', async () => {
    auth.loggedIn.value = false
    route()
    const w = await mount()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(w.find('[data-cm-category]').exists()).toBe(false)
  })
  it('shows a readable error and retries when loading fails', async () => {
    route({
      'GET /api/admin/category-merchandising/categories': Object.assign(new Error('x'), {
        data: { error: { code: 'forbidden' } }
      })
    })
    const w = await mount()
    expect(w.get('[data-cm-error]').text()).toContain('permiso')
    route()
    await w.get('[data-cm-retry]').trigger('click')
    await flushPromises()
    expect(w.find('[data-cm-category]').exists()).toBe(true)
  })
  it('lists the rules with their state and the weights', async () => {
    route({
      'GET /api/admin/category-merchandising': { source: 'cloudflare', items: [rule()], total: 1, page: 1, perPage: 25 }
    })
    const w = await mount()
    const text = w.get(`[data-cm-rule="${RULE}"]`).text()
    expect(text).toContain('Limpieza')
    expect(text).toContain('En vigor')
    expect(text).toContain('rentabilidad')
  })
  it('previews a draft built from the form without saving, and shows scores and guardrails', async () => {
    route({ 'POST /api/admin/category-merchandising/preview': previewResult })
    const w = await mount()
    await w.get('[data-cm-category]').setValue(CAT)
    await w.get('[data-cm-w-margin]').setValue('5')
    await w.get('[data-cm-min-stock]').setValue('3')
    await w.get('[data-cm-min-margin]').setValue('15')
    await w.get('[data-cm-max-boosted]').setValue('4')
    await w.get('[data-cm-preview]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([path]) => String(path).endsWith('/preview'))!
    expect(call[1]).toMatchObject({
      method: 'POST',
      body: {
        categoryId: CAT,
        ruleId: null,
        companyId: null,
        draft: {
          weights: { stock: 0, margin: 5, popularity: 0, contract: 0, campaign: 0 },
          guardrails: { minStock: 3, minMarginBps: 1500, maxBoosted: 4 },
          campaign: { campaignId: null, productIds: [] }
        }
      }
    })
    const rows = w.findAll('[data-cm-result]').map((r) => r.text())
    expect(rows[0]).toContain('Lejía profesional')
    expect(rows[0]).toContain('82,5')
    expect(rows[1]).toContain('Sin stock')
    expect(rows[1]).toContain('al final')
  })
  it('requires at least one positive weight before previewing or saving', async () => {
    route()
    const w = await mount()
    await w.get('[data-cm-category]').setValue(CAT)
    expect(w.get('[data-cm-preview]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-cm-save]').attributes('disabled')).toBeDefined()
    await w.get('[data-cm-w-stock]').setValue('2')
    expect(w.get('[data-cm-preview]').attributes('disabled')).toBeUndefined()
  })
  it('requires a reason to save and sends an idempotency key with the rule', async () => {
    route({
      'POST /api/admin/category-merchandising': { source: 'cloudflare', commandId: 'x', action: 'save', item: rule() }
    })
    const w = await mount()
    await w.get('[data-cm-category]').setValue(CAT)
    await w.get('[data-cm-w-popularity]').setValue('4')
    expect(w.get('[data-cm-save]').attributes('disabled')).toBeDefined()
    await w.get('[data-cm-reason]').setValue('Campaña de otoño aprobada')
    await w.get('[data-cm-days]').setValue('14')
    await w.get('[data-cm-save]').trigger('click')
    await flushPromises()
    const call = mocks.request.mock.calls.find(
      ([path, o]) => path === '/api/admin/category-merchandising' && o?.method === 'POST'
    )!
    expect(call[1].headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9._:-]{8,}$/)
    expect(call[1].body).toMatchObject({
      action: 'save',
      id: null,
      expectedVersion: 0,
      categoryId: CAT,
      reason: 'Campaña de otoño aprobada'
    })
    const span = Date.parse(call[1].body.validUntil) - Date.parse(call[1].body.validFrom)
    expect(Math.round(span / 86_400_000)).toBe(14)
    expect(w.get('[data-cm-notice]').text()).toContain('guardada')
  })
  it('edits a stored rule with its version and retires it with a reason', async () => {
    route({
      'GET /api/admin/category-merchandising': {
        source: 'cloudflare',
        items: [rule()],
        total: 1,
        page: 1,
        perPage: 25
      },
      [`PUT /api/admin/category-merchandising/${RULE}`]: {
        source: 'cloudflare',
        commandId: 'x',
        action: 'save',
        item: rule({ version: 3 })
      },
      [`DELETE /api/admin/category-merchandising/${RULE}`]: {
        source: 'cloudflare',
        commandId: 'y',
        action: 'retire',
        item: rule({ status: 'retired', version: 3 })
      }
    })
    const w = await mount()
    await w.get(`[data-cm-edit="${RULE}"]`).trigger('click')
    expect((w.get('[data-cm-w-margin]').element as HTMLInputElement).value).toBe('5')
    expect((w.get('[data-cm-min-margin]').element as HTMLInputElement).value).toBe('15')
    await w.get('[data-cm-reason]').setValue('Ajuste de pesos revisado')
    await w.get('[data-cm-save]').trigger('click')
    await flushPromises()
    const put = mocks.request.mock.calls.find(([, o]) => o?.method === 'PUT')!
    expect(put[1].body).toMatchObject({ action: 'save', id: RULE, expectedVersion: 2 })
    await w.get(`[data-cm-retire="${RULE}"]`).trigger('click')
    await w.get('[data-cm-retire-reason]').setValue('Fin de campaña')
    await w.get('[data-cm-retire-confirm]').trigger('click')
    await flushPromises()
    const del = mocks.request.mock.calls.find(([, o]) => o?.method === 'DELETE')!
    expect(del[1].body).toEqual({ action: 'retire', id: RULE, expectedVersion: 2, reason: 'Fin de campaña' })
  })
  it('explains conflicts and rule overlaps', async () => {
    route({
      'POST /api/admin/category-merchandising': Object.assign(new Error('x'), {
        data: { error: { code: 'rule_conflict' } }
      })
    })
    const w = await mount()
    await w.get('[data-cm-category]').setValue(CAT)
    await w.get('[data-cm-w-popularity]').setValue('4')
    await w.get('[data-cm-reason]').setValue('Campaña de otoño aprobada')
    await w.get('[data-cm-save]').trigger('click')
    await flushPromises()
    expect(w.get('[data-cm-error]').text()).toContain('ya tiene una regla')
  })
  it('purges drafts and previews when the session changes', async () => {
    route({ 'POST /api/admin/category-merchandising/preview': previewResult })
    const w = await mount()
    await w.get('[data-cm-category]').setValue(CAT)
    await w.get('[data-cm-w-stock]').setValue('2')
    await w.get('[data-cm-preview]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-cm-result]')).toHaveLength(2)
    auth.session.value = { sessionId: '72000000-0000-4000-8000-000000000001', sessionVersion: 2 }
    await flushPromises()
    expect(w.findAll('[data-cm-result]')).toHaveLength(0)
  })
})
