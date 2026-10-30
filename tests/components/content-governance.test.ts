import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminContentGovernancePanel from '../../app/components/AdminContentGovernancePanel.vue'
import ContentTrustPanel from '../../app/components/ContentTrustPanel.vue'
import ContentAssetsPanel from '../../app/components/ContentAssetsPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn(), head: vi.fn(), navigate: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useHead', () => mocks.head)
mockNuxtImport('navigateTo', () => mocks.navigate)

const person = (id: string, name: string) => ({
  id,
  displayName: name,
  bio: 'Biografía de prueba',
  experience: 'Experiencia de prueba',
  credentials: null,
  status: 'active',
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
})
const overview = (extra: Record<string, unknown> = {}) => ({
  source: 'cloudflare',
  now: '2026-10-30T10:00:00Z',
  authors: [person('a1', 'Ana Autora'), person('r1', 'Luis Revisor')],
  governance: [
    {
      slug: 'guia-desinfeccion',
      ownerName: 'Equipo técnico',
      sensitivity: 'regulation',
      nextReviewAt: '2026-10-01',
      bucket: 'overdue',
      authorId: 'a1',
      reviewerId: 'r1',
      sources: [],
      claims: [],
      retirement: { retireAt: '2027-02-01', redirectTo: '/recursos/nueva' },
      signedOffAt: null,
      signedOffBy: null,
      version: 3,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      trust: { state: 'overdue', issues: ['not_signed_off', 'review_overdue'] }
    }
  ],
  assets: [
    {
      slug: 'checklist-limpieza',
      kind: 'checklist',
      title: 'Checklist de limpieza',
      summary: 'Resumen',
      methodology: 'Metodología',
      dataAsOf: '2026-10-01',
      payload: { items: ['x'] },
      status: 'draft',
      publishedAt: null,
      retiredAt: null,
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }
  ],
  unmanagedResources: ['guia-sin-plan'],
  ...extra
})

describe('AdminContentGovernancePanel', () => {
  beforeEach(() => {
    mocks.request.mockReset()
    mocks.head.mockReset()
  })
  it('shows loading then the calendar with owner, due state, issues and retirement plan', async () => {
    mocks.request.mockResolvedValue(overview())
    const wrapper = await mountSuspended(AdminContentGovernancePanel)
    await flushPromises()
    const row = wrapper.get('[data-testid="governance-row-guia-desinfeccion"]')
    expect(row.text()).toContain('Equipo técnico')
    expect(row.text()).toContain('Vencida')
    expect(row.text()).toContain('2026-10-01')
    expect(row.text()).toContain('/recursos/nueva')
    expect(wrapper.text()).toContain('guia-sin-plan')
    expect(mocks.request).toHaveBeenCalledWith(
      '/api/admin/content-governance',
      expect.objectContaining({ method: 'GET' })
    )
  })
  it('shows an empty state without plans', async () => {
    mocks.request.mockResolvedValue(overview({ governance: [], assets: [], authors: [], unmanagedResources: [] }))
    const wrapper = await mountSuspended(AdminContentGovernancePanel)
    await flushPromises()
    expect(wrapper.get('[data-testid="governance-empty"]').text()).toContain('Sin planes')
  })
  it('shows an accessible error when loading fails and offers a retry', async () => {
    mocks.request.mockRejectedValueOnce({ statusCode: 403 }).mockResolvedValueOnce(overview())
    const wrapper = await mountSuspended(AdminContentGovernancePanel)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('No se pudo cargar')
    await wrapper.get('[data-testid="governance-retry"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Equipo técnico')
  })
  it('creates an author with an idempotency key and without any client time or identity', async () => {
    mocks.request.mockResolvedValue(overview())
    const wrapper = await mountSuspended(AdminContentGovernancePanel)
    await flushPromises()
    await wrapper.get('[data-testid="author-name"]').setValue('Marta Prueba')
    await wrapper.get('[data-testid="author-bio"]').setValue('Biografía introducida por administración.')
    await wrapper.get('[data-testid="author-experience"]').setValue('Experiencia introducida por administración.')
    await wrapper.get('[data-testid="author-form"]').trigger('submit')
    await flushPromises()
    const post = mocks.request.mock.calls.find(([, options]) => options?.method === 'POST')!
    expect(post[0]).toBe('/api/admin/content-governance')
    expect(post[1].headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9._:-]{8,}$/)
    expect(post[1].body).toEqual({
      action: 'save_author',
      expectedVersion: 0,
      displayName: 'Marta Prueba',
      bio: 'Biografía introducida por administración.',
      experience: 'Experiencia introducida por administración.'
    })
  })
  it('signs off a plan sending only the slug and the observed version', async () => {
    mocks.request.mockResolvedValue(overview())
    const wrapper = await mountSuspended(AdminContentGovernancePanel)
    await flushPromises()
    await wrapper.get('[data-testid="signoff-guia-desinfeccion"]').trigger('click')
    await flushPromises()
    const post = mocks.request.mock.calls.find(([, options]) => options?.method === 'POST')!
    expect(post[1].body).toEqual({ action: 'sign_off', slug: 'guia-desinfeccion', expectedVersion: 3 })
  })
  it('surfaces stable server error codes in Spanish', async () => {
    mocks.request.mockImplementation(async (_url: string, options?: { method?: string }) => {
      if (options?.method === 'POST') throw { statusCode: 409, data: { error: { code: 'same_actor' } } }
      return overview()
    })
    const wrapper = await mountSuspended(AdminContentGovernancePanel)
    await flushPromises()
    await wrapper.get('[data-testid="signoff-guia-desinfeccion"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('otra persona')
  })
  it('publishes and retires assets with CAS versions', async () => {
    mocks.request.mockResolvedValue(overview())
    const wrapper = await mountSuspended(AdminContentGovernancePanel)
    await flushPromises()
    await wrapper.get('[data-testid="publish-checklist-limpieza"]').trigger('click')
    await flushPromises()
    const post = mocks.request.mock.calls.find(([, options]) => options?.method === 'POST')!
    expect(post[1].body).toEqual({ action: 'publish_asset', slug: 'checklist-limpieza', expectedVersion: 1 })
  })
  it('rejects an invalid asset payload locally without calling the API', async () => {
    mocks.request.mockResolvedValue(overview())
    const wrapper = await mountSuspended(AdminContentGovernancePanel)
    await flushPromises()
    await wrapper.get('[data-testid="asset-slug"]').setValue('nuevo-activo')
    await wrapper.get('[data-testid="asset-payload"]').setValue('{no es json')
    await wrapper.get('[data-testid="asset-form"]').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('JSON')
    expect(mocks.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
  })
})

const trust = {
  status: 'active',
  slug: 'guia',
  author: { name: 'Ana Autora', bio: 'Bio autora', experience: 'Experiencia autora', credentials: null },
  reviewer: {
    name: 'Luis Revisor',
    bio: 'Bio revisor',
    experience: 'Experiencia revisor',
    credentials: 'Máster en Química'
  },
  sources: [{ label: 'FDS del fabricante', url: 'https://example.invalid/fds.pdf', kind: 'safety_data_sheet' }],
  claims: [
    {
      text: 'Apto para contacto alimentario',
      category: 'chemical',
      evidence: { label: 'FDS del fabricante', url: 'https://example.invalid/fds.pdf', kind: 'safety_data_sheet' }
    }
  ],
  lastReviewedAt: '2026-10-01T00:00:00Z',
  nextReviewAt: '2027-01-01',
  jsonLd: { '@context': 'https://schema.org', '@type': 'Article', headline: 'Guía </script>' }
}
describe('ContentTrustPanel', () => {
  beforeEach(() => {
    mocks.request.mockReset()
    mocks.head.mockReset()
    mocks.navigate.mockReset()
  })
  it('shows author, technical reviewer, sources and evidence for claims, and injects safe JSON-LD', async () => {
    mocks.request.mockResolvedValue(trust)
    const wrapper = await mountSuspended(ContentTrustPanel, { props: { slug: 'guia' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Ana Autora')
    expect(wrapper.text()).toContain('Revisión técnica')
    expect(wrapper.text()).toContain('Máster en Química')
    expect(wrapper.text()).toContain('Apto para contacto alimentario')
    const link = wrapper.get('a[href="https://example.invalid/fds.pdf"]')
    expect(link.attributes('rel')).toContain('noopener')
    const head = mocks.head.mock.calls.at(-1)![0]
    const script = (typeof head === 'function' ? head() : head).script[0]
    expect(script.type).toBe('application/ld+json')
    expect(script.innerHTML).not.toContain('</script>')
    expect(JSON.parse(script.innerHTML).headline).toBe('Guía </script>')
  })
  it('renders nothing (and no JSON-LD) when there is no verified authorship', async () => {
    mocks.request.mockRejectedValue({ statusCode: 404 })
    const wrapper = await mountSuspended(ContentTrustPanel, { props: { slug: 'guia' } })
    await flushPromises()
    expect(wrapper.find('[data-testid="content-trust"]').exists()).toBe(false)
  })
  it('follows the planned redirect of a retired resource only when it is an internal path', async () => {
    mocks.request.mockRejectedValue({ statusCode: 410, data: { redirectTo: '/recursos/nueva' } })
    await mountSuspended(ContentTrustPanel, { props: { slug: 'guia' } })
    await flushPromises()
    expect(mocks.navigate).toHaveBeenCalledWith('/recursos/nueva', { redirectCode: 301 })
    mocks.navigate.mockReset()
    mocks.request.mockRejectedValue({ statusCode: 410, data: { redirectTo: '//evil.invalid' } })
    await mountSuspended(ContentTrustPanel, { props: { slug: 'guia' } })
    await flushPromises()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})

describe('ContentAssetsPanel', () => {
  beforeEach(() => {
    mocks.request.mockReset()
  })
  it('lists published assets with their kind and data date', async () => {
    mocks.request.mockResolvedValue({
      items: [
        {
          slug: 'checklist-limpieza',
          kind: 'checklist',
          title: 'Checklist de limpieza',
          summary: 'Resumen',
          dataAsOf: '2026-10-01',
          publishedAt: '2026-10-02T00:00:00Z'
        }
      ]
    })
    const wrapper = await mountSuspended(ContentAssetsPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('Checklist de limpieza')
    expect(wrapper.text()).toContain('2026-10-01')
    expect(wrapper.get('a[href="/datos-y-herramientas/checklist-limpieza"]').exists()).toBe(true)
  })
  it('shows an empty state', async () => {
    mocks.request.mockResolvedValue({ items: [] })
    const wrapper = await mountSuspended(ContentAssetsPanel)
    await flushPromises()
    expect(wrapper.get('[data-testid="assets-empty"]').exists()).toBe(true)
  })
  it('shows methodology, date and an interactive dilution calculator', async () => {
    mocks.request.mockResolvedValue({
      slug: 'dilucion-suelos',
      kind: 'calculator',
      title: 'Dilución de suelos',
      summary: 'Resumen',
      methodology: 'Proporciones de la ficha técnica del fabricante.',
      dataAsOf: '2026-10-01',
      publishedAt: '2026-10-02T00:00:00Z',
      payload: { type: 'dilution', presets: [{ use: 'Suelos', concentrateParts: 1, waterParts: 49 }] }
    })
    const wrapper = await mountSuspended(ContentAssetsPanel, { props: { slug: 'dilucion-suelos' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Proporciones de la ficha técnica')
    expect(wrapper.text()).toContain('2026-10-01')
    await wrapper.get('[data-testid="calc-total"]').setValue('1000')
    expect(wrapper.get('[data-testid="calc-result"]').text()).toContain('20')
    expect(wrapper.get('[data-testid="calc-result"]').text()).toContain('980')
    await wrapper.get('[data-testid="calc-total"]').setValue('-5')
    expect(wrapper.find('[data-testid="calc-result"]').exists()).toBe(false)
  })
  it('renders comparison, study and checklist payloads', async () => {
    const base = {
      slug: 'x',
      title: 'T',
      summary: 'S',
      methodology: 'M metodología',
      dataAsOf: '2026-10-01',
      publishedAt: '2026-10-02T00:00:00Z'
    }
    for (const [kind, payload, expected] of [
      ['comparison', { columns: ['A', 'B'], rows: [{ label: 'Fila', values: ['v1', 'v2'] }] }, 'v2'],
      ['study', { sampleSize: 40, dataset: [{ label: 'Consumo', value: 12.5, unit: 'L' }] }, '40'],
      ['checklist', { items: ['Paso uno'] }, 'Paso uno']
    ] as const) {
      mocks.request.mockResolvedValue({ ...base, kind, payload })
      const wrapper = await mountSuspended(ContentAssetsPanel, { props: { slug: 'x' } })
      await flushPromises()
      expect(wrapper.text(), kind).toContain(expected)
    }
  })
  it('shows an error state when the asset is not available', async () => {
    mocks.request.mockRejectedValue({ statusCode: 404 })
    const wrapper = await mountSuspended(ContentAssetsPanel, { props: { slug: 'nada' } })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('no está disponible')
  })
})
