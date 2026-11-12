import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MarketingModalHost from '../../app/components/MarketingModalHost.vue'
import '#app/nuxt-vitest-app-entry'
import { testUuid } from '../support/deterministic'

const MODAL_ID = '50000000-0000-4000-8000-000000000001'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: 'cloudflare',
  route: { path: '/catalogo', query: {} as Record<string, string> },
  consent: { value: null as { analytics: boolean; marketing: boolean } | null }
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime, appEnv: 'test' }
}))
mockNuxtImport('useRoute', () => () => mocks.route)
mockNuxtImport('useConsent', () => () => ({
  preferences: mocks.consent
}))

function eligiblePayload(overrides: Record<string, unknown> = {}) {
  return {
    source: 'cloudflare' as const,
    eligible: true,
    reason: 'eligible' as const,
    globalCooldownSeconds: 3600,
    evaluatedAt: '2026-10-15T10:00:00Z',
    modal: {
      id: MODAL_ID,
      code: 'guia-desinfeccion-hosteleria',
      version: 1,
      title: 'Protocolos de higiene para hostelería',
      body: 'Descarga la guía de dosificación segura para desengrasantes y desinfectantes.',
      ctaLabel: 'Ver guía profesional',
      ctaPath: '/recursos',
      objective: 'newsletter_subscription' as const,
      variant: 'A' as const,
      priority: 200,
      priorityTier: 'normal' as const,
      triggerKind: 'time_on_page' as const,
      presentation: {
        layout: 'centered_dialog' as const,
        maxViewportHeightPercent: 80 as const,
        reducedMotion: false,
        closePersistent: true as const
      },
      ...overrides
    }
  }
}

describe('MarketingModalHost client component (MKT-009 + MKT-010)', () => {
  const mounted: Array<{ unmount: () => void }> = []

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.runtime = 'cloudflare'
    mocks.route.path = '/catalogo'
    mocks.consent.value = { analytics: false, marketing: true }
    window.localStorage.clear()
    window.sessionStorage.clear()
    mocks.request.mockReset()
  })

  afterEach(() => {
    mounted.splice(0).forEach((w) => w.unmount())
    vi.useRealTimers()
  })

  it('never requests or renders modals on prohibited routes or during the first 5 seconds on load', async () => {
    mocks.route.path = '/checkout'
    mocks.request.mockResolvedValue(eligiblePayload())

    const w = await mountSuspended(MarketingModalHost)
    mounted.push(w)
    await vi.advanceTimersByTimeAsync(10_000)
    await flushPromises()

    expect(w.find('[role="dialog"]').exists()).toBe(false)
    expect(mocks.request).not.toHaveBeenCalled()

    // On an allowed route, still does not open before 5 seconds
    w.unmount()
    mocks.route.path = '/catalogo'
    const w2 = await mountSuspended(MarketingModalHost)
    mounted.push(w2)
    await vi.advanceTimersByTimeAsync(4_000)
    await flushPromises()
    expect(w2.find('[role="dialog"]').exists()).toBe(false)
  })

  it('renders accessible dialog after 5s, traps focus with Tab/Shift+Tab, closes on Escape, restores focus and persists dismissal', async () => {
    const triggerBtn = document.createElement('button')
    triggerBtn.textContent = 'Elemento previo'
    document.body.appendChild(triggerBtn)
    triggerBtn.focus()

    mocks.request.mockImplementation(async (url: string) => {
      if (url === '/api/marketing/modals/eligibility') return eligiblePayload()
      return {
        source: 'cloudflare',
        eventId: testUuid(),
        recorded: false,
        persisted: 'browser_only',
        replayed: false
      }
    })

    const w = await mountSuspended(MarketingModalHost, { attachTo: document.body })
    mounted.push(w)

    await vi.advanceTimersByTimeAsync(5_500)
    await flushPromises()

    const dialog = w.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(dialog.attributes('aria-labelledby')).toBeTruthy()
    expect(dialog.attributes('aria-describedby')).toBeTruthy()
    expect(dialog.text()).toContain('Protocolos de higiene para hostelería')

    const closeBtn = w.get('[data-testid="marketing-modal-close"]')
    const ctaLink = w.get('[data-testid="marketing-modal-cta"]')
    expect(closeBtn.isVisible()).toBe(true)

    // Focus trap: Shift+Tab on first focusable wraps to last; Tab on last wraps to first
    ;(closeBtn.element as HTMLElement).focus()
    await dialog.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(ctaLink.element)

    await dialog.trigger('keydown', { key: 'Tab', shiftKey: false })
    expect(document.activeElement).toBe(closeBtn.element)

    // Escape closes the modal and restores focus to triggerBtn
    await dialog.trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(w.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(triggerBtn)

    // Dismissal is persisted in browser localStorage with cooldown
    const stored = JSON.parse(window.localStorage.getItem('neteco-marketing-modals-v1') ?? '{}')
    expect(stored.dismissedModalIds).toContain(MODAL_ID)
    expect(stored.lastDismissedAt).toBeTruthy()

    triggerBtn.remove()
  })

  it('renders mobile-safe bottom sheet (max 50% viewport) and respects prefers-reduced-motion', async () => {
    mocks.consent.value = { analytics: true, marketing: true }
    mocks.request.mockImplementation(async (url: string) => {
      if (url === '/api/marketing/modals/eligibility') {
        return eligiblePayload({
          presentation: {
            layout: 'bottom_sheet',
            maxViewportHeightPercent: 50,
            reducedMotion: true,
            closePersistent: true
          }
        })
      }
      return {
        source: 'cloudflare',
        eventId: testUuid(),
        recorded: true,
        persisted: 'server_d1',
        replayed: false
      }
    })

    const w = await mountSuspended(MarketingModalHost, {
      props: { forceViewport: 'mobile', forceReducedMotion: true }
    })
    mounted.push(w)

    await vi.advanceTimersByTimeAsync(5_500)
    await flushPromises()

    const dialog = w.get('[role="dialog"]')
    expect(dialog.attributes('data-layout')).toBe('bottom_sheet')
    expect(dialog.attributes('data-max-viewport-percent')).toBe('50')
    expect(dialog.attributes('data-reduced-motion')).toBe('true')
    expect(dialog.classes()).toContain('max-h-[50vh]')
    expect(dialog.classes()).toContain('transition-none')
  })

  it('records conversion permanently when clicking the CTA and blocks subsequent modals with the same objective', async () => {
    mocks.consent.value = { analytics: true, marketing: true }
    mocks.request.mockImplementation(async (url: string) => {
      if (url === '/api/marketing/modals/eligibility') return eligiblePayload()
      return {
        source: 'cloudflare',
        eventId: testUuid(),
        recorded: true,
        persisted: 'server_d1',
        replayed: false
      }
    })

    const w = await mountSuspended(MarketingModalHost)
    mounted.push(w)

    await vi.advanceTimersByTimeAsync(5_500)
    await flushPromises()

    await w.get('[data-testid="marketing-modal-cta"]').trigger('click')
    await flushPromises()

    expect(w.find('[role="dialog"]').exists()).toBe(false)
    const stored = JSON.parse(window.localStorage.getItem('neteco-marketing-modals-v1') ?? '{}')
    expect(stored.convertedModalIds).toContain(MODAL_ID)
    expect(stored.convertedObjectives).toContain('newsletter_subscription')

    const eventCalls = mocks.request.mock.calls.filter(([url]) => url === '/api/marketing/modals/events')
    expect(eventCalls.some(([, opts]) => opts?.body?.eventType === 'convert')).toBe(true)
  })
})

const ELIGIBILITY = '/api/marketing/modals/eligibility'
const EVENTS = '/api/marketing/modals/events'
const STORAGE = 'neteco-marketing-modals-v1'

describe('MarketingModalHost guards, persistence and accessibility matrix (MKT-009 + MKT-010)', () => {
  const mounted: Array<{ unmount: () => void }> = []

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.runtime = 'cloudflare'
    mocks.route.path = '/catalogo'
    mocks.consent.value = { analytics: false, marketing: true }
    window.localStorage.clear()
    window.sessionStorage.clear()
    mocks.request.mockReset()
  })

  afterEach(() => {
    mounted.splice(0).forEach((w) => w.unmount())
    vi.useRealTimers()
  })

  async function mountHost(options: Record<string, unknown> = {}) {
    const w = await mountSuspended(MarketingModalHost, options)
    mounted.push(w)
    return w
  }

  const eligibleAnswers = () => {
    mocks.request.mockImplementation(async (url: string) => {
      if (url === ELIGIBILITY) return eligiblePayload()
      return {
        source: 'cloudflare',
        eventId: testUuid(),
        recorded: false,
        persisted: 'browser_only',
        replayed: false
      }
    })
  }

  it.each(['/carrito', '/checkout/confirmacion', '/cuenta/seguridad', '/privacidad', '/login', '/admin/modales'])(
    'never asks the server on prohibited route %s, even after a minute',
    async (path) => {
      mocks.route.path = path
      eligibleAnswers()
      await mountHost()
      await vi.advanceTimersByTimeAsync(60_000)
      await flushPromises()
      expect(mocks.request).not.toHaveBeenCalled()
    }
  )

  it('does nothing outside the cloudflare runtime', async () => {
    mocks.runtime = 'local'
    eligibleAnswers()
    await mountHost()
    await vi.advanceTimersByTimeAsync(20_000)
    await flushPromises()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('makes the first decision at exactly 5 s, never before', async () => {
    eligibleAnswers()
    const w = await mountHost()
    await vi.advanceTimersByTimeAsync(4_999)
    await flushPromises()
    expect(mocks.request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(w.find('[role="dialog"]').exists()).toBe(true)
  })

  it.each([
    [
      'a non-eligible answer',
      {
        source: 'cloudflare',
        eligible: false,
        reason: 'frequency_cap_reached',
        globalCooldownSeconds: 3600,
        modal: null,
        evaluatedAt: '2026-10-15T10:00:00Z'
      }
    ],
    ['a malformed answer', { unexpected: true }],
    ['a network failure', 'reject']
  ])('shows nothing for %s', async (_name, answer) => {
    mocks.request.mockImplementation(async () => {
      if (answer === 'reject') throw new Error('network')
      return answer
    })
    const w = await mountHost()
    await vi.advanceTimersByTimeAsync(5_500)
    await flushPromises()
    expect(w.find('[role="dialog"]').exists()).toBe(false)
  })

  it('exposes a labelled, described dialog with a visible close control and desktop geometry', async () => {
    eligibleAnswers()
    const w = await mountHost({ attachTo: document.body })
    await vi.advanceTimersByTimeAsync(5_500)
    await flushPromises()
    const dialog = w.get('[role="dialog"]')
    const labelledBy = dialog.attributes('aria-labelledby') ?? ''
    const describedBy = dialog.attributes('aria-describedby') ?? ''
    expect(document.getElementById(labelledBy)?.textContent).toContain('Protocolos de higiene para hostelería')
    expect(document.getElementById(describedBy)?.textContent).toContain('guía de dosificación')
    expect(w.get('[data-testid="marketing-modal-close"]').text()).toBe('Cerrar')
    expect(w.get('[data-testid="marketing-modal-close"]').isVisible()).toBe(true)
    expect(dialog.attributes('data-layout')).toBe('centered_dialog')
    expect(dialog.attributes('data-max-viewport-percent')).toBe('80')
    expect(dialog.classes()).toContain('max-h-[80vh]')
    expect(dialog.classes()).toContain('transition-transform')
    expect(dialog.classes()).not.toContain('transition-none')
  })

  it('keeps keyboard focus inside the dialog when something outside receives focus', async () => {
    eligibleAnswers()
    const outside = document.createElement('button')
    outside.textContent = 'Fuera'
    document.body.appendChild(outside)
    const w = await mountHost({ attachTo: document.body })
    await vi.advanceTimersByTimeAsync(5_500)
    await flushPromises()
    outside.focus()
    await flushPromises()
    const dialog = w.get('[role="dialog"]').element
    expect(dialog.contains(document.activeElement)).toBe(true)
    outside.remove()
  })

  it('returns focus to the previous element when closed with the close button', async () => {
    eligibleAnswers()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const w = await mountHost({ attachTo: document.body })
    await vi.advanceTimersByTimeAsync(5_500)
    await flushPromises()
    await w.get('[data-testid="marketing-modal-close"]').trigger('click')
    await flushPromises()
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('persists one impression and one dismissal locally, then asks no more on the same page view', async () => {
    eligibleAnswers()
    const w = await mountHost({ attachTo: document.body })
    await vi.advanceTimersByTimeAsync(5_500)
    await flushPromises()
    await w.get('[data-testid="marketing-modal-close"]').trigger('click')
    await flushPromises()
    const stored = JSON.parse(window.localStorage.getItem(STORAGE) ?? '{}')
    expect(stored.impressionsByModal[MODAL_ID]).toHaveLength(1)
    expect(stored.dismissedModalIds).toEqual([MODAL_ID])
    const asked = mocks.request.mock.calls.filter(([url]) => url === ELIGIBILITY).length
    await vi.advanceTimersByTimeAsync(300_000)
    await flushPromises()
    expect(mocks.request.mock.calls.filter(([url]) => url === ELIGIBILITY).length).toBe(asked)
  })

  it('keeps one A/B seed per browser: the same seed is sent on every evaluation', async () => {
    eligibleAnswers()
    await mountHost()
    await vi.advanceTimersByTimeAsync(5_500)
    await flushPromises()
    const stored = JSON.parse(window.localStorage.getItem(STORAGE) ?? '{}')
    const sent = mocks.request.mock.calls.find(([url]) => url === ELIGIBILITY)?.[1]?.body
    expect(stored.variantSeed).toMatch(/^[A-Za-z0-9._:-]{8,120}$/)
    expect(sent.variantSeed).toBe(stored.variantSeed)
  })

  it.each([
    [false, 0],
    [true, 2]
  ])(
    'sends impression and dismissal events only with analytical consent (analytics=%s -> %s events)',
    async (analytics, count) => {
      mocks.consent.value = { analytics, marketing: true }
      eligibleAnswers()
      const w = await mountHost({ attachTo: document.body })
      await vi.advanceTimersByTimeAsync(5_500)
      await flushPromises()
      await w.get('[data-testid="marketing-modal-close"]').trigger('click')
      await flushPromises()
      expect(mocks.request.mock.calls.filter(([url]) => url === EVENTS)).toHaveLength(count)
    }
  )

  it('sends the server the dismissal state it needs for cooldown and permanent exclusion', async () => {
    eligibleAnswers()
    const w = await mountHost({ attachTo: document.body })
    await vi.advanceTimersByTimeAsync(5_500)
    await flushPromises()
    await w.get('[data-testid="marketing-modal-close"]').trigger('click')
    await flushPromises()
    const stored = JSON.parse(window.localStorage.getItem(STORAGE) ?? '{}')
    const first = mocks.request.mock.calls.find(([url]) => url === ELIGIBILITY)?.[1]?.body
    expect(first.dismissedModalIds).toEqual([])
    expect(first.lastDismissedAt).toBeNull()
    expect(stored.lastDismissedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })
})
