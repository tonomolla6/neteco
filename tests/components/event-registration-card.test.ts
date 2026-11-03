import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import EventRegistrationCard from '../../app/components/events/EventRegistrationCard.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: 'cloudflare'
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))

const sampleEvent = {
  id: 'e0000000-0000-4000-8000-000000000001',
  slug: 'webinar-quimica-sostenible',
  title: 'Protocolos de Dilución y Seguridad Química',
  description: 'Aprende a dosificar con seguridad según normativa vigente.',
  type: 'webinar' as const,
  sector: 'hosteleria' as const,
  locationType: 'online' as const,
  locationDetails: 'https://conferencias.neteco.test/quimica',
  scheduledAt: '2026-11-15T10:00:00Z',
  durationMinutes: 45,
  maxAttendees: 50,
  currentAttendeesCount: 12,
  status: 'scheduled' as const,
  recordingUrl: null,
  subtitlesUrl: null,
  recordingDurationSeconds: null,
  recordingPublishedAt: null,
  version: 1,
  createdAt: '2026-10-29T12:00:00Z',
  updatedAt: '2026-10-29T12:00:00Z'
}

describe('EventRegistrationCard Component (MKT-030)', () => {
  beforeEach(() => {
    mocks.request.mockReset()
  })

  it('renders event details, capacity, and channel-specific consent checkboxes', async () => {
    const wrapper = await mountSuspended(EventRegistrationCard, {
      props: {
        event: sampleEvent
      }
    })

    await flushPromises()

    expect(wrapper.text()).toContain('Protocolos de Dilución y Seguridad Química')
    expect(wrapper.text()).toContain('12 / 50 plazas')
    expect(wrapper.text()).toContain('Recordatorio por email')
    expect(wrapper.text()).toContain('Recordatorio por SMS')
    expect(wrapper.text()).toContain('Material y seguimiento post-evento')

    expect(wrapper.find('input[data-testid="consent-email"]').exists()).toBe(true)
    expect(wrapper.find('input[data-testid="consent-sms"]').exists()).toBe(true)
    expect(wrapper.find('input[data-testid="consent-followup"]').exists()).toBe(true)
  })

  it('sends client idempotency keys and reuses them when retrying a failed registration (SECFIX-3 #13)', async () => {
    mocks.request.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (options?.method === 'POST' && url.endsWith('/register')) throw new Error('network')
      return { questions: [] }
    })
    const wrapper = await mountSuspended(EventRegistrationCard, { props: { event: sampleEvent } })
    await flushPromises()
    const form = wrapper.findAll('form')[0]!
    await form.trigger('submit')
    await flushPromises()
    await form.trigger('submit')
    await flushPromises()
    const posts = mocks.request.mock.calls.filter(
      ([url, options]) => String(url).endsWith('/register') && options?.method === 'POST'
    )
    expect(posts).toHaveLength(2)
    const first = posts[0]![1].body as { commandId?: string; idempotencyKey?: string }
    const second = posts[1]![1].body as { commandId?: string; idempotencyKey?: string }
    expect(first.commandId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.idempotencyKey).toBeTruthy()
    expect(second.commandId).toBe(first.commandId)
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
  })

  it('shows recording player and subtitles link for completed events', async () => {
    const completedEvent = {
      ...sampleEvent,
      status: 'completed' as const,
      recordingUrl: 'https://media.neteco.test/recordings/webinar-1.mp4',
      subtitlesUrl: 'https://media.neteco.test/subtitles/webinar-1.vtt'
    }

    const wrapper = await mountSuspended(EventRegistrationCard, {
      props: {
        event: completedEvent
      }
    })

    await flushPromises()

    expect(wrapper.text()).toContain('Grabación disponible')
    expect(wrapper.find('a[data-testid="subtitles-link"]').exists()).toBe(true)
    expect(wrapper.find('video').exists()).toBe(true)
  })
})
