import { beforeEach, describe, expect, it } from 'vitest'
import {
  ABUSE_RULES,
  computePsi,
  proportionsFromSamples,
  pseudonymizeSubject,
  scoreAbuse,
  summarizeReviewMetrics,
  type AbuseModel
} from '../../shared/security-abuse-detection'
import {
  activateModelVersion,
  assessAbuse,
  computeDrift,
  createModelVersion,
  getAbuseMetrics,
  getActiveModel,
  listReviewQueue,
  purgeExpiredAssessments,
  recordBaseline,
  reviewAssessment
} from '../../workers/security/abuse-detection'
import {
  IDS,
  NOW,
  PEPPER,
  addMinutes,
  dumpDatabaseText,
  openSecurityControlsDatabase,
  uuid,
  type SecurityWorld
} from '../support/security-controls-fixture'

const MODEL: AbuseModel = {
  weights: Object.fromEntries(ABUSE_RULES.map((r) => [r.feature, r.defaultWeight])),
  reviewThreshold: 40,
  holdThreshold: 75
}
const CAPS = Object.fromEntries(ABUSE_RULES.map((r) => [r.feature, r.cap]))
const ctx = { now: NOW, pepper: PEPPER }
const admin = { actorIdentityId: IDS.admin, now: NOW }
let n = 900
const cmd = () => uuid(++n)
const assess = (world: SecurityWorld, features: Record<string, number>, over: Record<string, unknown> = {}, at = NOW) =>
  assessAbuse(
    world.db,
    { commandId: cmd(), subjectKind: 'identity', subjectId: IDS.plain, context: 'checkout', features, ...over },
    { ...ctx, now: at }
  )

describe('SEC-040 shared: heurísticas explicables, PSI y métricas', () => {
  it('sin señales: score 0 y allow; todo al tope: 100 y hold', () => {
    expect(scoreAbuse({}, MODEL)).toMatchObject({ score: 0, decision: 'allow', contributions: [] })
    const all = scoreAbuse(CAPS, MODEL)
    expect(all.score).toBe(100)
    expect(all.decision).toBe('hold')
  })

  it('la explicación enumera contribuciones ordenadas que suman el score', () => {
    const result = scoreAbuse(
      { failed_logins_1h: CAPS.failed_logins_1h!, coupon_attempts_1h: CAPS.coupon_attempts_1h! / 2 },
      MODEL
    )
    expect(result.contributions.length).toBe(2)
    expect(result.contributions[0]!.points).toBeGreaterThanOrEqual(result.contributions[1]!.points)
    expect(result.contributions[0]).toMatchObject({
      ruleCode: expect.any(String),
      feature: expect.any(String),
      value: expect.any(Number),
      cap: expect.any(Number),
      weight: expect.any(Number),
      reason: expect.any(String)
    })
    const total = result.contributions.reduce((sum, c) => sum + c.points, 0)
    expect(Math.round(total)).toBe(result.score)
  })

  it('los valores por encima del tope no superan el peso de la regla', () => {
    const a = scoreAbuse({ failed_logins_1h: CAPS.failed_logins_1h! }, MODEL)
    const b = scoreAbuse({ failed_logins_1h: CAPS.failed_logins_1h! * 1000 }, MODEL)
    expect(b.score).toBe(a.score)
  })

  it('umbrales exactos de revisión y retención', () => {
    const model: AbuseModel = { weights: { failed_logins_1h: 1 }, reviewThreshold: 40, holdThreshold: 75 }
    const cap = CAPS.failed_logins_1h!
    expect(scoreAbuse({ failed_logins_1h: cap * 0.39 }, model).decision).toBe('allow')
    expect(scoreAbuse({ failed_logins_1h: cap * 0.4 }, model)).toMatchObject({ score: 40, decision: 'review' })
    expect(scoreAbuse({ failed_logins_1h: cap * 0.75 }, model)).toMatchObject({ score: 75, decision: 'hold' })
  })

  it('rechaza características desconocidas, negativas, NaN o no numéricas', () => {
    expect(() => scoreAbuse({ email: 1 } as never, MODEL)).toThrow(/unknown_feature/)
    expect(() => scoreAbuse({ failed_logins_1h: -1 }, MODEL)).toThrow(/invalid_feature_value/)
    expect(() => scoreAbuse({ failed_logins_1h: Number.NaN }, MODEL)).toThrow(/invalid_feature_value/)
    expect(() => scoreAbuse({ failed_logins_1h: '3' as never }, MODEL)).toThrow(/invalid_feature_value/)
  })

  it('PSI: distribuciones iguales ~0, desplazadas alto, tamaños distintos error', () => {
    const base = [0.2, 0.2, 0.2, 0.2, 0.2]
    expect(computePsi(base, base)).toBeCloseTo(0, 6)
    expect(computePsi(base, [0.05, 0.05, 0.1, 0.2, 0.6])).toBeGreaterThan(0.25)
    expect(computePsi(base, [0.18, 0.22, 0.2, 0.2, 0.2])).toBeLessThan(0.1)
    expect(() => computePsi(base, [1])).toThrow()
    expect(Number.isFinite(computePsi([1, 0, 0, 0, 0], [0, 0, 0, 0, 1]))).toBe(true)
  })

  it('proportionsFromSamples reparte en 5 cajas por fracción del tope', () => {
    const cap = 10
    expect(proportionsFromSamples([0, 1, 3, 6, 9, 11], cap)).toEqual([2 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6])
    expect(proportionsFromSamples([], cap)).toEqual([0, 0, 0, 0, 0])
  })

  it('métricas de revisión: precisión y tasa de falsos positivos solo con datos', () => {
    expect(summarizeReviewMetrics({ confirmed: 0, falsePositive: 0, pending: 3, flagged: 3 })).toMatchObject({
      reviewed: 0,
      precision: null,
      falsePositiveRate: null,
      reviewCoverage: 0
    })
    expect(summarizeReviewMetrics({ confirmed: 6, falsePositive: 2, pending: 2, flagged: 10 })).toMatchObject({
      reviewed: 8,
      precision: 0.75,
      falsePositiveRate: 0.25,
      reviewCoverage: 0.8
    })
  })

  it('pseudonimiza el sujeto de forma determinista, por tipo, sin exponer el original', async () => {
    const a = await pseudonymizeSubject('identity', 'abc-123', PEPPER)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(await pseudonymizeSubject('identity', 'abc-123', PEPPER))
    expect(a).not.toBe(await pseudonymizeSubject('ip', 'abc-123', PEPPER))
    expect(a).not.toBe(await pseudonymizeSubject('identity', 'abc-123', PEPPER + 'x'))
  })
})

describe('SEC-040 worker: evaluación, revisión humana, drift y métricas', () => {
  let world: SecurityWorld
  beforeEach(async () => {
    world = await openSecurityControlsDatabase()
  })

  it('existe un modelo v1 activo por defecto', async () => {
    const model = await getActiveModel(world.db)
    expect(model).toMatchObject({ version: 1, status: 'active', reviewThreshold: 40, holdThreshold: 75 })
  })

  it('allow no abre revisión; review/hold quedan pendientes y nunca bloquean automáticamente', async () => {
    const low = await assess(world, {})
    expect(low.assessment).toMatchObject({ decision: 'allow', reviewStatus: 'not_required', score: 0 })
    const high = await assess(world, CAPS, { subjectId: IDS.worker1 })
    expect(high.assessment).toMatchObject({ decision: 'hold', reviewStatus: 'pending' })
    expect(high.assessment.explanation.humanReviewRequired).toBe(true)
    expect(high.assessment.explanation.contributions.length).toBeGreaterThan(0)
    expect(['allow', 'review', 'hold']).toContain(high.assessment.decision)
  })

  it('no almacena el identificador original del sujeto ni datos personales', async () => {
    await assess(world, CAPS, { subjectKind: 'ip', subjectId: '203.0.113.77' })
    const text = dumpDatabaseText(world.sqlite, ['abuse_assessments', 'abuse_audit'])
    expect(text).not.toContain('203.0.113.77')
    const row = world.sqlite.prepare('SELECT subject_ref FROM abuse_assessments').get() as { subject_ref: string }
    expect(row.subject_ref).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rechaza características no numéricas o desconocidas y pepper débil', async () => {
    await expect(assess(world, { failed_logins_1h: '3' as never })).rejects.toMatchObject({
      code: 'invalid_input',
      status: 400
    })
    await expect(assess(world, { email: 1 } as never)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      assessAbuse(
        world.db,
        { commandId: cmd(), subjectKind: 'identity', subjectId: 'x', context: 'login', features: {} },
        { now: NOW, pepper: 'corto' }
      )
    ).rejects.toMatchObject({ code: 'security_configuration_missing' })
  })

  it('es idempotente por commandId y detecta payload distinto', async () => {
    const commandId = cmd()
    const a = await assess(world, { failed_logins_1h: 8 }, { commandId })
    const b = await assess(world, { failed_logins_1h: 8 }, { commandId })
    expect(b.replayed).toBe(true)
    expect(b.assessment.id).toBe(a.assessment.id)
    await expect(assess(world, { failed_logins_1h: 9 }, { commandId })).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    expect(world.sqlite.prepare('SELECT COUNT(*) c FROM abuse_assessments').get()).toEqual({ c: 1 })
  })

  it('la cola de revisión lista pendientes más antiguos primero con explicación y límite', async () => {
    await assess(world, CAPS, { subjectId: 'a' }, '2026-10-29T10:00:00Z')
    await assess(world, CAPS, { subjectId: 'b' }, '2026-10-29T10:01:00Z')
    await assess(world, CAPS, { subjectId: 'c' }, '2026-10-29T10:02:00Z')
    await assess(world, {}, { subjectId: 'd' }, '2026-10-29T10:03:00Z')
    const queue = await listReviewQueue(world.db, { limit: 2 }, admin)
    expect(queue.map((q) => q.createdAt)).toEqual(['2026-10-29T10:00:00Z', '2026-10-29T10:01:00Z'])
    expect(queue[0]!.explanation.contributions.length).toBeGreaterThan(0)
    await expect(
      listReviewQueue(world.db, { limit: 2 }, { actorIdentityId: IDS.plain, now: NOW })
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('revisión humana: confirma o marca falso positivo una sola vez', async () => {
    const { assessment } = await assess(world, CAPS)
    const reviewed = await reviewAssessment(
      world.db,
      { assessmentId: assessment.id, outcome: 'false_positive', note: 'cliente legítimo con compra grande' },
      admin
    )
    expect(reviewed.assessment).toMatchObject({ reviewStatus: 'reviewed' })
    expect(reviewed.review).toMatchObject({ outcome: 'false_positive', reviewerIdentityId: IDS.admin })
    await expect(
      reviewAssessment(world.db, { assessmentId: assessment.id, outcome: 'confirmed_abuse', note: 'x' }, admin)
    ).rejects.toMatchObject({ code: 'already_reviewed', status: 409 })
    expect(await listReviewQueue(world.db, { limit: 10 }, admin)).toHaveLength(0)
  })

  it('revisión: permisos, no requerida, inexistente y nota acotada', async () => {
    const low = await assess(world, {})
    const high = await assess(world, CAPS, { subjectId: 'z' })
    await expect(
      reviewAssessment(
        world.db,
        { assessmentId: high.assessment.id, outcome: 'confirmed_abuse', note: 'x' },
        { actorIdentityId: IDS.plain, now: NOW }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      reviewAssessment(world.db, { assessmentId: low.assessment.id, outcome: 'confirmed_abuse', note: 'x' }, admin)
    ).rejects.toMatchObject({ code: 'review_not_required', status: 409 })
    await expect(
      reviewAssessment(world.db, { assessmentId: uuid(2), outcome: 'confirmed_abuse', note: 'x' }, admin)
    ).rejects.toMatchObject({ code: 'assessment_not_found', status: 404 })
    await expect(
      reviewAssessment(
        world.db,
        { assessmentId: high.assessment.id, outcome: 'confirmed_abuse', note: 'x'.repeat(501) },
        admin
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      reviewAssessment(world.db, { assessmentId: high.assessment.id, outcome: 'maybe' as never, note: 'x' }, admin)
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('dos revisiones concurrentes: solo una gana (CAS)', async () => {
    const { assessment } = await assess(world, CAPS)
    const mk = (outcome: 'confirmed_abuse' | 'false_positive') =>
      reviewAssessment(world.db, { assessmentId: assessment.id, outcome, note: 'ok' }, admin)
    const results = await Promise.allSettled([mk('confirmed_abuse'), mk('false_positive')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(world.sqlite.prepare('SELECT COUNT(*) c FROM abuse_reviews').get()).toEqual({ c: 1 })
  })

  it('las evaluaciones son inmutables salvo el estado de revisión', async () => {
    const { assessment } = await assess(world, CAPS)
    expect(() => world.sqlite.prepare('UPDATE abuse_assessments SET score=0 WHERE id=?').run(assessment.id)).toThrow(
      /immutable/
    )
    await reviewAssessment(world.db, { assessmentId: assessment.id, outcome: 'confirmed_abuse', note: 'ok' }, admin)
    expect(() => world.sqlite.prepare('DELETE FROM abuse_reviews').run()).toThrow(/append_only/)
    expect(() => world.sqlite.prepare("UPDATE abuse_audit SET action='x'").run()).toThrow(/append_only/)
  })

  it('métricas: falsos positivos, precisión, cobertura y backlog, filtrando por ventana', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1)
      ids.push((await assess(world, CAPS, { subjectId: `s${i}` }, addMinutes(NOW, i))).assessment.id)
    await assess(world, CAPS, { subjectId: 'old' }, '2026-09-01T00:00:00Z')
    const outcomes = ['confirmed_abuse', 'confirmed_abuse', 'confirmed_abuse', 'false_positive'] as const
    for (const [i, outcome] of outcomes.entries())
      await reviewAssessment(world.db, { assessmentId: ids[i]!, outcome, note: 'ok' }, admin)
    const metrics = await getAbuseMetrics(world.db, { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' })
    expect(metrics).toMatchObject({
      flagged: 5,
      reviewed: 4,
      confirmed: 3,
      falsePositive: 1,
      pending: 1,
      precision: 0.75,
      falsePositiveRate: 0.25,
      reviewCoverage: 0.8
    })
    expect(metrics.byDecision.hold).toBe(5)
    const empty = await getAbuseMetrics(world.db, { from: '2025-01-01T00:00:00Z', to: '2025-02-01T00:00:00Z' })
    expect(empty).toMatchObject({ flagged: 0, precision: null, falsePositiveRate: null })
    await expect(
      getAbuseMetrics(world.db, { from: '2026-11-01T00:00:00Z', to: '2026-10-01T00:00:00Z' })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('versiones de modelo: crear borrador, activar (solo una activa), auditar y validar pesos', async () => {
    const active = await getActiveModel(world.db)
    const weights = { ...active.weights, failed_logins_1h: 0.5 }
    await expect(
      createModelVersion(world.db, { weights, reviewThreshold: 80, holdThreshold: 70 }, admin)
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      createModelVersion(world.db, { weights: { nope: 1 }, reviewThreshold: 30, holdThreshold: 70 }, admin)
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      createModelVersion(world.db, { weights: {}, reviewThreshold: 30, holdThreshold: 70 }, admin)
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      createModelVersion(
        world.db,
        { weights, reviewThreshold: 30, holdThreshold: 70 },
        { actorIdentityId: IDS.plain, now: NOW }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    const draft = await createModelVersion(world.db, { weights, reviewThreshold: 30, holdThreshold: 70 }, admin)
    expect(draft).toMatchObject({ version: 2, status: 'draft' })
    const activated = await activateModelVersion(world.db, { modelVersionId: draft.id }, admin)
    expect(activated.status).toBe('active')
    expect((await getActiveModel(world.db)).id).toBe(draft.id)
    expect(world.sqlite.prepare(`SELECT COUNT(*) c FROM abuse_model_versions WHERE status='active'`).get()).toEqual({
      c: 1
    })
    await expect(activateModelVersion(world.db, { modelVersionId: uuid(6) }, admin)).rejects.toMatchObject({
      code: 'model_not_found'
    })
    await expect(activateModelVersion(world.db, { modelVersionId: draft.id }, admin)).rejects.toMatchObject({
      code: 'invalid_transition'
    })
    const { assessment } = await assess(world, {})
    expect(assessment.modelVersionId).toBe(draft.id)
    const actions = world.sqlite
      .prepare('SELECT action FROM abuse_audit ORDER BY created_at, rowid')
      .all()
      .map((r) => (r as { action: string }).action)
    expect(actions).toEqual(expect.arrayContaining(['model_created', 'model_activated']))
  })

  describe('drift', () => {
    async function baseline(model: { id: string }) {
      const samples: Record<string, number[]> = {}
      for (const rule of ABUSE_RULES)
        samples[rule.feature] = Array.from({ length: 100 }, (_, i) => (i % 100) * (rule.cap / 100))
      return recordBaseline(world.db, { modelVersionId: model.id, samples }, admin)
    }

    it('baseline + ventana estable: PSI bajo y estado ok', async () => {
      const model = await getActiveModel(world.db)
      await baseline(model)
      for (let i = 0; i < 40; i += 1)
        await assess(world, { failed_logins_1h: (i % 40) * (CAPS.failed_logins_1h! / 40) }, { subjectId: `u${i}` })
      const reports = await computeDrift(
        world.db,
        { modelVersionId: model.id, from: '2026-10-29T00:00:00Z', to: '2026-10-30T00:00:00Z' },
        admin
      )
      const logins = reports.find((r) => r.feature === 'failed_logins_1h')!
      expect(logins.status).toBe('ok')
      expect(logins.sampleSize).toBe(40)
      expect(logins.psi).toBeLessThan(0.1)
    })

    it('ventana desplazada: PSI alto, estado alert y se persiste el informe', async () => {
      const model = await getActiveModel(world.db)
      await baseline(model)
      for (let i = 0; i < 40; i += 1)
        await assess(world, { failed_logins_1h: CAPS.failed_logins_1h! * 2 }, { subjectId: `v${i}` })
      const reports = await computeDrift(
        world.db,
        { modelVersionId: model.id, from: '2026-10-29T00:00:00Z', to: '2026-10-30T00:00:00Z' },
        admin
      )
      expect(reports.find((r) => r.feature === 'failed_logins_1h')).toMatchObject({ status: 'alert' })
      expect(world.sqlite.prepare('SELECT COUNT(*) c FROM abuse_drift_reports').get()).toEqual({
        c: ABUSE_RULES.length
      })
    })

    it('pocas muestras: insufficient_data; sin baseline: error', async () => {
      const model = await getActiveModel(world.db)
      await expect(
        computeDrift(
          world.db,
          { modelVersionId: model.id, from: '2026-10-29T00:00:00Z', to: '2026-10-30T00:00:00Z' },
          admin
        )
      ).rejects.toMatchObject({ code: 'baseline_missing', status: 409 })
      await baseline(model)
      await assess(world, { failed_logins_1h: 1 })
      const reports = await computeDrift(
        world.db,
        { modelVersionId: model.id, from: '2026-10-29T00:00:00Z', to: '2026-10-30T00:00:00Z' },
        admin
      )
      expect(reports.every((r) => r.status === 'insufficient_data' && r.psi === null)).toBe(true)
    })

    it('solo administradores registran baselines y calculan drift; muestras inválidas se rechazan', async () => {
      const model = await getActiveModel(world.db)
      await expect(
        recordBaseline(
          world.db,
          { modelVersionId: model.id, samples: { failed_logins_1h: Array.from({ length: 40 }, () => 1) } },
          { actorIdentityId: IDS.plain, now: NOW }
        )
      ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        recordBaseline(
          world.db,
          { modelVersionId: model.id, samples: { failed_logins_1h: Array.from({ length: 5 }, () => 1) } },
          admin
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(
        recordBaseline(
          world.db,
          { modelVersionId: model.id, samples: { failed_logins_1h: Array.from({ length: 50 }, () => -1) } },
          admin
        )
      ).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(
        computeDrift(
          world.db,
          { modelVersionId: model.id, from: '2026-10-29T00:00:00Z', to: '2026-10-30T00:00:00Z' },
          { actorIdentityId: IDS.plain, now: NOW }
        )
      ).rejects.toMatchObject({ code: 'forbidden' })
    })
  })

  it('retención: purga evaluaciones caducadas ya resueltas y conserva las pendientes', async () => {
    const old = '2026-01-01T00:00:00Z'
    const allow = await assess(world, {}, { subjectId: 'a' }, old)
    const pending = await assess(world, CAPS, { subjectId: 'b' }, old)
    const done = await assess(world, CAPS, { subjectId: 'c' }, old)
    await reviewAssessment(
      world.db,
      { assessmentId: done.assessment.id, outcome: 'confirmed_abuse', note: 'ok' },
      admin
    )
    const fresh = await assess(world, {}, { subjectId: 'd' })
    expect(allow.assessment.expiresAt <= NOW).toBe(true)
    const result = await purgeExpiredAssessments(world.db, { now: NOW })
    expect(result.deleted).toBe(1 + 1)
    const remaining = world.sqlite
      .prepare('SELECT id FROM abuse_assessments')
      .all()
      .map((r) => (r as { id: string }).id)
    expect(remaining.sort()).toEqual([pending.assessment.id, fresh.assessment.id].sort())
    expect(world.sqlite.prepare('SELECT COUNT(*) c FROM abuse_reviews').get()).toEqual({ c: 0 })
  })
})
