import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CmsEditorialCalendar from '../../app/components/CmsEditorialCalendar.vue'
import { cmsCalendarLocalTime, cmsCalendarRange } from '../../shared/cms-calendar'
import { madridDateKey } from '../../server/utils/madrid-calendar'
import '#app/nuxt-vitest-app-entry'
import { testNow } from '../support/deterministic'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
const ACTOR = '10000000-0000-4000-8000-000000000051',
  PAGE = '20000000-0000-4000-8000-000000000051',
  VERSION = '30000000-0000-4000-8000-000000000051',
  AS_OF = '2026-10-03T12:00:00Z'
function event(at: string, index = 0) {
  return {
    scheduleId: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    pageId: PAGE,
    versionId: VERSION,
    version: 1,
    title: 'Guía editorial aprobada',
    slug: 'guia-aprobada',
    phase: 'publish' as const,
    scheduledAt: at,
    ...cmsCalendarLocalTime(at),
    status: at <= AS_OF ? ('due' as const) : ('scheduled' as const),
    active: true,
    code: null as string | null,
    recordedAt: null as string | null
  }
}
function calendar(month: string, page = 1, total = 1) {
  const range = cmsCalendarRange(month),
    all = Array.from({ length: total }, (_, index) => event(`${month}-20T08:00:00Z`, index))
  return {
    source: 'cloudflare',
    timeZone: 'Europe/Madrid',
    month,
    rangeStart: range.start,
    rangeEnd: range.end,
    asOf: AS_OF,
    events: all.slice((page - 1) * 25, page * 25),
    pagination: { page, perPage: 25, total, hasMore: page * 25 < total },
    alerts: {
      blockedCount: 0,
      dueCount: all.filter((item) => item.status === 'due').length,
      blockedEvents: [] as ReturnType<typeof event>[],
      hasMore: false
    }
  }
}
const wrappers: Array<{ unmount(): void }> = []
let authority: ReturnType<typeof ref<boolean>>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(testNow())
  authority = ref(true)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (_path: string, options: { query: { month: string; page: number } }) =>
    calendar(options.query.month, options.query.page)
  )
})
afterEach(() => {
  vi.useRealTimers()
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
})
async function render(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(CmsEditorialCalendar, {
    props: { runtime: 'cloudflare', operatorId: ACTOR, authorize: () => authority.value, enabled: true, ...props }
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('CMS editorial calendar actual Nuxt component', () => {
  it('uses a private retry0 GET only and renders Madrid month with labelled controls', async () => {
    const wrapper = await render(),
      month = madridDateKey(new Date(testNow())).slice(0, 7)
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/admin/content/calendar',
      { method: 'GET', query: { month, page: 1, perPage: 25 }, retry: 0, cache: 'no-store' }
    ])
    expect(wrapper.text()).toContain('Europe/Madrid')
    expect(wrapper.get('label').attributes('for')).toBe(wrapper.get('input[type="month"]').attributes('id'))
    expect(wrapper.find(`[data-cms-calendar-day="${month}-20"]`).text()).toContain('Guía editorial aprobada')
    expect(wrapper.get('[role="region"]').attributes('tabindex')).toBe('0')
    expect(fetchMock.mock.calls.every((call) => call[1].method === 'GET')).toBe(true)
  })
  it.each([
    { enabled: false },
    { runtime: 'node' },
    { operatorId: 'invalid' },
    { authorize: () => false },
    {
      authorize: () => {
        throw new Error('session unavailable')
      }
    }
  ])('rejects absent authority/configuration without a read %j', async (props) => {
    const wrapper = await render(props)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(wrapper.find('[data-cms-calendar-page]').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })
  it.each([null, {}, 'legacy calendar', { source: 'node' }])(
    'malformed DTO is not a confirmed empty month %j',
    async (raw) => {
      fetchMock.mockResolvedValue(raw)
      const wrapper = await render()
      expect(wrapper.text()).toContain('No hay un calendario confirmado')
      expect(wrapper.text()).not.toContain('No hay operaciones programadas')
      expect(wrapper.find('[data-cms-calendar-page]').exists()).toBe(false)
    }
  )
  it('unknown source and another month cannot supply private confirmed events', async () => {
    fetchMock.mockResolvedValue(calendar('2025-01'))
    const wrapper = await render()
    expect(wrapper.text()).toContain('No hay un calendario confirmado')
    expect(wrapper.text()).not.toContain('Guía editorial aprobada')
  })
  it('true empty calendar remains confirmed, but outage refresh removes stale data instead of asserting empty', async () => {
    fetchMock.mockImplementation(async (_path, options) => calendar(options.query.month, 1, 0))
    const wrapper = await render()
    expect(wrapper.text()).toContain('No hay operaciones programadas en este mes')
    fetchMock.mockRejectedValue(new Error('database unavailable SQL private'))
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('No hay un calendario confirmado')
    expect(wrapper.text()).not.toContain('No hay operaciones programadas')
    expect(wrapper.text()).not.toContain('SQL')
  })
  it('current blocked alert in a different month stays visible and can open that page, never runs a task', async () => {
    const failure = {
      ...event('2026-09-01T00:00:00Z'),
      status: 'blocked' as const,
      code: 'media_blocked',
      recordedAt: '2026-09-01T00:01:00Z'
    }
    fetchMock.mockImplementation(async (_path, options) => {
      const result = calendar(options.query.month)
      return { ...result, alerts: { blockedCount: 1, dueCount: 2, blockedEvents: [failure], hasMore: false } }
    })
    const wrapper = await render()
    expect(wrapper.get('[data-cms-calendar-failures]').text()).toContain('2026-09-01')
    expect(wrapper.text()).toContain('Todavía no tienen un resultado registrado')
    await wrapper.get('[data-cms-calendar-alert-page]').trigger('click')
    expect(wrapper.emitted('selectPage')).toEqual([[PAGE]])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('shows both repeated Madrid times with unambiguous UTC offsets', async () => {
    // The events are in the October DST change; pin only Date so the requested month is October.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(AS_OF))
    fetchMock.mockImplementation(async (_path, options) => {
      const result = calendar(options.query.month, 1, 2)
      return { ...result, events: [event('2026-10-25T00:30:00Z', 0), event('2026-10-25T01:30:00Z', 1)] }
    })
    const wrapper = await render()
    expect(wrapper.text()).toContain('02:30 (UTC+02:00)')
    expect(wrapper.text()).toContain('02:30 (UTC+01:00)')
  })
  it('pagination is explicit and warns that empty cells may have events on another page', async () => {
    fetchMock.mockImplementation(async (_path, options) => calendar(options.query.month, options.query.page, 27))
    const wrapper = await render()
    expect(wrapper.text()).toContain('Un día vacío puede tener operaciones en otras páginas')
    expect(wrapper.findAll('[data-cms-calendar-page]')).toHaveLength(25)
    await wrapper.get('[data-cms-calendar-next-page]').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls.at(-1)?.[1].query.page).toBe(2)
    expect(wrapper.findAll('[data-cms-calendar-page]')).toHaveLength(2)
    expect(wrapper.get('[data-cms-calendar-next-page]').attributes('disabled')).toBeDefined()
  })
  it('changing month performs only an explicit uncached read and accepts the exact requested month', async () => {
    const wrapper = await render()
    await wrapper.get('input[type="month"]').setValue('2026-11')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(fetchMock.mock.calls.at(-1)?.[1].query).toEqual({ month: '2026-11', page: 1, perPage: 25 })
    expect(wrapper.text()).toContain('noviembre de 2026')
    expect(fetchMock.mock.calls.every((call) => call[1].method === 'GET')).toBe(true)
  })
  it('does not navigate away when parent has an unsaved or ambiguous command', async () => {
    const wrapper = await render({ canSelect: false })
    expect(wrapper.get('[data-cms-calendar-page]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-cms-calendar-page]').trigger('click')
    expect(wrapper.emitted('selectPage')).toBeUndefined()
  })
  it('authority loss clears confirmed events immediately and delayed reads cannot repopulate them', async () => {
    let release!: (value: unknown) => void
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const wrapper = await render()
    authority.value = false
    await flushPromises()
    release(calendar(madridDateKey(new Date(testNow())).slice(0, 7)))
    await flushPromises()
    expect(wrapper.text()).not.toContain('Guía editorial aprobada')
    expect(wrapper.find('[data-cms-calendar-page]').exists()).toBe(false)
    authority.value = true
    await flushPromises()
    expect(wrapper.text()).toContain('No hay un calendario confirmado')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('actor/runtime change or unmount suppresses stale private responses', async () => {
    let release!: (value: unknown) => void
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const wrapper = await render()
    await wrapper.setProps({ operatorId: '10000000-0000-4000-8000-000000000052', runtime: 'node' })
    release(calendar(madridDateKey(new Date(testNow())).slice(0, 7)))
    await flushPromises()
    expect(wrapper.text()).not.toContain('Guía editorial aprobada')
    expect(wrapper.find('[data-cms-calendar-page]').exists()).toBe(false)
  })
})
