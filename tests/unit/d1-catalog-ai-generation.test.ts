import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiTestFixture, ADMIN_CLAIMS, OPERATOR_CLAIMS, UNAUTHORIZED_CLAIMS } from './d1-ai-test-fixture'
import type {
  GenerateCatalogContentInput,
  ReviewCatalogGenerationInput,
  ApplyCatalogGenerationInput
} from '../../shared/catalog-ai-generation'
import {
  generateD1CatalogContent,
  reviewD1CatalogAiGeneration,
  applyD1CatalogAiGeneration,
  readD1CatalogAiGeneration,
  listD1CatalogAiGenerations,
  checkD1CatalogDuplicates
} from '../../workers/catalog/ai-generation'

const NOW = '2026-10-29T12:00:00Z'

describe('ADM-033: Assisted catalog description & attribute generation', () => {
  let f: Awaited<ReturnType<typeof aiTestFixture>>

  beforeEach(async () => {
    f = await aiTestFixture()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    f.sqlite.close()
  })

  it('requires MFA, an independent reviewer and publication authority to apply generated text', async () => {
    const input: GenerateCatalogContentInput = {
      productName: 'Limpiador seguro para suelos',
      targetScope: 'description',
      prompt: 'Describir el producto usando su ficha técnica',
      sources: [
        {
          id: 'source-independent-review',
          title: 'Ficha técnica del limpiador',
          type: 'tech_sheet',
          verifiedClaims: ['Producto apto para limpieza de suelos'],
          textSnippet: 'Limpiador técnico para superficies de suelo.'
        }
      ]
    }
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(OPERATOR_CLAIMS.sessionId)
    await expect(
      generateD1CatalogContent(f.database, OPERATOR_CLAIMS, input, { idempotencyKey: 'mfa', now: () => NOW })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(OPERATOR_CLAIMS.sessionId)

    const generated = await generateD1CatalogContent(f.database, OPERATOR_CLAIMS, input, {
      idempotencyKey: 'independent-create',
      now: () => NOW
    })
    await expect(
      reviewD1CatalogAiGeneration(
        f.database,
        OPERATOR_CLAIMS,
        generated.id,
        { expectedVersion: generated.version, decision: 'approve' },
        { idempotencyKey: 'self-review', now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    const reviewed = await reviewD1CatalogAiGeneration(
      f.database,
      ADMIN_CLAIMS,
      generated.id,
      { expectedVersion: generated.version, decision: 'approve' },
      { idempotencyKey: 'independent-review', now: () => NOW }
    )
    await expect(
      applyD1CatalogAiGeneration(
        f.database,
        OPERATOR_CLAIMS,
        generated.id,
        { expectedVersion: reviewed.version, targetProductId: 'prod-desengrasante-1' },
        { idempotencyKey: 'no-publish-permission', now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('does not apply generated text if the publishing session is revoked before the D1 batch', async () => {
    const generated = await generateD1CatalogContent(
      f.database,
      OPERATOR_CLAIMS,
      {
        productName: 'Limpiador para suelos',
        targetScope: 'description',
        prompt: 'Describir el limpiador usando la ficha técnica',
        sources: [
          {
            id: 'source-race',
            title: 'Ficha técnica de limpieza',
            type: 'tech_sheet',
            verifiedClaims: ['Apto para limpieza de suelos'],
            textSnippet: 'Limpiador técnico para superficies de suelo.'
          }
        ]
      },
      { idempotencyKey: 'race-create', now: () => NOW }
    )
    const reviewed = await reviewD1CatalogAiGeneration(
      f.database,
      ADMIN_CLAIMS,
      generated.id,
      { expectedVersion: generated.version, decision: 'approve' },
      { idempotencyKey: 'race-review', now: () => NOW }
    )
    const productBefore = f.sqlite.prepare('SELECT description FROM products WHERE id=?').get('prod-desengrasante-1')
    const originalBatch = f.database.batch.bind(f.database)
    vi.spyOn(f.database, 'batch').mockImplementationOnce(async (statements) => {
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, ADMIN_CLAIMS.sessionId)
      return originalBatch(statements)
    })
    await expect(
      applyD1CatalogAiGeneration(
        f.database,
        ADMIN_CLAIMS,
        generated.id,
        { expectedVersion: reviewed.version, targetProductId: 'prod-desengrasante-1' },
        { idempotencyKey: 'race-apply', now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(f.sqlite.prepare('SELECT description FROM products WHERE id=?').get('prod-desengrasante-1')).toEqual(
      productBefore
    )
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM catalog_ai_generation_commands WHERE action='apply_to_product'").get()
    ).toEqual({ n: 0 })
  })

  it('does not record a review if its session is revoked before the write', async () => {
    const generated = await generateD1CatalogContent(
      f.database,
      OPERATOR_CLAIMS,
      {
        productName: 'Limpiador industrial',
        targetScope: 'description',
        prompt: 'Describir con la ficha técnica',
        sources: [
          {
            id: 'source-review-race',
            title: 'Ficha técnica industrial',
            type: 'tech_sheet',
            verifiedClaims: ['Apto para uso industrial'],
            textSnippet: 'Limpiador apto para superficies industriales.'
          }
        ]
      },
      { idempotencyKey: 'review-race-create', now: () => NOW }
    )
    const originalPrepare = f.database.prepare.bind(f.database)
    vi.spyOn(f.database, 'prepare').mockImplementation((sql) => {
      if (sql.includes('UPDATE catalog_ai_generations') && sql.includes('human_reviewer_id')) {
        f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, ADMIN_CLAIMS.sessionId)
      }
      return originalPrepare(sql)
    })
    await expect(
      reviewD1CatalogAiGeneration(
        f.database,
        ADMIN_CLAIMS,
        generated.id,
        { expectedVersion: generated.version, decision: 'approve' },
        { idempotencyKey: 'review-race', now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(
      f.sqlite.prepare('SELECT approval_status, version FROM catalog_ai_generations WHERE id=?').get(generated.id)
    ).toEqual({ approval_status: 'pending_review', version: generated.version })
    expect(
      f.sqlite
        .prepare("SELECT count(*) AS n FROM catalog_ai_generation_commands WHERE action='human_review_decision'")
        .get()
    ).toEqual({ n: 0 })
  })

  it('replays matching concurrent reviews once and rejects another command for the stale version', async () => {
    const generated = await generateD1CatalogContent(
      f.database,
      OPERATOR_CLAIMS,
      {
        productName: 'Limpiador para talleres',
        targetScope: 'description',
        prompt: 'Describir según ficha técnica',
        sources: [
          {
            id: 'source-review-concurrency',
            title: 'Ficha técnica para talleres',
            type: 'tech_sheet',
            verifiedClaims: ['Apto para uso profesional'],
            textSnippet: 'Limpiador para superficies de talleres profesionales.'
          }
        ]
      },
      { idempotencyKey: 'review-concurrency-create', now: () => NOW }
    )
    const decision = { expectedVersion: generated.version, decision: 'approve' as const }
    const review = (idempotencyKey: string) =>
      reviewD1CatalogAiGeneration(f.database, ADMIN_CLAIMS, generated.id, decision, {
        idempotencyKey,
        now: () => NOW
      })
    const originalBatch = f.database.batch.bind(f.database)
    let arrivals = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(f.database, 'batch').mockImplementation(async (statements) => {
      arrivals++
      if (arrivals === 2) release()
      await barrier
      return originalBatch(statements)
    })
    const [first, replay] = await Promise.all([review('review-concurrency-key'), review('review-concurrency-key')])
    expect(replay).toEqual(first)
    await expect(review('review-concurrency-other-key')).rejects.toMatchObject({ code: 'concurrency_conflict' })
    expect(
      f.sqlite
        .prepare("SELECT count(*) AS n FROM catalog_ai_generation_commands WHERE action='human_review_decision'")
        .get()
    ).toEqual({ n: 1 })
  })

  it.each([
    ['review', 'same'],
    ['review', 'different'],
    ['review', 'conflicting'],
    ['apply', 'same'],
    ['apply', 'different'],
    ['apply', 'conflicting']
  ] as const)('commits concurrent %s commands with %s keys exactly once', async (operation, keys) => {
    let generation = await generateD1CatalogContent(
      f.database,
      OPERATOR_CLAIMS,
      {
        productName: 'Limpiador técnico',
        targetScope: 'description',
        prompt: 'Describir conforme a la ficha técnica',
        sources: [
          {
            id: 'concurrent-source',
            title: 'Ficha técnica',
            type: 'tech_sheet',
            verifiedClaims: ['Limpieza de superficies'],
            textSnippet: 'Limpiador de superficies profesionales.'
          }
        ]
      },
      { idempotencyKey: 'concurrent-create', now: () => NOW }
    )
    if (operation === 'apply')
      generation = await reviewD1CatalogAiGeneration(
        f.database,
        ADMIN_CLAIMS,
        generation.id,
        { expectedVersion: generation.version, decision: 'approve' },
        { idempotencyKey: 'concurrent-approval', now: () => NOW }
      )
    const originalBatch = f.database.batch.bind(f.database)
    let arrivals = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(f.database, 'batch').mockImplementation(async (statements) => {
      if (++arrivals === 2) release()
      await barrier
      return originalBatch(statements)
    })
    const run = (idempotencyKey: string, conflicting = false) =>
      operation === 'review'
        ? reviewD1CatalogAiGeneration(
            f.database,
            ADMIN_CLAIMS,
            generation.id,
            { expectedVersion: generation.version, decision: conflicting ? 'reject' : 'approve' },
            { idempotencyKey, now: () => NOW }
          )
        : applyD1CatalogAiGeneration(
            f.database,
            ADMIN_CLAIMS,
            generation.id,
            { expectedVersion: generation.version, targetProductId: conflicting ? 'p-1' : 'prod-desengrasante-1' },
            { idempotencyKey, now: () => NOW }
          )
    const outcomes = await Promise.allSettled([
      run('concurrent-a'),
      run(keys === 'different' ? 'concurrent-b' : 'concurrent-a', keys === 'conflicting')
    ])
    const successes = outcomes.filter((result) => result.status === 'fulfilled')
    const failures = outcomes.filter((result) => result.status === 'rejected')
    expect(successes).toHaveLength(keys === 'same' ? 2 : 1)
    if (keys === 'same') expect(successes[1]!.value).toEqual(successes[0]!.value)
    else
      expect(failures[0]!.reason).toMatchObject({
        code: keys === 'conflicting' ? 'idempotency_conflict' : 'concurrency_conflict'
      })
    expect(f.sqlite.prepare('SELECT version FROM catalog_ai_generations WHERE id=?').get(generation.id)).toEqual({
      version: generation.version + 1
    })
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM catalog_ai_generation_commands WHERE action=?')
        .get(operation === 'review' ? 'human_review_decision' : 'apply_to_product')
    ).toEqual({ n: 1 })
  })

  it('generates product content anchored in verifiable technical sources and marks as AI-generated', async () => {
    const input: GenerateCatalogContentInput = {
      productName: 'Decapante Químico para Pinturas Base Agua',
      targetScope: 'full_editorial',
      prompt: 'Generar descripción técnica y pautas de seguridad basadas en la ficha técnica del fabricante',
      sources: [
        {
          id: 'src-fds-01',
          title: 'Ficha de Datos de Seguridad Decapante FDS-704',
          type: 'fds',
          sdsNumber: 'SDS-ES-704-2026',
          verifiedClaims: [
            'Exento de cloruro de metileno',
            'pH neutro 6.8',
            'Tiempo de actuación entre 15 y 30 minutos',
            'Biodegradable según norma UNE-EN ISO 9408'
          ],
          textSnippet:
            'Decapante exento de disolventes clorados para eliminación de capas de pintura plástica y esmaltes sintéticos.'
        }
      ]
    }

    const generation = await generateD1CatalogContent(f.database, OPERATOR_CLAIMS, input, {
      idempotencyKey: 'idemp-cat-gen-1',
      now: () => NOW
    })

    expect(generation.id).toBeDefined()
    expect(generation.isAiGenerated).toBe(true)
    expect(generation.aiModelName).toContain('neteco')
    expect(generation.approvalStatus).toBe('pending_review')

    // Verifiable claims
    expect(generation.verifiableClaims.length).toBeGreaterThan(0)
    for (const claim of generation.verifiableClaims) {
      expect(claim.verified).toBe(true)
      expect(claim.sourceRef).toBe('src-fds-01')
    }

    // Generated fields
    expect(generation.generatedDescription).toContain('Exento de cloruro de metileno')
    expect(generation.generatedUsage).toContain('15 y 30 minutos')
    expect(generation.generatedAttributes).toBeDefined()
    expect(generation.generatedAttributes?.['pH']).toBeDefined()
  })

  it('detects duplicate catalog content against existing products', async () => {
    // Generate text almost identical to existing 'prod-desengrasante-1'
    const duplicateInput: GenerateCatalogContentInput = {
      productName: 'Desengrasante Alcalino Extra Fuerte Neteco Industrial',
      targetScope: 'description',
      prompt:
        'Desengrasante industrial potente para motores y suelos industriales alcalina concentrada de alta eficacia',
      sources: [
        {
          id: 'src-fds-02',
          title: 'Ficha técnica desengrasante',
          type: 'tech_sheet',
          verifiedClaims: ['Alta eficacia contra grasas pesadas'],
          textSnippet: 'Formula alcalina concentrada de alta eficacia contra grasas pesadas y residuos carbonosos.'
        }
      ]
    }

    const result = await generateD1CatalogContent(f.database, ADMIN_CLAIMS, duplicateInput, {
      idempotencyKey: 'idemp-duplicate-check',
      now: () => NOW
    })

    expect(result.duplicateCheck.maxSimilarityScore).toBeGreaterThan(0.4)
    expect(result.duplicateCheck.matchedProducts.length).toBeGreaterThan(0)
    expect(result.duplicateCheck.matchedProducts[0].productId).toBe('prod-desengrasante-1')
  })

  it('standalone duplicate check endpoint accurately evaluates similarity', async () => {
    const check = await checkD1CatalogDuplicates(
      f.database,
      'Desengrasante industrial potente para motores y suelos industriales',
      'Desengrasante Alcalino Extra Fuerte Neteco'
    )

    expect(check.matchedProducts.length).toBeGreaterThan(0)
    expect(check.maxSimilarityScore).toBeGreaterThan(0.4)
  })

  it('blocks applying unapproved or pending generated content to products', async () => {
    const input: GenerateCatalogContentInput = {
      productName: 'Limpiador Cristales Antivaho',
      targetScope: 'description',
      prompt: 'Limpiador de cristales industrial rápido',
      sources: [
        {
          id: 'src-tech-03',
          title: 'Especificaciones técnicas limpiacristales',
          type: 'specs',
          verifiedClaims: ['Secado rápido sin residuos', 'Alcohol isopropílico 15%'],
          textSnippet: 'Solución hidroalcohólica para limpieza de superficies acristaladas.'
        }
      ]
    }

    const gen = await generateD1CatalogContent(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-unapproved-apply',
      now: () => NOW
    })

    const applyInput: ApplyCatalogGenerationInput = {
      expectedVersion: gen.version,
      targetProductId: 'prod-desengrasante-1'
    }

    // Must fail because status is pending_review
    await expect(
      applyD1CatalogAiGeneration(f.database, ADMIN_CLAIMS, gen.id, applyInput, {
        idempotencyKey: 'idemp-apply-fail',
        now: () => NOW
      })
    ).rejects.toThrow(/not_approved|aprobad/i)
  })

  it('allows human review decision and subsequent application with CAS', async () => {
    const input: GenerateCatalogContentInput = {
      productName: 'Detergente Neutro Multisuperficies',
      targetScope: 'full_editorial',
      prompt: 'Generar ficha de producto neutro',
      sources: [
        {
          id: 'src-fds-04',
          title: 'FDS Detergente Neutro',
          type: 'fds',
          verifiedClaims: ['pH neutro 7.0', 'No daña mármol ni terrazo'],
          textSnippet: 'Limpiador concentrado con tensioactivos biodegradables para suelos delicados.'
        }
      ]
    }

    const gen = await generateD1CatalogContent(f.database, OPERATOR_CLAIMS, input, {
      idempotencyKey: 'idemp-human-review-ok',
      now: () => NOW
    })

    // Human approves with small editorial adjustment
    const reviewInput: ReviewCatalogGenerationInput = {
      expectedVersion: gen.version,
      decision: 'modify_and_approve',
      reviewNotes: 'Validado por responsable técnico de catálogo',
      modifiedContent: {
        shortDescription: 'Detergente neutro certificado para suelos delicados de mármol y terrazo.'
      }
    }

    const reviewed = await reviewD1CatalogAiGeneration(f.database, ADMIN_CLAIMS, gen.id, reviewInput, {
      idempotencyKey: 'idemp-review-decision',
      now: () => NOW
    })

    expect(reviewed.approvalStatus).toBe('modified_and_approved')
    expect(reviewed.humanReviewerId).toBe(ADMIN_CLAIMS.identityId)
    expect(reviewed.humanReviewedAt).toBe(NOW)

    // Apply to product
    const applyInput: ApplyCatalogGenerationInput = {
      expectedVersion: reviewed.version,
      targetProductId: 'prod-desengrasante-1'
    }

    const applied = await applyD1CatalogAiGeneration(f.database, ADMIN_CLAIMS, gen.id, applyInput, {
      idempotencyKey: 'idemp-apply-ok',
      now: () => NOW
    })

    expect(applied.applied).toBe(true)
    expect(applied.targetProductId).toBe('prod-desengrasante-1')
  })

  it('INT-7: applying to a missing product fails cleanly and leaves the generation untouched', async () => {
    const gen = await generateD1CatalogContent(
      f.database,
      OPERATOR_CLAIMS,
      {
        productName: 'Detergente Neutro Suelos',
        targetScope: 'description',
        prompt: 'Ficha de detergente neutro',
        sources: [
          {
            id: 'src-int7',
            title: 'FDS neutro',
            type: 'fds',
            verifiedClaims: ['pH neutro 7.0'],
            textSnippet: 'Limpiador concentrado con tensioactivos biodegradables.'
          }
        ]
      },
      { idempotencyKey: 'idemp-int7-gen', now: () => NOW }
    )
    const reviewed = await reviewD1CatalogAiGeneration(
      f.database,
      ADMIN_CLAIMS,
      gen.id,
      { expectedVersion: gen.version, decision: 'approve', reviewNotes: 'Revisado' },
      { idempotencyKey: 'idemp-int7-review', now: () => NOW }
    )
    await expect(
      applyD1CatalogAiGeneration(
        f.database,
        ADMIN_CLAIMS,
        gen.id,
        { expectedVersion: reviewed.version, targetProductId: 'no-such-product' },
        { idempotencyKey: 'idemp-int7-apply-missing', now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    const row = f.sqlite
      .prepare('SELECT version, applied_content_json AS applied FROM catalog_ai_generations WHERE id=?')
      .get(gen.id) as { version: number; applied: string | null }
    expect(row).toEqual({ version: reviewed.version, applied: null })
    const commands = f.sqlite
      .prepare("SELECT COUNT(*) AS n FROM catalog_ai_generation_commands WHERE action='apply_to_product'")
      .get() as { n: number }
    expect(commands.n).toBe(0)
  })

  it('rejects unauthorized actors without catalog permissions', async () => {
    const input: GenerateCatalogContentInput = {
      productName: 'Producto Sin Permisos',
      targetScope: 'description',
      prompt: 'Test prompt',
      sources: [
        {
          id: 'src-1',
          title: 'Doc',
          type: 'specs',
          verifiedClaims: ['Claim'],
          textSnippet: 'Snippet'
        }
      ]
    }

    await expect(
      generateD1CatalogContent(f.database, UNAUTHORIZED_CLAIMS, input, {
        idempotencyKey: 'idemp-cat-unauth',
        now: () => NOW
      })
    ).rejects.toThrow(/unauthorized|permisos/i)
  })

  it('guarantees append-only immutable commands in D1 trigger', async () => {
    const input: GenerateCatalogContentInput = {
      productName: 'Producto Inmutable',
      targetScope: 'description',
      prompt: 'Test trigger',
      sources: [
        {
          id: 'src-1',
          title: 'Doc',
          type: 'specs',
          verifiedClaims: ['Claim'],
          textSnippet: 'Snippet'
        }
      ]
    }

    await generateD1CatalogContent(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-cat-trigger',
      now: () => NOW
    })

    expect(() => {
      f.sqlite.exec("UPDATE catalog_ai_generation_commands SET action = 'tampered'")
    }).toThrow(/immutable/)

    expect(() => {
      f.sqlite.exec('DELETE FROM catalog_ai_generation_commands')
    }).toThrow(/immutable/)
  })

  it('rejects generation when technical sources provide no verified claims', async () => {
    const input: GenerateCatalogContentInput = {
      productName: 'Producto Sin Claims',
      targetScope: 'description',
      prompt: 'Generar ficha sin claims',
      sources: [
        {
          id: 'src-empty',
          title: 'Documento vacio de claims',
          type: 'tech_sheet',
          verifiedClaims: [],
          textSnippet: 'Texto descriptivo sin ningun claim verificado'
        }
      ]
    }

    await expect(
      generateD1CatalogContent(f.database, ADMIN_CLAIMS, input, {
        idempotencyKey: 'idemp-empty-claims',
        now: () => NOW
      })
    ).rejects.toThrow(/invalid_input|unverified_claims|at least 1/i)
  })

  it('handles reject review decision and CAS mismatch on review and apply', async () => {
    const input: GenerateCatalogContentInput = {
      productName: 'Limpiador Rechazable',
      targetScope: 'attributes',
      prompt: 'Generar atributos para rechazar',
      sources: [
        {
          id: 'src-1',
          title: 'Ficha',
          type: 'specs',
          verifiedClaims: ['pH 9.5'],
          textSnippet: 'Alcalino medio'
        }
      ]
    }

    const gen = await generateD1CatalogContent(f.database, OPERATOR_CLAIMS, input, {
      idempotencyKey: 'idemp-reject-review-test',
      now: () => NOW
    })

    // CAS conflict on review
    const invalidCasReview: ReviewCatalogGenerationInput = {
      expectedVersion: 99,
      decision: 'reject',
      reviewNotes: 'Version incorrecta'
    }

    await expect(
      reviewD1CatalogAiGeneration(f.database, ADMIN_CLAIMS, gen.id, invalidCasReview, {
        idempotencyKey: 'idemp-cas-fail-rev',
        now: () => NOW
      })
    ).rejects.toThrow(/concurrency_conflict|versión/i)

    // Valid reject
    const validReject: ReviewCatalogGenerationInput = {
      expectedVersion: gen.version,
      decision: 'reject',
      reviewNotes: 'No cumple con la directiva europea de etiquetado'
    }

    const rejected = await reviewD1CatalogAiGeneration(f.database, ADMIN_CLAIMS, gen.id, validReject, {
      idempotencyKey: 'idemp-valid-reject-rev',
      now: () => NOW
    })

    expect(rejected.approvalStatus).toBe('rejected')
    expect(rejected.reviewNotes).toContain('directiva europea')

    // Cannot apply rejected generation
    const applyInput: ApplyCatalogGenerationInput = {
      expectedVersion: rejected.version,
      targetProductId: 'prod-desengrasante-1'
    }

    await expect(
      applyD1CatalogAiGeneration(f.database, ADMIN_CLAIMS, gen.id, applyInput, {
        idempotencyKey: 'idemp-apply-rejected-fail',
        now: () => NOW
      })
    ).rejects.toThrow(/not_approved|aprobad/i)
  })

  it('reads and lists catalog generations with filtering and handles not found', async () => {
    const input: GenerateCatalogContentInput = {
      productName: 'Producto Para Lectura y Listado',
      targetScope: 'description',
      prompt: 'Generar para leer y listar',
      sources: [
        {
          id: 'src-list',
          title: 'Doc List',
          type: 'tech_sheet',
          verifiedClaims: ['Eficacia 100% probada'],
          textSnippet: 'Snippet list'
        }
      ]
    }

    const gen = await generateD1CatalogContent(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-read-list-cat',
      now: () => NOW
    })

    const read = await readD1CatalogAiGeneration(f.database, ADMIN_CLAIMS, gen.id)
    expect(read.id).toBe(gen.id)
    expect(read.productName || read.generatedTitle).toBeDefined()

    const list = await listD1CatalogAiGenerations(f.database, ADMIN_CLAIMS, { status: 'pending_review' })
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list.some((item) => item.id === gen.id)).toBe(true)

    // Not found
    await expect(readD1CatalogAiGeneration(f.database, ADMIN_CLAIMS, 'gen-non-existent-999999999999')).rejects.toThrow(
      /not_found|no encontrada/i
    )
  })

  it('enforces idempotency on catalog content generation', async () => {
    const input: GenerateCatalogContentInput = {
      productName: 'Producto Idempotente',
      targetScope: 'description',
      prompt: 'Generar con idempotencia',
      sources: [
        {
          id: 'src-idemp',
          title: 'Doc Idemp',
          type: 'specs',
          verifiedClaims: ['Claim Idemp'],
          textSnippet: 'Snippet Idemp'
        }
      ]
    }

    const first = await generateD1CatalogContent(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-key-cat-replay',
      now: () => NOW
    })

    const replay = await generateD1CatalogContent(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-key-cat-replay',
      now: () => NOW
    })

    expect(replay.id).toBe(first.id)

    // Conflict
    const conflictingInput: GenerateCatalogContentInput = {
      ...input,
      productName: 'Nombre completamente diferente'
    }

    await expect(
      generateD1CatalogContent(f.database, ADMIN_CLAIMS, conflictingInput, {
        idempotencyKey: 'idemp-key-cat-replay',
        now: () => NOW
      })
    ).rejects.toThrow(/idempotency_conflict|clave/i)
  })
})
