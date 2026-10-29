import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CmsPublicationControls from '../../app/components/CmsPublicationControls.vue'
import ContentPreviewPanel from '../../app/components/ContentPreviewPanel.vue'
import '#app/nuxt-vitest-app-entry'
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
const PAGE = '10000000-0000-4000-8000-000000000045',
  ACTOR = '20000000-0000-4000-8000-000000000045',
  OTHER = '20000000-0000-4000-8000-000000000046',
  VERSION = '30000000-0000-4000-8000-000000000045',
  RELEASE = '40000000-0000-4000-8000-000000000045'
function state(revision = 0) {
  return {
    source: 'cloudflare',
    pageId: PAGE,
    pageVersion: 1,
    draftVersionId: VERSION,
    revision,
    publication:
      revision === 0 ? null : { id: RELEASE, versionId: VERSION, slug: 'guia', publishedAt: '2026-10-03T00:00:00Z' },
    schedule: null,
    capabilities: { publish: true, withdraw: true, schedule: true, preview: false, revokePreview: true },
    previews: []
  }
}
const receipt = () => ({
  source: 'cloudflare',
  action: 'publish',
  pageId: PAGE,
  revision: 1,
  publicationId: RELEASE,
  scheduleId: null,
  previewId: null,
  url: null,
  expiresInSeconds: null,
  updated: true
})
const wrappers: Array<{ unmount: () => void }> = []
let authority: ReturnType<typeof ref<boolean>>, current: ReturnType<typeof state>
beforeEach(() => {
  authority = ref(true)
  current = state()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (_path: string, options: Record<string, unknown>) => {
    if (options.method === 'POST') {
      if (typeof options.onRequest === 'function') options.onRequest()
      current = state(1)
      return receipt()
    }
    return current
  })
})
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount()
})
async function render(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(CmsPublicationControls, {
    props: { pageId: PAGE, runtime: 'cloudflare', operatorId: ACTOR, authorize: () => authority.value, ...props }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}
async function prepare(w: Awaited<ReturnType<typeof render>>) {
  await w.get('input[maxlength="500"]').setValue('Explicit synthetic editorial approval')
  await w.get('[data-testid="cms-publish"]').trigger('click')
  await flushPromises()
}
describe('CMS explicit publication and exact ambiguity recovery', () => {
  it('reads exact private uncached state; default-disabled preview never appears', async () => {
    const w = await render()
    expect(fetchMock.mock.calls[0]).toEqual([
      `/api/admin/content/pages/${PAGE}/publication`,
      { method: 'GET', retry: 0, cache: 'no-store' }
    ])
    expect(w.text()).toContain('Sin publicación activa')
    expect(w.find('[data-testid="cms-preview"]').exists()).toBe(false)
  })
  it.each([{ runtime: 'node' }, { operatorId: 'invalid' }, { pageId: 'invalid' }, { authorize: () => false }])(
    'does not read or render private capabilities with %j',
    async (props) => {
      const w = await render(props)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(w.find('[data-testid="cms-publish"]').exists()).toBe(false)
    }
  )
  it.each([null, {}, { ...state(), source: 'node' }, { ...state(), pageId: '10000000-0000-4000-8000-000000000046' }])(
    'malformed or wrong-page read is not a blank confirmed publication %j',
    async (value) => {
      fetchMock.mockResolvedValue(value)
      const w = await render()
      expect(w.find('[data-testid="cms-publish"]').exists()).toBe(false)
      expect(w.text()).toContain('No hay estado editorial confirmado')
    }
  )
  it('prepare does not POST; explicit confirm preflights, sends retry0 and reads fresh DTO', async () => {
    const w = await render()
    await prepare(w)
    expect(fetchMock.mock.calls.filter((c) => c[1].method === 'POST')).toHaveLength(0)
    await w.get('[data-testid="cms-publication-confirm"]').trigger('click')
    await flushPromises()
    const post = fetchMock.mock.calls.find((c) => c[1].method === 'POST')
    expect(post?.[0]).toBe(`/api/admin/content/pages/${PAGE}/publish`)
    expect(post?.[1].retry).toBe(0)
    expect(JSON.parse(post?.[1].body)).toMatchObject({
      action: 'publish',
      expectedRevision: 0,
      expectedVersion: 1,
      versionId: VERSION
    })
    expect(w.text()).toContain('Operación editorial confirmada y estado vigente consultado')
    expect(w.find('[data-testid="cms-publication-confirm"]').exists()).toBe(false)
  })
  it('network ambiguity preserves original byte payload and key despite later revision', async () => {
    const w = await render()
    await prepare(w)
    let fail = true
    fetchMock.mockImplementation(async (_path: string, options: Record<string, unknown>) => {
      if (options.method === 'POST') {
        if (typeof options.onRequest === 'function') options.onRequest()
        if (fail) throw new Error('response lost')
        return receipt()
      }
      return current
    })
    await w.get('[data-testid="cms-publication-confirm"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('envío pudo guardarse')
    const first = fetchMock.mock.calls.find((c) => c[1].method === 'POST')!
    fail = false
    current = state(2)
    await w.get('[data-testid="cms-publication-confirm"]').trigger('click')
    await flushPromises()
    const posts = fetchMock.mock.calls.filter((c) => c[1].method === 'POST')
    expect(posts[1]?.[1].body).toBe(first[1].body)
    expect(posts[1]?.[1].headers['idempotency-key']).toBe(first[1].headers['idempotency-key'])
    expect(w.text()).toContain('Operación editorial confirmada')
  })
  it('temporary MFA loss suppresses reads/writes without losing pending intent', async () => {
    const w = await render()
    await prepare(w)
    authority.value = false
    await flushPromises()
    const count = fetchMock.mock.calls.length
    expect(w.get('[data-testid="cms-publication-confirm"]').attributes('disabled')).toBeDefined()
    await w.get('[data-testid="cms-publication-confirm"]').trigger('click')
    expect(fetchMock).toHaveBeenCalledTimes(count)
    authority.value = true
    await flushPromises()
    expect(w.find('[data-testid="cms-publication-confirm"]').exists()).toBe(true)
  })
  it('actor change never sends another actor original key/payload', async () => {
    const w = await render()
    await prepare(w)
    await w.setProps({ operatorId: OTHER })
    await flushPromises()
    expect(w.get('[data-testid="cms-publication-confirm"]').attributes('disabled')).toBeDefined()
    expect(fetchMock.mock.calls.filter((c) => c[1].method === 'POST')).toHaveLength(0)
  })
  it('malformed receipt keeps attempt recoverable instead of manufacturing success', async () => {
    const w = await render()
    await prepare(w)
    fetchMock.mockImplementation(async (_path: string, options: Record<string, unknown>) => {
      if (options.method === 'POST') {
        if (typeof options.onRequest === 'function') options.onRequest()
        return { ...receipt(), revision: 9 }
      }
      return current
    })
    await w.get('[data-testid="cms-publication-confirm"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('No hay confirmación')
    expect(w.find('[data-testid="cms-publication-confirm"]').exists()).toBe(true)
  })
  it('authoritative CAS rejection clears only rejected attempt and never announces success', async () => {
    const w = await render()
    await prepare(w)
    fetchMock.mockImplementation(async (_path: string, options: Record<string, unknown>) => {
      if (options.method === 'POST') {
        if (typeof options.onResponseError === 'function')
          options.onResponseError({ response: { _data: { error: { code: 'version_conflict' } } } })
        throw new Error('409')
      }
      return current
    })
    await w.get('[data-testid="cms-publication-confirm"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Solicitud rechazada')
    expect(w.find('[data-testid="cms-publication-confirm"]').exists()).toBe(false)
  })
  it('receipt acknowledged but fresh GET failed is explicitly historical, never current', async () => {
    const w = await render()
    await prepare(w)
    let posted = false
    fetchMock.mockImplementation(async (_path: string, options: Record<string, unknown>) => {
      if (options.method === 'POST') {
        posted = true
        return receipt()
      }
      if (posted) throw new Error('read unavailable')
      return current
    })
    await w.get('[data-testid="cms-publication-confirm"]').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('recibo es histórico')
    expect(w.text()).not.toContain('estado vigente consultado')
  })
})
describe('CMS real preview viewports with typed private snapshot', () => {
  it.each(['mobile', 'desktop', 'responsive'] as const)(
    'renders %s as real viewport, no iframe origin relaxation',
    async (device) => {
      fetchMock.mockResolvedValue({
        source: 'cloudflare',
        pageId: PAGE,
        title: 'Private preview',
        slug: 'guia',
        status: 'preview',
        blocks: [{ id: VERSION, type: 'paragraph', text: 'Private preview text' }],
        seo: { title: 'Preview', description: 'Private preview only', noindex: true },
        version: 1,
        preview: true,
        previewDevice: device,
        previewSegment: 'default',
        media: {}
      })
      const w = await mountSuspended(ContentPreviewPanel, { props: { url: '/contenido/guia?preview=synthetic-token' } })
      wrappers.push(w)
      await flushPromises()
      expect(w.get('[data-testid="cms-preview-viewport"]').attributes('style')).toContain(
        device === 'mobile' ? '375px' : device === 'desktop' ? '1024px' : '100%'
      )
      expect(w.find('iframe').exists()).toBe(false)
    }
  )
  it('invalid preview URL cannot dispatch external fetch or expose previous snapshot', async () => {
    const w = await mountSuspended(ContentPreviewPanel, {
      props: { url: 'https://outsider.invalid/contenido/guia?preview=secret' }
    })
    wrappers.push(w)
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(w.text()).toContain('no está confirmada')
  })
})
