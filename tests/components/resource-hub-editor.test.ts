import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CmsDraftEditor from '../../app/components/CmsDraftEditor.vue'
import { cmsPublicationFixture } from '../unit/d1-cms-publication-fixture'
import { CMS_CLAIMS, cmsUtc } from '../unit/d1-cms-fixture'
import { executeD1CmsDraftCommand, getD1CmsPage, listD1CmsPages } from '../../workers/cms/drafts'
import { readCmsPublicationState } from '../../workers/cms/publication'
import '#app/nuxt-vitest-app-entry'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('$fetch', () => request)
vi.mock('../support/d1-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/d1-sqlite')>()
  const { DatabaseSync } = await import('node:sqlite'),
    { readFile, readdir } = await import('node:fs/promises'),
    { resolve } = await import('node:path')
  return {
    ...original,
    openMigratedDatabase: async () => {
      const dir = resolve(process.cwd(), 'db/d1/migrations'),
        database = new DatabaseSync(':memory:')
      try {
        database.exec('PRAGMA foreign_keys=ON')
        const files = (await readdir(dir))
          .filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 62)
          .sort()
        if (files.length !== 62) throw Error('Fixture baseline 0062 unavailable')
        for (const file of files) database.exec(await readFile(resolve(dir, file), 'utf8'))
        return database
      } catch (error) {
        database.close()
        throw error
      }
    }
  }
})
const Button = defineComponent({
  inheritAttrs: false,
  setup:
    (_, { attrs, slots }) =>
    () =>
      h('button', { ...attrs, type: attrs.type ?? 'button' }, slots.default?.())
})
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
// A returned mock function becomes a Vitest hook cleanup and is called without
// arguments. Reset in a block so this hook returns void, never the transport.
beforeEach(() => {
  request.mockReset()
})
afterEach(() => {
  wrapper?.unmount()
})
describe('resource metadata uses canonical CMS editor', () => {
  it('saves and restores resource metadata through real CMS commands without publishing', async () => {
    const f = await cmsPublicationFixture(),
      root = '/api/admin/content/pages'
    try {
      request.mockReset()
      request.mockImplementation(
        async (path: string, options?: { method?: string; body?: string; headers?: Record<string, string> }) => {
          if (typeof path !== 'string') throw Error('CMS fixture transport requires a URL')
          if (path.endsWith('/publication')) return readCmsPublicationState(f.deps, CMS_CLAIMS, f.created.pageId)
          if (!options?.method)
            return path === root
              ? listD1CmsPages(f.database, CMS_CLAIMS)
              : getD1CmsPage(f.database, CMS_CLAIMS, f.created.pageId)
          const action = path.endsWith('/rollback')
            ? 'restore_draft'
            : options.method === 'PUT'
              ? 'update_draft'
              : 'create_draft'
          return executeD1CmsDraftCommand(
            f.database,
            CMS_CLAIMS,
            action,
            path === root ? {} : { pageId: f.created.pageId },
            JSON.parse(options.body!),
            { idempotencyKey: options.headers!['Idempotency-Key']! }
          )
        }
      )
      wrapper = await mountSuspended(CmsDraftEditor, {
        props: { runtime: 'cloudflare', operatorId: CMS_CLAIMS.identityId, authorize: () => true },
        global: { stubs: { UButton: Button, CmsEditorialCalendar: true, CmsPublicationControls: true } }
      })
      await flushPromises()
      await wrapper.get(`[data-cms-select="${f.created.pageId}"]`).trigger('click')
      await flushPromises()
      await wrapper.get('[data-cms-edit]').trigger('click')
      await wrapper.get('[data-cms-resource-enabled]').setValue(true)
      for (const [field, value] of Object.entries({
        category: 'limpieza',
        'category-label': 'Limpieza',
        author: 'Autora sintética',
        experience: 'Experiencia profesional sintética para pruebas.',
        reviewed: cmsUtc(-86400000),
        'review-due': cmsUtc(365 * 86400000)
      }))
        await wrapper.get(`[data-cms-resource-${field}]`).setValue(value)
      await wrapper.get('[data-cms-reason]').setValue('Revisión editorial sintética explícita')
      expect(wrapper.get('[data-cms-submit]').attributes('disabled')).toBeUndefined()
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      await vi.waitFor(async () =>
        expect((await getD1CmsPage(f.database, CMS_CLAIMS, f.created.pageId)).draft.document.resourceHub).toMatchObject(
          { author: { name: 'Autora sintética' }, category: { slug: 'limpieza' } }
        )
      )
      await vi.waitFor(() => expect(wrapper!.text()).toContain('Nueva versión de borrador confirmada'))
      const saved = await getD1CmsPage(f.database, CMS_CLAIMS, f.created.pageId)
      expect(saved.draft.document.resourceHub).toMatchObject({
        author: { name: 'Autora sintética' },
        category: { slug: 'limpieza' }
      })
      const metadata = saved.draft.document.resourceHub
      await wrapper.get('[data-cms-edit]').trigger('click')
      await wrapper.get('[data-cms-resource-enabled]').setValue(false)
      await wrapper.get('[data-cms-reason]').setValue('Retirar inclusión en recursos del borrador')
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      await vi.waitFor(async () =>
        expect((await getD1CmsPage(f.database, CMS_CLAIMS, f.created.pageId)).draft.version).toBe(3)
      )
      await vi.waitFor(() => expect(wrapper!.find('[data-cms-edit]').exists()).toBe(true))
      expect((await getD1CmsPage(f.database, CMS_CLAIMS, f.created.pageId)).draft.document.resourceHub).toBeUndefined()
      await wrapper.get(`[data-cms-restore="${saved.draft.id}"]`).trigger('click')
      await wrapper.get('[data-cms-reason]').setValue('Restaurar revisión editorial sintética anterior')
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      await vi.waitFor(async () =>
        expect((await getD1CmsPage(f.database, CMS_CLAIMS, f.created.pageId)).draft.version).toBe(4)
      )
      expect((await getD1CmsPage(f.database, CMS_CLAIMS, f.created.pageId)).draft.document.resourceHub).toEqual(
        metadata
      )
      expect(f.sqlite.prepare('SELECT count(*) n FROM content_publications').get()?.n).toBe(0)
      for (const call of request.mock.calls) expect(typeof call[0]).toBe('string')
      expect(
        request.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].endsWith('/publication') && call[1]?.method === 'POST'
        )
      ).toHaveLength(0)
    } finally {
      wrapper?.unmount()
      wrapper = undefined
      f.sqlite.close()
    }
  })
  it('offers author and real review metadata only within an explicit CMS draft', async () => {
    request.mockResolvedValue({
      source: 'cloudflare',
      capabilities: {
        contentRead: true,
        contentCreate: true,
        contentUpdate: true,
        contentRestore: true,
        contentArchive: true,
        contentPublish: false,
        contentPreview: false,
        contentSchedule: false
      },
      pages: [],
      pagination: { page: 1, perPage: 25, total: 0, hasMore: false }
    })
    wrapper = await mountSuspended(CmsDraftEditor, {
      props: { runtime: 'cloudflare', operatorId: '10000000-0000-4000-8000-000000000044', authorize: () => true },
      global: { stubs: { UButton: Button, CmsEditorialCalendar: true, CmsPublicationControls: true } }
    })
    await flushPromises()
    await wrapper.get('[data-cms-create]').trigger('click')
    await wrapper.get('[data-cms-resource-enabled]').setValue(true)
    for (const field of [
      'kind',
      'category',
      'category-label',
      'author',
      'experience',
      'reviewed',
      'review-due',
      'pillar',
      'products',
      'categories',
      'resources'
    ])
      expect(wrapper.find(`[data-cms-resource-${field}]`).exists()).toBe(true)
    expect(wrapper.text()).toContain('No publica ni acredita experiencia por sí solo')
    expect(request.mock.calls.every((call) => !call[1]?.method || call[1].method === 'GET')).toBe(true)
  })
})
