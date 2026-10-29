import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLAIMS, supportFixture, utc } from './d1-support-fixture'

describe('D1 support macro SQL backstop', () => {
  let fixture: Awaited<ReturnType<typeof supportFixture>>
  beforeEach(async () => {
    fixture = await supportFixture()
  })
  afterEach(() => fixture.sqlite.close())

  const content = {
    title: 'Respuesta sintética',
    body: 'Revisaremos el ticket {{ticket.reference}}.',
    tone: 'Prudente, claro y sin promesas no verificadas',
    personalizations: []
  }

  function insert(
    input: {
      macroId?: string
      approved?: boolean
      omitResponse?: string
      omitReview?: string
    } = {}
  ) {
    const id = crypto.randomUUID(),
      macroId = input.macroId ?? crypto.randomUUID()
    const approved = input.approved ?? false
    const state = approved ? 'approved' : 'draft'
    const response: Record<string, unknown> = {
      source: 'cloudflare',
      commandId: id,
      macroId,
      version: approved ? 2 : 1,
      state,
      updated: true
    }
    const review: Record<string, unknown> = {
      operationalReference: 'synthetic-operation-v1',
      legalReference: 'synthetic-legal-v1',
      reviewedAt: utc(-10000),
      expiresAt: utc(86400000)
    }
    if (input.omitResponse) Reflect.deleteProperty(response, input.omitResponse)
    if (input.omitReview) Reflect.deleteProperty(review, input.omitReview)
    fixture.sqlite
      .prepare(
        `INSERT INTO support_macro_commands
      (id,macro_id,actor_id,idempotency_key,payload_hash,action,expected_version,version,state,input,snapshot,response,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        macroId,
        CLAIMS.identityId,
        crypto.randomUUID(),
        'a'.repeat(64),
        approved ? 'approve' : 'draft',
        approved ? 1 : 0,
        approved ? 2 : 1,
        state,
        JSON.stringify({ reason: 'Synthetic direct SQL schema probe' }),
        JSON.stringify({ content, review: approved ? review : null }),
        JSON.stringify(response),
        utc(0)
      )
    return macroId
  }

  it('accepts a complete draft and reviewed revision without seeding approvals', () => {
    const macroId = insert()
    insert({ macroId, approved: true })
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM support_macro_commands').get()).toEqual({ n: 2 })
  })

  it.each(['commandId', 'macroId', 'version', 'state'])(
    'rejects a missing receipt %s instead of accepting SQL NULL',
    (field) => {
      expect(() => insert({ omitResponse: field })).toThrow()
      expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM support_macro_commands').get()).toEqual({ n: 0 })
    }
  )

  it.each(['operationalReference', 'legalReference', 'reviewedAt', 'expiresAt'])(
    'rejects an incomplete approved review missing %s',
    (field) => {
      const macroId = insert()
      expect(() => insert({ macroId, approved: true, omitReview: field })).toThrow()
      expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM support_macro_commands').get()).toEqual({ n: 1 })
    }
  )
})
