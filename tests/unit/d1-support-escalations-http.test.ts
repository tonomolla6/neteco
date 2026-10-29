import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { supportFixture, ORIGIN } from './d1-support-fixture'
import { handleSupportEscalationsHttp } from '../../workers/support/escalations-http'

describe('SUP-006 private HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  beforeEach(async () => {
    f = await supportFixture()
    f.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0079_support_escalations.sql', import.meta.url), 'utf8')
    )
  })
  afterEach(() => f.sqlite.close())
  async function request(
    path: string,
    options: {
      cookie?: string
      method?: string
      body?: unknown
      origin?: string
      headers?: Record<string, string>
    } = {}
  ) {
    const req = new Request(ORIGIN + path, {
      method: options.method ?? 'GET',
      headers: {
        cookie: options.cookie ?? f.adminCookie,
        origin: options.origin ?? ORIGIN,
        ...(options.body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }),
        ...options.headers
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    })
    return (await handleSupportEscalationsHttp(req, f.deps)) ?? f.dispatch(req)
  }
  it('lists an explicit empty internal queue without writing domain state', async () => {
    const before = f.economic(),
      response = await request('/api/admin/support/escalations?owner=me&perPage=25')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ source: 'cloudflare', items: [], total: 0 })
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(f.economic()).toEqual(before)
  })
  it('returns the current authorized ticket version without customer PII', async () => {
    const ticket = await f.ticket(),
      response = await request('/api/admin/support/' + ticket.publicRef + '/escalation')
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      source: 'cloudflare',
      publicRef: ticket.publicRef,
      ticketVersion: ticket.version,
      escalation: null
    })
    expect(JSON.stringify(result)).not.toContain('buyer@example.invalid')
  })
  it('denies a customer before internal queue or runbook disclosure', async () => {
    expect((await request('/api/admin/support/escalations', { cookie: f.customerCookie })).status).toBe(403)
    expect((await request('/api/admin/support/escalations/runbooks', { cookie: f.customerCookie })).status).toBe(403)
  })
  it('owns aliases and rejects them without falling through to Node', async () => {
    for (const path of [
      '/API/admin/support/escalations',
      '/api/admin/support/%65scalations',
      '/api/admin/support/escalations/'
    ])
      expect((await request(path)).status).toBe(404)
  })
  it('requires same origin, strict query, bounded body and known verbs', async () => {
    expect(
      (
        await request('/api/admin/support/escalations/runbooks/' + crypto.randomUUID() + '/commands', {
          method: 'POST',
          body: {},
          origin: 'https://foreign.invalid'
        })
      ).status
    ).toBe(403)
    expect((await request('/api/admin/support/escalations?owner=invalid')).status).toBe(422)
    expect((await request('/api/admin/support/escalations', { method: 'DELETE' })).status).toBe(405)
    expect(
      (
        await request('/api/admin/support/escalations/runbooks/' + crypto.randomUUID() + '/commands', {
          method: 'POST',
          body: { value: 'x'.repeat(17000) }
        })
      ).status
    ).toBe(413)
  })
})
