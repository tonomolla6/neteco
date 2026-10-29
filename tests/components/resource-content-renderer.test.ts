import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, ref } from 'vue'
import { useRuntimeConfig } from '#imports'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ContentPage from '../../app/pages/contenido/[slug].vue'
import CmsContentBlocks from '../../app/components/CmsContentBlocks.vue'
import '#app/nuxt-vitest-app-entry'
const { fetchMock, headMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), headMock: vi.fn() }))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('useHead', () => headMock)
const ID = '10000000-0000-4000-8000-000000000001'
const image = { id: ID, type: 'image' as const, assetId: ID, alt: 'Imagen aprobada', caption: 'Pie de imagen' }
const approved = `/api/content-media/${ID}/image?w=1200&format=webp`
const editorial = {
  kind: 'article',
  category: { slug: 'limpieza', label: 'Limpieza' },
  author: { name: 'Autora sintética', experience: 'Experiencia sintética para pruebas.' },
  reviewedAt: '2026-10-01T00:00:00Z',
  reviewDueAt: '2027-10-01T00:00:00Z',
  pillarSlug: null,
  relatedProducts: [],
  relatedCategories: [],
  relatedResources: []
}
const page = (resource: boolean) => ({
  source: 'cloudflare',
  pageId: ID,
  title: 'Guía editorial',
  slug: 'guia-editorial',
  status: 'published',
  blocks: [{ id: ID, type: 'paragraph', text: 'Contenido sintético.' }],
  seo: { title: 'Guía editorial', description: 'Descripción sintética.', noindex: false },
  version: 1,
  preview: false,
  previewDevice: null,
  previewSegment: null,
  media: {},
  ...(resource ? { resourceHub: editorial } : {})
})
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
beforeEach(() => {
  headMock.mockReset()
  fetchMock.mockReset()
  const config = useRuntimeConfig()
  config.public.serverRuntime = 'cloudflare'
  config.public.baseUrl = 'https://neteco.example.invalid'
})
afterEach(() => wrapper?.unmount())
describe('shared CMS renderer and resource canonical', () => {
  it('preserves approved Cloudflare media, typed headings, captions and escaped text', async () => {
    wrapper = await mountSuspended(CmsContentBlocks, {
      props: {
        runtime: 'cloudflare',
        blocks: [
          image,
          { id: crypto.randomUUID(), type: 'heading', level: 'h2', text: 'Título tipado' },
          { id: crypto.randomUUID(), type: 'paragraph', text: '<script>no()</script>' }
        ],
        media: { [ID]: approved }
      }
    })
    expect(wrapper.get('img').attributes('src')).toBe(approved)
    expect(wrapper.get('img').attributes('referrerpolicy')).toBe('no-referrer')
    expect(wrapper.get('h2').text()).toBe('Título tipado')
    expect(wrapper.get('figcaption').text()).toBe('Pie de imagen')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain('<script>no()</script>')
  })
  it('preserves legacy Node image rendering instead of switching it to a Cloudflare API', async () => {
    const Img = defineComponent({
      props: { src: String, alt: String },
      setup: (props) => () => h('img', { src: props.src, alt: props.alt })
    })
    wrapper = await mountSuspended(CmsContentBlocks, {
      props: { runtime: 'node', blocks: [image], media: {} },
      global: { stubs: { NuxtImg: Img } }
    })
    expect(wrapper.get('img').attributes('src')).toBe(`/media/${ID}`)
  })
  it.each([true, false])(
    'uses the resource canonical only when governed resource metadata exists (%s)',
    async (resource) => {
      fetchMock.mockResolvedValue({ data: ref(page(resource)), error: ref(null) })
      wrapper = await mountSuspended(ContentPage)
      const factory = headMock.mock.calls.at(-1)![0] as () => { link: Array<{ rel: string; href: string }> }
      expect(factory().link).toEqual([
        {
          rel: 'canonical',
          href: `https://neteco.example.invalid/${resource ? 'recursos' : 'contenido'}/guia-editorial`
        }
      ])
    }
  )
})
