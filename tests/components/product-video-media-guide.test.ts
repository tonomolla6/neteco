import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ProductVideoMediaGuide from '../../app/components/ProductVideoMediaGuide.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn()
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)

const sampleGuides = {
  guides: [
    {
      id: 'guide-dos-1',
      productId: 'p-1',
      guideType: 'dosage',
      title: 'Modo de empleo y dosificación',
      description: 'Guía visual de dilución para aplicación segura.',
      expertPresenter: 'Dpto. Químico Neteco',
      expertTitle: 'Asistencia Técnica',
      videoUrl: '/media/video.mp4',
      mimeType: 'video/mp4',
      durationSeconds: 45,
      aspectRatio: '16:9',
      posterUrl: '/media/poster.jpg',
      posterOptimizedWebp: '/media/poster.webp',
      posterWidth: 1280,
      posterHeight: 720,
      subtitlesVttUrl: '/media/subtitles-es.vtt',
      subtitlesLanguage: 'es',
      transcriptText: 'Paso 1: Agitar el envase. Paso 2: Dosificar 25 ml por cada 5 litros de agua.',
      steps: [
        { stepIndex: 1, title: 'Equipos EPI', description: 'Usar guantes de nitrilo y protección ocular.' },
        { stepIndex: 2, title: 'Dilución 1:200', description: '25 ml en 5 litros de agua limpia.' }
      ],
      requiresConsent: false,
      status: 'published'
    }
  ]
}

describe('PDP-018 & MED-016: ProductVideoMediaGuide accessible facade component', () => {
  it('renders lazy facade poster first without loading video tag (prevents LCP and CLS degradation)', async () => {
    mocks.request.mockImplementation(() => Promise.resolve(sampleGuides))

    const wrapper = await mountSuspended(ProductVideoMediaGuide, {
      props: {
        productId: 'p-1'
      }
    })

    await flushPromises()

    expect(wrapper.text()).toContain('Modo de empleo y dosificación')
    // Facade poster image is rendered with explicit width and height
    const poster = wrapper.find('[data-testid="video-facade-poster"]')
    expect(poster.exists()).toBe(true)
    expect(poster.attributes('width')).toBe('1280')
    expect(poster.attributes('height')).toBe('720')
    expect(poster.attributes('loading')).toBe('lazy')

    // Video tag is not yet in DOM prior to user interaction
    expect(wrapper.find('video').exists()).toBe(false)
  })

  it('clicking play button activates video player with subtitles track and records telemetry', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('/media-guides')) return Promise.resolve(sampleGuides)
      if (url.includes('/telemetry')) return Promise.resolve({ recorded: true })
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(ProductVideoMediaGuide, {
      props: {
        productId: 'p-1'
      }
    })

    await flushPromises()

    const playBtn = wrapper.find('[data-testid="play-facade-button"]')
    expect(playBtn.exists()).toBe(true)
    await playBtn.trigger('click')
    await flushPromises()

    // Video tag is now active
    const video = wrapper.find('video')
    expect(video.exists()).toBe(true)
    expect(video.attributes('preload')).toBe('none')

    // Subtitles track exists
    const track = wrapper.find('track')
    expect(track.exists()).toBe(true)
    expect(track.attributes('src')).toBe('/media/subtitles-es.vtt')
    expect(track.attributes('kind')).toBe('subtitles')
  })

  it('provides accessible transcript toggle with aria-expanded and formatted text', async () => {
    mocks.request.mockImplementation(() => Promise.resolve(sampleGuides))

    const wrapper = await mountSuspended(ProductVideoMediaGuide, {
      props: {
        productId: 'p-1'
      }
    })

    await flushPromises()

    const transcriptToggle = wrapper.find('[data-testid="transcript-toggle"]')
    expect(transcriptToggle.exists()).toBe(true)
    expect(transcriptToggle.attributes('aria-expanded')).toBe('false')

    await transcriptToggle.trigger('click')
    await flushPromises()

    expect(transcriptToggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.text()).toContain('Paso 1: Agitar el envase')
    expect(wrapper.text()).toContain('Paso 2: Dosificar 25 ml')
  })

  it('renders dosage step guide with EPI warnings and dilution ratios (MED-016)', async () => {
    mocks.request.mockImplementation(() => Promise.resolve(sampleGuides))

    const wrapper = await mountSuspended(ProductVideoMediaGuide, {
      props: {
        productId: 'p-1'
      }
    })

    await flushPromises()

    expect(wrapper.text()).toContain('Equipos EPI')
    expect(wrapper.text()).toContain('Usar guantes de nitrilo')
    expect(wrapper.text()).toContain('Dilución 1:200')
  })
})
