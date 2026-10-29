import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { deterministicTestData } from '../fixtures/deterministic'
import { cmsFixture } from './d1-cms-fixture'
import { handleSupportKnowledgeHttp } from '../../workers/support/knowledge-http'

describe('public support knowledge HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof cmsFixture>> & {
    deps: { database: D1Database; enabled: boolean; now: () => string }
  }
  const origin = 'https://knowledge.neteco.invalid'
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(deterministicTestData('knowledge-http', '2026-10-08T12:00:00.000Z').date())
    const fixture = await cmsFixture()
    f = { ...fixture, deps: { database: fixture.database, enabled: true, now: () => '2026-10-08T12:00:00Z' } }
    if (!f.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='support_knowledge_feedback'").get())
      f.sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0062_support_knowledge_feedback.sql', import.meta.url), 'utf8')
      )
  })
  afterEach(() => {
    f?.sqlite.close()
    vi.useRealTimers()
  })
  const dependencies = () => ({
    ...f.deps,
    origin,
    feedbackEnabled: true,
    edgeGate: vi.fn(async () => 'allowed' as const)
  })
  const request = (suffix = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    new Request(origin + '/api/support/knowledge' + suffix, {
      method,
      headers: {
        origin,
        'content-type': 'application/json',
        'idempotency-key': '10000000-0000-4000-8000-000000000062',
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  it('returns a bounded no-store public list with no previews, private state or fake populated categories', async () => {
    const response = (await handleSupportKnowledgeHttp(request(), dependencies()))!
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      source: 'cloudflare',
      items: [],
      categories: [],
      total: 0,
      page: 1,
      perPage: 10,
      feedbackEnabled: true
    })
  })
  it.each([
    '?preview=bearer',
    '?q=a&q=b',
    '?perPage=21',
    '?page=0',
    '?category=private',
    '?q=' + encodeURIComponent('a\u0000b'),
    '/%6cist',
    '/'
  ])('owns and rejects malformed query/path %s', async (suffix) =>
    expect((await handleSupportKnowledgeHttp(request(suffix), dependencies()))!.status).toBe(400)
  )
  it('does not intercept contact, tickets or another namespace', async () => {
    expect(await handleSupportKnowledgeHttp(new Request(origin + '/api/support/tickets'), dependencies())).toBeNull()
    expect(
      await handleSupportKnowledgeHttp(new Request(origin + '/api/support/knowledge-extra'), dependencies())
    ).toBeNull()
  })
  it('rejects cross-site writes before body or limiter and requires explicit known origin', async () => {
    const deps = dependencies(),
      candidate = request('/feedback', 'POST', {}, { origin: 'https://hostile.invalid' }),
      body = vi.spyOn(candidate.body!, 'getReader')
    expect((await handleSupportKnowledgeHttp(candidate, deps))!.status).toBe(403)
    expect(deps.edgeGate).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
  })
  it('fails feedback closed without abuse control and respects limiter denials', async () => {
    expect(
      (await handleSupportKnowledgeHttp(request('/feedback', 'POST', {}), { ...dependencies(), edgeGate: undefined }))!
        .status
    ).toBe(503)
    expect(
      (await handleSupportKnowledgeHttp(request('/feedback', 'POST', {}), {
        ...dependencies(),
        edgeGate: async () => 'limited'
      }))!.status
    ).toBe(429)
    expect(
      (await handleSupportKnowledgeHttp(request('/feedback', 'POST', {}), {
        ...dependencies(),
        edgeGate: async () => 'unavailable'
      }))!.status
    ).toBe(503)
  })
  it('bounds body/content type and rejects invalid command/key without storing data', async () => {
    expect(
      (await handleSupportKnowledgeHttp(
        request('/feedback', 'POST', {}, { 'content-type': 'text/plain' }),
        dependencies()
      ))!.status
    ).toBe(415)
    expect(
      (await handleSupportKnowledgeHttp(
        request('/feedback', 'POST', {}, { 'content-length': '100000' }),
        dependencies()
      ))!.status
    ).toBe(413)
    expect(
      (await handleSupportKnowledgeHttp(
        request('/feedback', 'POST', {}, { 'idempotency-key': 'invalid key' }),
        dependencies()
      ))!.status
    ).toBe(400)
    expect(
      (await handleSupportKnowledgeHttp(
        request('/feedback', 'POST', { email: 'private@example.invalid' }),
        dependencies()
      ))!.status
    ).toBe(422)
    expect(f.sqlite.prepare('SELECT count(*) n FROM support_knowledge_feedback').get()).toEqual({ n: 0 })
  })
  it('unknown receipt is 404, not a successful or fabricated vote', async () => {
    const response = (await handleSupportKnowledgeHttp(
      request('/feedback/10000000-0000-4000-8000-000000000062'),
      dependencies()
    ))!
    expect(response.status).toBe(404)
  })
})
