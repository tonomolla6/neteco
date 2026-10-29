import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aiTestFixture,
  ADMIN_CLAIMS,
  OPERATOR_CLAIMS,
  UNAUTHORIZED_CLAIMS
} from './d1-ai-test-fixture'
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
      prompt: 'Desengrasante industrial potente para motores y suelos industriales alcalina concentrada de alta eficacia',
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
})
