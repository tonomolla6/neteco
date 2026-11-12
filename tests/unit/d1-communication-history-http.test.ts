import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { communicationHistoryFixture } from './d1-communication-history-fixture'
import { handleCommunicationHistoryHttp } from '../../workers/communications/history-http'
import { communicationRetryIntentHash } from '../../shared/communication-history'
import { ORIGIN } from './d1-support-fixture'
import { testUuid } from '../support/deterministic'

describe('COM-011 private operator HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof communicationHistoryFixture>>
  beforeEach(async () => {
    f = await communicationHistoryFixture()
  })
  afterEach(() => f.sqlite.close())
  async function request(path = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return (await handleCommunicationHistoryHttp(
      new Request(ORIGIN + '/api/admin/communications/history' + path, {
        method,
        headers: {
          cookie: f.adminCookie,
          origin: ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': testUuid(),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      }),
      { ...f.deps, edgeGate: async () => 'allowed' }
    ))!
  }
  it('returns real metadata with private no-store and no-referrer', async () => {
    const response = await request()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ source: 'cloudflare', items: expect.any(Array) })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })
  it('confirms one command and manually recovers its exact hash', async () => {
    const key = testUuid(),
      response = await request('/' + encodeURIComponent(f.eventId) + '/commands', 'POST', f.input, {
        'idempotency-key': key
      })
    expect(response.status).toBe(201)
    const receipt = await response.json()
    const recovered = await request('/commands/' + key, 'GET', undefined, {
      'X-Neteco-Command-Payload-Hash': await communicationRetryIntentHash(f.eventId, f.input)
    })
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
  })
  it('denies customer and support-only access before disclosing global metadata', async () => {
    expect((await request('', 'GET', undefined, { cookie: f.customerCookie })).status).toBe(403)
    f.sqlite.exec("DELETE FROM role_permissions WHERE role_code='operator' AND permission_code='administration.manage'")
    expect((await request()).status).toBe(403)
  })
  it('requires same origin, strict inputs and bounded body without a sender', async () => {
    const path = '/' + encodeURIComponent(f.eventId) + '/commands'
    expect((await request(path, 'POST', f.input, { origin: 'https://foreign.invalid' })).status).toBe(403)
    expect((await request('?recipient=private@example.invalid')).status).toBe(422)
    expect((await request(path, 'POST', { ...f.input, reason: 'x'.repeat(17000) })).status).toBe(413)
    expect((await request('', 'DELETE')).status).toBe(405)
  })
  it('consumes noncanonical aliases with no Node fallback', async () => {
    const response = await handleCommunicationHistoryHttp(new Request(ORIGIN + '/API/admin/communications/history'), {
      ...f.deps,
      edgeGate: async () => 'allowed'
    })
    expect(response?.status).toBe(404)
  })
})
