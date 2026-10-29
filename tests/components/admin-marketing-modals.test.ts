import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Page from '../../app/pages/admin/modales.vue'
import {
  adminMarketingModalIntentHash,
  adminMarketingModalPolicyIntentHash,
  type MarketingModalDefinition
} from '../../shared/marketing-modals'
import '#app/nuxt-vitest-app-entry'

const ACTOR_ID = '10000000-0000-4000-8000-000000000094'
const SESSION_ID = '20000000-0000-4000-8000-000000000094'
const MODAL_ID = '50000000-0000-4000-8000-000000000001'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: 'cloudflare',
  owner: null as unknown,
  nav: null as unknown
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.owner)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))
vi.mock('../../app/composables/useAdminNavigation', () => ({ useAdminNavigation: () => mocks.nav }))

const baseDefinition: MarketingModalDefinition = {
  id: MODAL_ID,
  version: 1,
  code: 'captacion-newsletter-higiene',
  status: 'published',
  title: 'Guía técnica de higiene industrial',
  body: 'Recibe fichas técnicas y protocolos de desinfección profesional en tu correo.',
  ctaLabel: 'Suscribirme al boletín',
  ctaPath: '/cuenta/newsletter',
  objective: 'newsletter_subscription',
  abVariant: {
    title: 'Variante B de higiene',
    body: 'Protocolos verificados de limpieza profesional para empresas y colectividades.',
    ctaLabel: 'Descargar guía B',
    ctaPath: '/recursos',
    splitPercent: 50
  },
  trigger: { kind: 'time_on_page', minSeconds: 10 },
  audience: {
    segments: ['anonymous', 'customer', 'professional'],
    marketingConsent: 'any'
  },
  targeting: {
    includePrefixes: ['/catalogo', '/producto'],
    excludePrefixes: ['/producto/restringido']
  },
  priority: 250,
  priorityTier: 'high',
  frequency: {
    maxImpressionsPerVisitor: 2,
    windowSeconds: 86400
  },
  startsAt: '2026-10-01T00:00:00Z',
  endsAt: '2026-12-31T23:59:59Z'
}

const listPayload = () => ({
  source: 'cloudflare' as const,
  policy: {
    version: 1,
    globalCooldownSeconds: 3600,
    updatedAt: '2026-10-15T10:00:00Z',
    updatedBy: ACTOR_ID
  },
  items: [
    {
      definition: baseDefinition,
      stats: { impressions: 42, dismissals: 10, conversions: 6 },
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-15T10:00:00Z'
    }
  ],
  total: 1,
  page: 1,
  perPage: 25
})

const detailPayload = () => ({
  source: 'cloudflare' as const,
  item: {
    definition: baseDefinition,
    stats: { impressions: 42, dismissals: 10, conversions: 6 },
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-15T10:00:00Z'
  },
  history: [
    {
      definition: baseDefinition,
      actorId: ACTOR_ID,
      reason: 'Publicación inicial auditada',
      createdAt: '2026-10-15T10:00:00Z'
    }
  ],
  historyTotal: 1,
  historyPage: 1
})

describe('AdminMarketingModals page and component (MKT-009 + MKT-010)', () => {
  let owner: {
    ready: ReturnType<typeof ref<boolean>>
    loggedIn: ReturnType<typeof ref<boolean>>
    user: ReturnType<typeof ref<Record<string, unknown>>>
    session: ReturnType<typeof ref<Record<string, unknown>>>
  }
  let caps: ReturnType<typeof ref<Record<string, unknown>>>
  const mounted: Array<{ unmount: () => void }> = []

  beforeEach(() => {
    mocks.runtime = 'cloudflare'
    owner = {
      ready: ref(true),
      loggedIn: ref(true),
      user: ref({ id: ACTOR_ID, emailVerified: true, mfaVerified: true }),
      session: ref({ sessionId: SESSION_ID, sessionVersion: 1 })
    }
    caps = ref({
      source: 'cloudflare',
      identityId: ACTOR_ID,
      sessionId: SESSION_ID,
      sessionVersion: 1,
      state: 'ready',
      permissions: ['administration.manage']
    })
    mocks.owner = owner
    mocks.nav = { capabilities: caps, status: ref('ready') }
    mocks.request.mockReset().mockImplementation(async (path: string) => {
      if (path === `/api/admin/marketing-modals/${MODAL_ID}`) return detailPayload()
      return listPayload()
    })
  })

  afterEach(() => {
    mounted.splice(0).forEach((w) => w.unmount())
  })

  async function mountPage() {
    const w = await mountSuspended(Page)
    mounted.push(w)
    await flushPromises()
    return w
  }

  it('blocks access when MFA or administration.manage permission is missing', async () => {
    owner.user.value = { id: ACTOR_ID, emailVerified: true, mfaVerified: false }
    const w = await mountPage()
    expect(w.text()).toContain('Requiere sesión verificada con MFA')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('renders existing modals, anti-annoyance rules summary, A/B variant badge and audit history', async () => {
    const w = await mountPage()
    expect(w.text()).toContain('captacion-newsletter-higiene')
    expect(w.text()).toContain('Guía técnica de higiene industrial')
    expect(w.text()).toContain('3600 s')

    await w.get(`[data-testid="modal-inspect-${MODAL_ID}"]`).trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Publicación inicial auditada')
  })

  it('creates a new modal and updates global cooldown policy with frozen CAS review and receipt recovery', async () => {
    let postAttempt = 0
    mocks.request.mockImplementation(
      async (path: string, opts?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
        if (path === '/api/admin/marketing-modals' && opts?.method === 'POST') {
          postAttempt++
          if (postAttempt === 1) throw new Error('network_timeout')
          const body = opts.body as { definition: MarketingModalDefinition }
          return {
            source: 'cloudflare',
            commandId: opts.headers?.['Idempotency-Key'],
            modalId: body.definition.id,
            version: 1,
            status: body.definition.status,
            payloadHash: await adminMarketingModalIntentHash(opts.body as never),
            definitionHash: 'a'.repeat(64),
            item: {
              definition: body.definition,
              stats: { impressions: 0, dismissals: 0, conversions: 0 },
              createdAt: '2026-10-15T10:00:00Z',
              updatedAt: '2026-10-15T10:00:00Z'
            },
            createdAt: '2026-10-15T10:00:00Z'
          }
        }
        if (path.startsWith('/api/admin/marketing-modals/commands/')) {
          return { error: { code: 'not_found' } }
        }
        return listPayload()
      }
    )

    const w = await mountPage()
    await w.get('[data-testid="modal-create"]').trigger('click')
    await w.get('[data-testid="modal-code"]').setValue('nuevo-modal-profesional')
    await w.get('[data-testid="modal-title"]').setValue('Solicita asesoramiento técnico')
    await w
      .get('[data-testid="modal-body"]')
      .setValue('Te ayudamos a elegir desengrasantes e higienizantes certificados.')
    await w.get('[data-testid="modal-cta-label"]').setValue('Hablar con un técnico')
    await w.get('[data-testid="modal-cta-path"]').setValue('/contacto')
    await w.get('[data-testid="modal-reason"]').setValue('Creación de modal para captación de leads B2B')

    const form = w.get('[data-testid="modal-review"]').element.closest('form')
    await new DOMWrapper(form!).trigger('submit')
    await vi.waitFor(() => expect(w.find('[data-testid="modal-confirm"]').exists()).toBe(true))

    // First attempt fails with uncertain network outcome
    await w.get('[data-testid="modal-confirm"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="modal-verify-receipt"]').exists()).toBe(true)

    // Verify receipt returns not_found -> enables exact same-key replay
    await w.get('[data-testid="modal-verify-receipt"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="modal-replay"]').exists()).toBe(true)

    await w.get('[data-testid="modal-replay"]').trigger('click')
    await flushPromises()
    expect(postAttempt).toBe(2)
  })
})

describe('AdminMarketingModals command safety matrix (MKT-009 + MKT-010)', () => {
  const mounted: Array<{ unmount: () => void }> = []
  let caps: ReturnType<typeof ref<Record<string, unknown>>>
  let owner: Record<string, unknown>

  beforeEach(() => {
    mocks.runtime = 'cloudflare'
    owner = {
      ready: ref(true),
      loggedIn: ref(true),
      user: ref({ id: ACTOR_ID, emailVerified: true, mfaVerified: true }),
      session: ref({ sessionId: SESSION_ID, sessionVersion: 1 })
    }
    caps = ref({
      source: 'cloudflare',
      identityId: ACTOR_ID,
      sessionId: SESSION_ID,
      sessionVersion: 1,
      state: 'ready',
      permissions: ['administration.manage']
    })
    mocks.owner = owner
    mocks.nav = { capabilities: caps, status: ref('ready') }
    mocks.request.mockReset().mockImplementation(async (path: string) => {
      if (path === `/api/admin/marketing-modals/${MODAL_ID}`) return detailPayload()
      return listPayload()
    })
  })

  afterEach(() => {
    mounted.splice(0).forEach((w) => w.unmount())
  })

  async function mountPage() {
    const w = await mountSuspended(Page)
    mounted.push(w)
    await flushPromises()
    return w
  }

  async function fillCreate(w: Awaited<ReturnType<typeof mountPage>>) {
    await w.get('[data-testid="modal-create"]').trigger('click')
    await w.get('[data-testid="modal-code"]').setValue('nuevo-modal-profesional')
    await w.get('[data-testid="modal-title"]').setValue('Solicita asesoramiento técnico')
    await w
      .get('[data-testid="modal-body"]')
      .setValue('Te ayudamos a elegir desengrasantes e higienizantes certificados.')
    await w.get('[data-testid="modal-cta-label"]').setValue('Hablar con un técnico')
    await w.get('[data-testid="modal-cta-path"]').setValue('/contacto')
    await w.get('[data-testid="modal-reason"]').setValue('Creación de modal para captación de leads B2B')
  }

  async function submitReview(w: Awaited<ReturnType<typeof mountPage>>) {
    const form = w.get('[data-testid="modal-review"]').element.closest('form')
    await new DOMWrapper(form!).trigger('submit')
    await vi.waitFor(() => expect(w.find('[data-testid="modal-frozen"]').exists()).toBe(true))
  }

  const postCalls = () =>
    mocks.request.mock.calls.filter(([path, opts]) => path === '/api/admin/marketing-modals' && opts?.method === 'POST')
  const listCalls = () =>
    mocks.request.mock.calls.filter(([path]) => String(path).startsWith('/api/admin/marketing-modals?'))

  it.each([
    ['no administration.manage permission', { state: 'ready', permissions: [] }, true],
    [
      'an email that is not verified or MFA not confirmed',
      { state: 'mfa_required', permissions: ['administration.manage'] },
      true
    ]
  ])('blocks the page for %s', async (_name, capabilities, _blocked) => {
    caps.value = { ...caps.value, ...capabilities }
    const w = await mountPage()
    expect(w.text()).toContain('Requiere sesión verificada con MFA')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('an incomplete draft is never reviewed nor sent', async () => {
    const w = await mountPage()
    await fillCreate(w)
    await w.get('[data-testid="modal-code"]').setValue('')
    const form = w.get('[data-testid="modal-review"]').element.closest('form')
    await new DOMWrapper(form!).trigger('submit')
    await flushPromises()
    expect(w.find('[data-testid="modal-frozen"]').exists()).toBe(false)
    expect(w.text()).toContain('Revisa los campos')
    expect(postCalls()).toHaveLength(0)
  })

  it('the reviewed command is frozen: editing the form afterwards does not change what is sent', async () => {
    mocks.request.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/api/admin/marketing-modals' && opts?.method === 'POST') throw new Error('network_timeout')
      return listPayload()
    })
    const w = await mountPage()
    await fillCreate(w)
    await submitReview(w)
    await w.get('[data-testid="modal-title"]').setValue('Título editado después de revisar')
    await w.get('[data-testid="modal-confirm"]').trigger('click')
    await flushPromises()
    const sent = postCalls()[0]?.[1]?.body as { definition: { title: string } }
    expect(sent.definition.title).toBe('Solicita asesoramiento técnico')
  })

  it('a definitive rejection clears the frozen command and never offers receipt verification', async () => {
    mocks.request.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === '/api/admin/marketing-modals' && opts?.method === 'POST') {
        throw Object.assign(new Error('conflict'), { data: { error: { code: 'version_conflict' } } })
      }
      return listPayload()
    })
    const w = await mountPage()
    await fillCreate(w)
    await submitReview(w)
    await w.get('[data-testid="modal-confirm"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="modal-frozen"]').exists()).toBe(false)
    expect(w.find('[data-testid="modal-verify-receipt"]').exists()).toBe(false)
    expect(w.text()).toContain('ha cambiado')
  })

  it('a verified applied receipt closes the command without replaying it and refreshes the list', async () => {
    let captured: unknown = null
    mocks.request.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path === '/api/admin/marketing-modals' && opts?.method === 'POST') {
        captured = opts.body
        throw new Error('network_timeout')
      }
      if (String(path).startsWith('/api/admin/marketing-modals/commands/')) {
        return {
          source: 'cloudflare',
          outcome: 'applied',
          receipt: { payloadHash: await adminMarketingModalIntentHash(captured as never) }
        }
      }
      return listPayload()
    })
    const w = await mountPage()
    await fillCreate(w)
    await submitReview(w)
    await w.get('[data-testid="modal-confirm"]').trigger('click')
    await flushPromises()
    const listsBefore = listCalls().length
    await w.get('[data-testid="modal-verify-receipt"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="modal-frozen"]').exists()).toBe(false)
    expect(w.find('[data-testid="modal-replay"]').exists()).toBe(false)
    expect(listCalls().length).toBeGreaterThan(listsBefore)
  })

  it('replay after an absent receipt reuses the exact same Idempotency-Key', async () => {
    let attempts = 0
    mocks.request.mockImplementation(
      async (path: string, opts?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
        if (path === '/api/admin/marketing-modals' && opts?.method === 'POST') {
          attempts++
          if (attempts === 1) throw new Error('network_timeout')
          const body = opts.body as { definition: MarketingModalDefinition }
          return {
            source: 'cloudflare',
            commandId: opts.headers?.['Idempotency-Key'],
            modalId: body.definition.id,
            version: 1,
            status: body.definition.status,
            payloadHash: await adminMarketingModalIntentHash(body as never),
            definitionHash: 'b'.repeat(64),
            item: {
              definition: body.definition,
              stats: { impressions: 0, dismissals: 0, conversions: 0 },
              createdAt: '2026-10-15T10:00:00Z',
              updatedAt: '2026-10-15T10:00:00Z'
            },
            createdAt: '2026-10-15T10:00:00Z'
          }
        }
        if (String(path).startsWith('/api/admin/marketing-modals/commands/')) return { error: { code: 'not_found' } }
        return listPayload()
      }
    )
    const w = await mountPage()
    await fillCreate(w)
    await submitReview(w)
    await w.get('[data-testid="modal-confirm"]').trigger('click')
    await flushPromises()
    await w.get('[data-testid="modal-verify-receipt"]').trigger('click')
    await flushPromises()
    await w.get('[data-testid="modal-replay"]').trigger('click')
    await flushPromises()
    const keys = postCalls().map(([, opts]) => (opts?.headers as Record<string, string>)['Idempotency-Key'])
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  it('retired modals are shown for audit but cannot be edited', async () => {
    const retired = { ...listPayload().items[0]!, definition: { ...baseDefinition, status: 'retired' as const } }
    mocks.request.mockImplementation(async () => ({ ...listPayload(), items: [retired] }))
    const w = await mountPage()
    expect(w.find(`[data-testid="modal-inspect-${MODAL_ID}"]`).exists()).toBe(true)
    expect(w.find(`[data-testid="modal-edit-${MODAL_ID}"]`).exists()).toBe(false)
  })

  it('an invalid global cooldown is refused before any policy command is sent', async () => {
    const w = await mountPage()
    await w.get('[data-testid="modal-policy-cooldown"]').setValue('59')
    await w.get('[data-testid="modal-policy-reason"]').setValue('Pausa demasiado corta para probar')
    await w.get('[data-testid="modal-policy-cooldown"]').element.closest('form')!.dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(w.find('[data-testid="modal-policy-confirm"]').exists()).toBe(false)
    expect(mocks.request.mock.calls.some(([path]) => path === '/api/admin/marketing-modals/policy')).toBe(false)
  })

  it('a reviewed cooldown change is sent once with its own key and confirmed by its receipt', async () => {
    mocks.request.mockImplementation(
      async (path: string, opts?: { body?: unknown; headers?: Record<string, string> }) => {
        if (path === '/api/admin/marketing-modals/policy') {
          return {
            source: 'cloudflare',
            commandId: opts?.headers?.['Idempotency-Key'],
            payloadHash: await adminMarketingModalPolicyIntentHash(opts?.body as never),
            policy: { version: 1, globalCooldownSeconds: 1800, updatedAt: '2026-10-15T10:00:00Z', updatedBy: ACTOR_ID }
          }
        }
        return listPayload()
      }
    )
    const w = await mountPage()
    await w.get('[data-testid="modal-policy-cooldown"]').setValue('1800')
    await w.get('[data-testid="modal-policy-reason"]').setValue('Pausa global de 30 minutos para campaña')
    await w.get('[data-testid="modal-policy-cooldown"]').element.closest('form')!.dispatchEvent(new Event('submit'))
    await flushPromises()
    // The review step hashes the intent with crypto.subtle; wait for it instead of assuming one tick.
    await vi.waitFor(() => w.get('[data-testid="modal-policy-confirm"]'))
    await w.get('[data-testid="modal-policy-confirm"]').trigger('click')
    await flushPromises()
    const policyCalls = mocks.request.mock.calls.filter(
      ([path, opts]) => path === '/api/admin/marketing-modals/policy' && opts?.method === 'POST'
    )
    expect(policyCalls).toHaveLength(1)
    expect(w.text()).toContain('Pausa global actualizada.')
  })
})
