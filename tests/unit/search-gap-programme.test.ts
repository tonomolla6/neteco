import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  CATEGORY_CLAIMS,
  CATEGORY_IDENTITY,
  categoryCommandFixture,
  ROOT_CATEGORY
} from '../support/category-command-fixture'
import { MIN_SEARCH_SAMPLE_THRESHOLD } from '../../workers/analytics/search-analytics'
import { createSearchSynonymPreview, executeSearchSynonymCommand } from '../../workers/catalog/search-synonyms'
import { executeSearchMerchandisingCommand } from '../../workers/catalog/search-merchandising'
import { SEARCH_GAP_MIN_SEARCHES, judgeSearchGap, searchGapCommandSchema } from '../../shared/search-gap-programme'
import {
  SearchGapError,
  executeSearchGapCommand,
  listSearchGapBacklog,
  listSearchGapCases,
  measureSearchGapCase
} from '../../workers/catalog/search-gap-programme'

const DAY = 86_400_000
const iso = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
const day = (offsetDays: number) => iso(offsetDays * DAY).slice(0, 10)

describe('SEO-025 zero-result optimisation programme', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    for (const [table, file] of [
      ['search_synonym_commands', '0061_search_synonyms.sql'],
      ['search_merchandising_commands', '0091_search_merchandising_rules.sql'],
      ['search_analytics_daily', '0095_search_analytics.sql'],
      ['search_gap_cases', '0150_search_gap_programme.sql']
    ] as const)
      if (!sqlite.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table))
        sqlite.exec(await readFile(new URL(`../../db/d1/migrations/${file}`, import.meta.url), 'utf8'))
  })
  afterEach(() => sqlite.close())

  function daily(term: string, offsetDays: number, searches: number, zero: number, env = 'production') {
    sqlite
      .prepare(
        `INSERT INTO search_analytics_daily(day,term_normalized,device,segment,environment,searches_count,zero_results_count,updated_at)
         VALUES(?,?,'desktop','anonymous',?,?,?,?)
         ON CONFLICT(day,term_normalized,device,segment,environment) DO UPDATE SET searches_count=searches_count+excluded.searches_count, zero_results_count=zero_results_count+excluded.zero_results_count`
      )
      .run(day(offsetDays), term, env, searches, zero, iso())
  }
  const run = (input: unknown, key = crypto.randomUUID(), options: { now?: string } = {}) =>
    executeSearchGapCommand(database, CATEGORY_CLAIMS, input, { idempotencyKey: key, ...options })
  const seedBaseline = (term = 'quitasarros', start = -10) => {
    for (let d = start; d <= start + 9; d++) daily(term, d, 5, 5)
  }
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise
    } catch (error) {
      return error instanceof SearchGapError ? error.code : `other:${String(error)}`
    }
    return 'resolved'
  }
  async function openCase(term = 'quitasarros', start = -10) {
    seedBaseline(term, start)
    return run({ action: 'open', environment: 'production', term })
  }

  describe('backlog from first-party analytics', () => {
    it('keeps the programme floor aligned with the analytics sample threshold', () => {
      expect(SEARCH_GAP_MIN_SEARCHES).toBe(MIN_SEARCH_SAMPLE_THRESHOLD)
    })
    it('ranks zero-result terms by volume and hides terms below the privacy floor', async () => {
      seedBaseline('quitasarros')
      for (let d = -5; d <= -1; d++) daily('desatascador', d, 8, 4)
      daily('rareza', -1, 3, 3)
      daily('conresultados', -1, 50, 0)
      const backlog = await listSearchGapBacklog(database, CATEGORY_CLAIMS, { environment: 'production' })
      expect(backlog.items.map((item) => item.term)).toEqual(['quitasarros', 'desatascador'])
      expect(backlog.items[0]).toMatchObject({ searches: 50, zeroResults: 50, zeroRate: 1, caseStatus: null })
      expect(backlog.items[1]).toMatchObject({ searches: 40, zeroResults: 20, zeroRate: 0.5 })
    })
    it('ignores other environments and events outside the window', async () => {
      for (let d = -10; d <= -1; d++) daily('local-only', d, 5, 5, 'local')
      for (let d = -80; d <= -70; d++) daily('viejo', d, 5, 5)
      const backlog = await listSearchGapBacklog(database, CATEGORY_CLAIMS, { environment: 'production' })
      expect(backlog.items).toEqual([])
    })
    it('marks terms already covered by an active synonym or redirect and suggests measuring instead of re-triage', async () => {
      seedBaseline('lejia fuerte')
      seedBaseline('oferta limpieza')
      const preview = await createSearchSynonymPreview(database, CATEGORY_CLAIMS, {
        draft: {
          id: null,
          expectedVersion: 0,
          sourceTerm: 'lejia fuerte',
          replacements: ['hipoclorito'],
          active: true,
          reason: 'Terminología revisada',
          action: 'save'
        },
        query: 'lejia fuerte'
      })
      await executeSearchSynonymCommand(
        database,
        CATEGORY_CLAIMS,
        { previewId: preview.previewId, previewHash: preview.previewHash },
        { idempotencyKey: 'syn' }
      )
      await executeSearchMerchandisingCommand(
        database,
        CATEGORY_CLAIMS,
        {
          action: 'save',
          id: null,
          expectedVersion: 0,
          term: 'oferta limpieza',
          kind: 'redirect',
          productId: null,
          weight: null,
          redirectPath: '/catalogo?categoria=limpieza',
          reason: 'Campaña revisada',
          validFrom: iso(-3600_000),
          validUntil: iso(7 * DAY)
        },
        { idempotencyKey: 'red' }
      )
      const backlog = await listSearchGapBacklog(database, CATEGORY_CLAIMS, { environment: 'production' })
      const byTerm = Object.fromEntries(backlog.items.map((item) => [item.term, item]))
      expect(byTerm['lejia fuerte']).toMatchObject({ coverage: { synonym: true, redirect: false } })
      expect(byTerm['oferta limpieza']).toMatchObject({ coverage: { synonym: false, redirect: true } })
      expect(byTerm['lejia fuerte']!.suggestion).toBe('measure_existing')
    })
    it('requires catalog.write with MFA and live authorization', async () => {
      expect(
        await code(
          listSearchGapBacklog(database, { ...CATEGORY_CLAIMS, sessionVersion: 9 }, { environment: 'production' })
        )
      ).toBe('unauthenticated')
      sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
      expect(await code(listSearchGapBacklog(database, CATEGORY_CLAIMS, { environment: 'production' }))).toBe(
        'mfa_required'
      )
    })
    it('rejects malformed queries', async () => {
      expect(await code(listSearchGapBacklog(database, CATEGORY_CLAIMS, { minSearches: 1 }))).toBe('invalid_input')
      expect(await code(listSearchGapBacklog(database, CATEGORY_CLAIMS, { days: 365 }))).toBe('invalid_input')
      expect(await code(listSearchGapBacklog(database, CATEGORY_CLAIMS, { environment: 'x' }))).toBe('invalid_input')
    })
  })

  describe('cases, idempotency and CAS', () => {
    it('opens a case with a measured baseline snapshot and replays the same key exactly', async () => {
      seedBaseline()
      const input = { action: 'open', environment: 'production', term: 'Quitasarros' }
      const first = await run(input, 'open-1')
      expect(first).toMatchObject({
        term: 'quitasarros',
        status: 'open',
        version: 1,
        baseline: { searches: 50, zeroResults: 50 }
      })
      expect(await run(input, 'open-1')).toEqual(first)
      expect(sqlite.prepare('SELECT count(*) n FROM search_gap_cases').get()).toEqual({ n: 1 })
      expect(sqlite.prepare('SELECT count(*) n FROM search_gap_events').get()).toEqual({ n: 1 })
    })
    it('rejects the same key with a different payload', async () => {
      seedBaseline()
      seedBaseline('otro termino')
      await run({ action: 'open', environment: 'production', term: 'quitasarros' }, 'k')
      expect(await code(run({ action: 'open', environment: 'production', term: 'otro termino' }, 'k'))).toBe(
        'idempotency_conflict'
      )
    })
    it('refuses to open a case without measured zero-result demand', async () => {
      expect(await code(run({ action: 'open', environment: 'production', term: 'sin datos' }))).toBe('not_eligible')
      daily('pocos', -1, 5, 5)
      expect(await code(run({ action: 'open', environment: 'production', term: 'pocos' }))).toBe('not_eligible')
      daily('resueltos', -1, 100, 0)
      expect(await code(run({ action: 'open', environment: 'production', term: 'resueltos' }))).toBe('not_eligible')
    })
    it('refuses a second live case for the same term and PII-looking terms', async () => {
      await openCase()
      expect(await code(run({ action: 'open', environment: 'production', term: 'quitasarros' }))).toBe('duplicate_case')
      expect(await code(run({ action: 'open', environment: 'production', term: 'a@b.es' }))).toBe('invalid_input')
    })
    it('rejects unknown fields and malformed commands', async () => {
      expect(searchGapCommandSchema.safeParse({ action: 'open', term: 'x', extra: 1 }).success).toBe(false)
      expect(await code(run({ action: 'record_action', id: 'nope' }))).toBe('invalid_input')
      expect(await code(run({ action: 'open', term: 'ok term' }, 'bad key!'))).toBe('invalid_input')
    })
    it('records a synonym action only when the synonym is active and covers the same term', async () => {
      const opened = await openCase('quitasarros')
      const preview = await createSearchSynonymPreview(database, CATEGORY_CLAIMS, {
        draft: {
          id: null,
          expectedVersion: 0,
          sourceTerm: 'otra cosa',
          replacements: ['hipoclorito'],
          active: true,
          reason: 'Terminología revisada',
          action: 'save'
        },
        query: 'otra cosa'
      })
      const wrong = await executeSearchSynonymCommand(
        database,
        CATEGORY_CLAIMS,
        { previewId: preview.previewId, previewHash: preview.previewHash },
        { idempotencyKey: 'wrong-syn' }
      )
      const base = { action: 'record_action', id: opened.id, expectedVersion: 1, actionType: 'synonym' }
      expect(await code(run({ ...base, referenceId: wrong.item.id }))).toBe('invalid_reference')
      expect(await code(run({ ...base, referenceId: crypto.randomUUID() }))).toBe('invalid_reference')
    })
    it('records a redirect action referencing an active redirect rule for the term, then CAS rejects stale updates', async () => {
      const opened = await openCase('oferta limpieza')
      const rule = await executeSearchMerchandisingCommand(
        database,
        CATEGORY_CLAIMS,
        {
          action: 'save',
          id: null,
          expectedVersion: 0,
          term: 'oferta limpieza',
          kind: 'redirect',
          productId: null,
          weight: null,
          redirectPath: '/catalogo?categoria=limpieza',
          reason: 'Campaña revisada',
          validFrom: iso(-3600_000),
          validUntil: iso(7 * DAY)
        },
        { idempotencyKey: 'r1' }
      )
      const input = {
        action: 'record_action',
        id: opened.id,
        expectedVersion: 1,
        actionType: 'redirect',
        referenceId: rule.item.id,
        note: 'Redirigido a la familia'
      }
      const done = await run(input, 'act-1')
      expect(done).toMatchObject({ status: 'actioned', actionType: 'redirect', version: 2 })
      expect(done.actionedAt).toMatch(/Z$/)
      expect(await run(input, 'act-1')).toEqual(done)
      expect(await code(run({ ...input, note: 'Otro' }, 'act-2'))).toBe('version_conflict')
      expect(await code(run({ ...input }, 'act-3'))).toBe('version_conflict')
      expect(sqlite.prepare('SELECT count(*) n FROM search_gap_events WHERE case_id=?').get(opened.id)).toEqual({
        n: 2
      })
    })
    it('verifies assortment (published product) and content (published CMS slug) references', async () => {
      const opened = await openCase('quitasarros')
      const base = { action: 'record_action', id: opened.id, expectedVersion: 1 }
      expect(await code(run({ ...base, actionType: 'assortment', referenceId: 'no-existe' }))).toBe('invalid_reference')
      expect(await code(run({ ...base, actionType: 'content', referenceId: 'guia-inexistente' }))).toBe(
        'invalid_reference'
      )
      sqlite.exec('PRAGMA foreign_keys=OFF')
      sqlite.prepare("INSERT INTO brands(id,name,slug,status) VALUES('gb','B','gb','published')").run()
      sqlite
        .prepare(
          "INSERT INTO products(id,legacy_id,name,slug,category_id,brand_id,status) VALUES('10000000-0000-4000-8000-0000000000aa',900,'Quitasarros pro','quitasarros-pro',?,'gb','draft')"
        )
        .run(ROOT_CATEGORY)
      expect(
        await code(run({ ...base, actionType: 'assortment', referenceId: '10000000-0000-4000-8000-0000000000aa' }))
      ).toBe('invalid_reference')
      sqlite.exec("UPDATE products SET status='published' WHERE legacy_id=900")
      const done = await run({
        ...base,
        actionType: 'assortment',
        referenceId: '10000000-0000-4000-8000-0000000000aa'
      })
      expect(done).toMatchObject({ status: 'actioned', actionType: 'assortment' })
    })
    it('dismisses with a reason and then refuses further actions', async () => {
      const opened = await openCase()
      expect(await code(run({ action: 'dismiss', id: opened.id, expectedVersion: 1, note: 'x' }))).toBe('invalid_input')
      const dismissed = await run({ action: 'dismiss', id: opened.id, expectedVersion: 1, note: 'Fuera de catálogo' })
      expect(dismissed).toMatchObject({ status: 'dismissed', version: 2, note: 'Fuera de catálogo' })
      expect(await code(run({ action: 'dismiss', id: opened.id, expectedVersion: 2, note: 'Otra vez no cabe' }))).toBe(
        'invalid_state'
      )
      await openCase() // a new live case for the same term is allowed after dismissal (baseline already seeded)
    })
    it('returns not_found for unknown ids and keeps events append-only', async () => {
      expect(
        await code(run({ action: 'dismiss', id: crypto.randomUUID(), expectedVersion: 1, note: 'No existe' }))
      ).toBe('not_found')
      await openCase()
      expect(() => sqlite.exec("UPDATE search_gap_events SET action='open'")).toThrow(/immutable/)
      expect(() => sqlite.exec('DELETE FROM search_gap_events')).toThrow(/immutable/)
    })
    it('re-checks authorization on every command and on replay', async () => {
      await openCase()
      sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CATEGORY_IDENTITY)
      expect(await code(run({ action: 'open', environment: 'production', term: 'quitasarros' }, 'k2'))).toBe(
        'forbidden'
      )
    })
    it('rolls back the case when the audit event cannot be written', async () => {
      seedBaseline()
      sqlite.exec(
        "CREATE TRIGGER synthetic_gap_failure BEFORE INSERT ON search_gap_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"
      )
      await expect(run({ action: 'open', environment: 'production', term: 'quitasarros' })).rejects.toThrow()
      expect(sqlite.prepare('SELECT count(*) n FROM search_gap_cases').get()).toEqual({ n: 0 })
    })
    it('lists cases by status', async () => {
      const opened = await openCase()
      await run({ action: 'dismiss', id: opened.id, expectedVersion: 1, note: 'Fuera de catálogo' })
      expect((await listSearchGapCases(database, CATEGORY_CLAIMS, { status: 'open' })).items).toHaveLength(0)
      expect((await listSearchGapCases(database, CATEGORY_CLAIMS, { status: 'dismissed' })).items).toHaveLength(1)
      expect(await code(listSearchGapCases(database, CATEGORY_CLAIMS, { status: 'bogus' }))).toBe('invalid_input')
    })
  })

  describe('measured outcome', () => {
    async function actioned() {
      const opened = await openCase('oferta limpieza', -27)
      const rule = await executeSearchMerchandisingCommand(
        database,
        CATEGORY_CLAIMS,
        {
          action: 'save',
          id: null,
          expectedVersion: 0,
          term: 'oferta limpieza',
          kind: 'redirect',
          productId: null,
          weight: null,
          redirectPath: '/catalogo?categoria=limpieza',
          reason: 'Campaña revisada',
          validFrom: iso(-3600_000),
          validUntil: iso(30 * DAY)
        },
        { idempotencyKey: 'r1' }
      )
      // move the action 10 days back so the post window can hold data
      const done = await run(
        {
          action: 'record_action',
          id: opened.id,
          expectedVersion: 1,
          actionType: 'redirect',
          referenceId: rule.item.id
        },
        'act'
      )
      sqlite.prepare('UPDATE search_gap_cases SET actioned_at=? WHERE id=?').run(iso(-10 * DAY), done.id)
      return done
    }
    it('reports not_actioned for open cases', async () => {
      const opened = await openCase()
      expect((await measureSearchGapCase(database, CATEGORY_CLAIMS, opened.id)).verdict).toBe('not_actioned')
    })
    it('reports insufficient_data when too few days or searches follow the action', async () => {
      const done = await actioned()
      daily('oferta limpieza', -2, 5, 0)
      const measurement = await measureSearchGapCase(database, CATEGORY_CLAIMS, done.id)
      expect(measurement.verdict).toBe('insufficient_data')
      expect(measurement.after.searches).toBe(5)
    })
    it('reports improved when the zero-result rate falls enough, with before/after figures', async () => {
      const done = await actioned()
      for (let d = -9; d <= -1; d++) daily('oferta limpieza', d, 5, 1)
      const measurement = await measureSearchGapCase(database, CATEGORY_CLAIMS, done.id)
      expect(measurement).toMatchObject({
        verdict: 'improved',
        baseline: { searches: 50, zeroResults: 50, zeroRate: 1 },
        after: { searches: 45, zeroResults: 9, zeroRate: 0.2 }
      })
    })
    it('reports no_change and worse accordingly', async () => {
      const done = await actioned()
      for (let d = -9; d <= -1; d++) daily('oferta limpieza', d, 5, 5)
      expect((await measureSearchGapCase(database, CATEGORY_CLAIMS, done.id)).verdict).toBe('no_change')
      const worse = judgeSearchGap({
        actioned: true,
        baselineSearches: 100,
        baselineZero: 10,
        afterSearches: 100,
        afterZero: 12,
        afterDays: 14
      })
      expect(worse).toBe('worse')
    })
    it('returns not_found for unknown cases', async () => {
      expect(await code(measureSearchGapCase(database, CATEGORY_CLAIMS, crypto.randomUUID()))).toBe('not_found')
      expect(await code(measureSearchGapCase(database, CATEGORY_CLAIMS, 'bad'))).toBe('invalid_input')
    })
  })
})
