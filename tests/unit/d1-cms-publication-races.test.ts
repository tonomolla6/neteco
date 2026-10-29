import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { CMS_CLAIMS, CMS_SESSION } from './d1-cms-fixture'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
describe('CMS publication guarded real-SQLite concurrency', () => {
  let f: Awaited<ReturnType<typeof cmsPublicationFixture>>
  beforeEach(async () => {
    f = await cmsPublicationFixture()
  })
  afterEach(() => f.sqlite.close())
  const publish = () => ({
    action: 'publish',
    expectedRevision: 0,
    expectedVersion: 1,
    versionId: f.created.versionId,
    reason: 'Explicit concurrent editorial approval'
  })
  // Both commands must finish their preflight before either transaction commits.
  // D1 serializes atomic batches; this preserves that ordering over real SQLite.
  function concurrentDependencies() {
    let arrivals = 0
    let open: () => void = () => undefined
    const barrier = new Promise<void>((resolve) => {
      open = resolve
    })
    let queue = Promise.resolve()
    return {
      ...f.deps,
      database: {
        ...f.database,
        batch: async (statements: D1PreparedStatement[]) => {
          if (++arrivals === 2) open()
          await barrier
          const result = queue.then(() => f.database.batch(statements))
          queue = result.then(
            () => undefined,
            () => undefined
          )
          return result
        }
      }
    }
  }
  it('concurrent identical intent gets the same immutable receipt with one release/audit', async () => {
    const deps = concurrentDependencies()
    const results = await Promise.all([
      executeCmsPublicationCommand(deps, CMS_CLAIMS, f.created.pageId, publish(), 'same'),
      executeCmsPublicationCommand(deps, CMS_CLAIMS, f.created.pageId, publish(), 'same')
    ])
    expect(results[0]).toEqual(results[1])
    for (const table of ['content_publications', 'content_publication_commands', 'content_publication_audit'])
      expect(f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(1)
  })
  it('two distinct approvals for one revision cannot both commit', async () => {
    const deps = concurrentDependencies()
    const result = await Promise.allSettled([
      executeCmsPublicationCommand(deps, CMS_CLAIMS, f.created.pageId, publish(), 'first'),
      executeCmsPublicationCommand(deps, CMS_CLAIMS, f.created.pageId, publish(), 'second')
    ])
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(result.find((item) => item.status === 'rejected')).toMatchObject({ reason: { code: 'version_conflict' } })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_publications').get()?.n).toBe(1)
  })
  it('simultaneous reuse of one key with changed approval cannot replay the winner', async () => {
    const deps = concurrentDependencies()
    const result = await Promise.allSettled([
      executeCmsPublicationCommand(deps, CMS_CLAIMS, f.created.pageId, publish(), 'same'),
      executeCmsPublicationCommand(
        deps,
        CMS_CLAIMS,
        f.created.pageId,
        { ...publish(), reason: 'A different editorial approval' },
        'same'
      )
    ])
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(result.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { code: 'idempotency_conflict' }
    })
    for (const table of ['content_publications', 'content_publication_commands', 'content_publication_audit'])
      expect(f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(1)
  })
  it('live grant/MFA revoked at batch entry rolls every write back atomically', async () => {
    const original = f.database.batch
    const deps = {
      ...f.deps,
      database: {
        ...f.database,
        batch: async (statements: D1PreparedStatement[]) => {
          f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CMS_SESSION)
          return original(statements)
        }
      }
    }
    await expect(
      executeCmsPublicationCommand(deps, CMS_CLAIMS, f.created.pageId, publish(), 'race')
    ).rejects.toMatchObject({ code: 'mfa_required' })
    for (const table of [
      'content_publication_states',
      'content_publications',
      'content_publication_commands',
      'content_publication_audit',
      'content_publication_guards'
    ])
      expect(f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0)
  })
})
