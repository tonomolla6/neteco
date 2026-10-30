import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    f.sqlite.close()
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

    const gen = await generateD1CatalogContent(f.database, ADMIN_CLAIMS, input, {
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
      ADMIN_CLAIMS,
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

    const gen = await generateD1CatalogContent(f.database, ADMIN_CLAIMS, input, {
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
