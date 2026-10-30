import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { CampaignDocument, SaveDraftInput } from '../../shared/campaign-pipeline'
import {
  evaluateCampaignAccessibility,
  evaluateCampaignPerformance,
  publishCampaignNow,
  qaSignoffCampaign,
  renderCampaignPreview,
  rollbackCampaignPublication,
  runCampaignChecks,
  saveCampaignDraft,
  scheduleCampaignPublication
} from '../../workers/cms/campaign-pipeline'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const QA_ID = '10000000-0000-4000-8000-000000000005'

async function setupDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0134_release_gates_progressive_rollout_policy_campaigns.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO identities (id, email, password_hash, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@example.invalid', 'hash', 'active', '${NOW}', '${NOW}'),
      ('${QA_ID}', 'qa@example.invalid', 'hash', 'active', '${NOW}', '${NOW}');
  `)
  return sqlite
}

const OPTIMIZED_DOCUMENT: CampaignDocument = {
  headline: 'Campaña Limpieza Industrial Otoño 2026',
  metaDescription: 'Descubre los mejores desengrasantes y desinfectantes para automoción e industria.',
  sections: [
    {
      id: 'hero-sec-1',
      type: 'hero_banner',
      heading: 'Desengrasantes Profesionales al 20% Dto',
      headingLevel: 'h1',
      body: 'Gama completa de productos químicos para talleres e industrias.',
      ctaText: 'Ver catálogo',
      ctaUrl: '/catalogo/desengrasantes',
      ctaAriaLabel: 'Ver catálogo de desengrasantes profesionales',
      imageUrl: 'https://cdn.neteco.es/campaigns/hero-autumn.webp',
      imageAlt: 'Bidones de desengrasante químico industrial en almacén',
      imageWidth: 1200,
      imageHeight: 600,
      imageFormat: 'webp',
      imageBytesEstimate: 85000,
      theme: { textColor: '#ffffff', backgroundColor: '#0f172a' }
    },
    {
      id: 'grid-sec-2',
      type: 'product_grid',
      heading: 'Productos destacados de la campaña',
      headingLevel: 'h2',
      body: 'Formatos de 5L y 25L con homologación CE.',
      ctaText: 'Comprar lote',
      ctaUrl: '/catalogo/lotes-quimicos',
      ctaAriaLabel: 'Comprar lote con descuento de campaña',
      imageUrl: 'https://cdn.neteco.es/campaigns/pack-eco.webp',
      imageAlt: 'Pack de desinfección homologado',
      imageWidth: 600,
      imageHeight: 400,
      imageFormat: 'webp',
      imageBytesEstimate: 42000,
      theme: { textColor: '#0f172a', backgroundColor: '#f8fafc' }
    }
  ]
}

describe('CIC-031: Pipeline de campañas/contenido independiente y seguro', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('permite previsualizar el contenido sin desplegar código', async () => {
    const input: SaveDraftInput = {
      commandId: 'cmd-cmp-01',
      campaignSlug: 'otono-industrial-2026',
      title: 'Campaña Otoño 2026',
      document: OPTIMIZED_DOCUMENT
    }

    const draft = await saveCampaignDraft(db, input, ADMIN_ID, NOW)
    expect(draft.status).toBe('draft')
    expect(draft.currentVersion).toBe(1)

    // Renderizado preview independiente
    const preview = renderCampaignPreview(draft.document, { previewMode: true, draftVersion: 1 })
    expect(preview.html).toContain('Desengrasantes Profesionales al 20% Dto')
    expect(preview.html).toContain('alt="Bidones de desengrasante químico industrial en almacén"')
    expect(preview.meta.headline).toBe('Campaña Limpieza Industrial Otoño 2026')
    expect(preview.previewBanner).toBe(true)
  })

  it('evalúa rendimiento de imágenes y assets bloqueando versiones degradadas', () => {
    const heavyDocument: CampaignDocument = {
      headline: 'Campaña Pesada',
      metaDescription: 'Prueba con imágenes sin optimizar y pesos desmedidos.',
      sections: [
        {
          id: 'bad-hero',
          type: 'hero_banner',
          heading: 'Banner gigante',
          headingLevel: 'h1',
          imageUrl: 'https://cdn.neteco.es/raw/heavy.png',
          imageAlt: 'Imagen no optimizada',
          imageFormat: 'png',
          imageBytesEstimate: 850000 // 850 KB: muy pesado
          // Faltan width y height
        }
      ]
    }

    const perf = evaluateCampaignPerformance(heavyDocument)
    expect(perf.passed).toBe(false)
    expect(perf.score).toBeLessThan(80)
    expect(perf.violations.some((v) => v.code === 'image_too_heavy')).toBe(true)
    expect(perf.violations.some((v) => v.code === 'missing_dimensions')).toBe(true)

    const goodPerf = evaluateCampaignPerformance(OPTIMIZED_DOCUMENT)
    expect(goodPerf.passed).toBe(true)
    expect(goodPerf.score).toBeGreaterThanOrEqual(90)
  })

  it('evalúa accesibilidad bloqueando textos alt ausentes y botones sin descripción', () => {
    const inaccessibleDocument: CampaignDocument = {
      headline: 'Campaña Inaccesible',
      metaDescription: 'Sin descripciones de imagen ni contraste.',
      sections: [
        {
          id: 'bad-a11y-sec',
          type: 'hero_banner',
          heading: 'Banner sin accesibilidad',
          headingLevel: 'h4', // Salto de jerarquía
          imageUrl: 'https://cdn.neteco.es/img1.webp',
          imageAlt: '', // Error crítico: alt vacío
          ctaText: 'X',
          ctaUrl: '/comprar'
          // Falta ctaAriaLabel y ctaText no es descriptivo
        }
      ]
    }

    const a11y = evaluateCampaignAccessibility(inaccessibleDocument)
    expect(a11y.passed).toBe(false)
    expect(a11y.violations.some((v) => v.code === 'missing_image_alt')).toBe(true)

    const goodA11y = evaluateCampaignAccessibility(OPTIMIZED_DOCUMENT)
    expect(goodA11y.passed).toBe(true)
    expect(goodA11y.score).toBe(100)
  })

  it('bloquea aprobación QA si no se han superado los checks de rendimiento y accesibilidad', async () => {
    const input: SaveDraftInput = {
      commandId: 'cmd-cmp-02',
      campaignSlug: 'test-qa-gate',
      title: 'Test QA Gate',
      document: OPTIMIZED_DOCUMENT
    }

    const draft = await saveCampaignDraft(db, input, ADMIN_ID, NOW)

    // Intento de QA signoff directo sin haber corrido los checks
    await expect(
      qaSignoffCampaign(
        db,
        { commandId: 'cmd-qa-premature', pipelineId: draft.id, expectedVersion: 1, notes: 'Aprobado sin checks' },
        QA_ID,
        NOW
      )
    ).rejects.toThrow(expect.objectContaining({ code: 'qa_checks_unmet' }))

    // Ejecución de checks
    const checks = await runCampaignChecks(
      db,
      { commandId: 'cmd-run-chk', pipelineId: draft.id, expectedVersion: 1 },
      ADMIN_ID,
      NOW
    )
    expect(checks.performancePassed).toBe(true)
    expect(checks.accessibilityPassed).toBe(true)

    // Ahora QA signoff tiene éxito y pasa a qa_approved
    const approved = await qaSignoffCampaign(
      db,
      { commandId: 'cmd-qa-valid', pipelineId: draft.id, expectedVersion: 1, notes: 'Validado por QA editorial' },
      QA_ID,
      NOW
    )
    expect(approved.status).toBe('qa_approved')
  })

  it('permite programar (schedule), publicar y hacer rollback sin despliegue de código', async () => {
    const input: SaveDraftInput = {
      commandId: 'cmd-cmp-03',
      campaignSlug: 'black-friday-quimica',
      title: 'Black Friday Química',
      document: OPTIMIZED_DOCUMENT
    }

    const draft = await saveCampaignDraft(db, input, ADMIN_ID, NOW)
    await runCampaignChecks(db, { commandId: 'cmd-chk-3', pipelineId: draft.id, expectedVersion: 1 }, ADMIN_ID, NOW)
    const approved = await qaSignoffCampaign(
      db,
      { commandId: 'cmd-qa-3', pipelineId: draft.id, expectedVersion: 1, notes: 'Listo' },
      QA_ID,
      NOW
    )

    // 1. Programación de publicación
    const scheduled = await scheduleCampaignPublication(
      db,
      {
        commandId: 'cmd-sched-01',
        pipelineId: draft.id,
        expectedVersion: approved.version,
        publishAt: '2026-11-20T00:00:00Z',
        unpublishAt: '2026-11-30T23:59:59Z'
      },
      ADMIN_ID,
      NOW
    )
    expect(scheduled.status).toBe('scheduled')
    expect(scheduled.publishAt).toBe('2026-11-20T00:00:00Z')

    // 2. Publicación directa sin deploy
    const published = await publishCampaignNow(
      db,
      { commandId: 'cmd-pub-now', pipelineId: draft.id, expectedVersion: scheduled.version },
      ADMIN_ID,
      NOW
    )
    expect(published.status).toBe('published')
    expect(published.publishedVersion).toBe(1)

    // 3. Modificación a borrador versión 2
    const draftV2 = await saveCampaignDraft(
      db,
      {
        commandId: 'cmd-draft-v2',
        campaignSlug: 'black-friday-quimica',
        title: 'Black Friday Química v2',
        document: {
          ...OPTIMIZED_DOCUMENT,
          headline: 'Campaña con cambio imprevisto'
        }
      },
      ADMIN_ID,
      NOW
    )
    expect(draftV2.currentVersion).toBe(2)
    await runCampaignChecks(
      db,
      { commandId: 'cmd-chk-v2', pipelineId: draft.id, expectedVersion: draftV2.version },
      ADMIN_ID,
      NOW
    )
    const approvedV2 = await qaSignoffCampaign(
      db,
      { commandId: 'cmd-qa-v2', pipelineId: draft.id, expectedVersion: draftV2.version, notes: 'V2 ok' },
      QA_ID,
      NOW
    )
    const publishedV2 = await publishCampaignNow(
      db,
      { commandId: 'cmd-pub-v2', pipelineId: draft.id, expectedVersion: approvedV2.version },
      ADMIN_ID,
      NOW
    )
    expect(publishedV2.publishedVersion).toBe(2)
    expect(publishedV2.previousPublishedVersion).toBe(1)

    // 4. Rollback instantáneo sin desplegar código
    const rolledBack = await rollbackCampaignPublication(
      db,
      {
        commandId: 'cmd-rb-cmp',
        pipelineId: draft.id,
        expectedVersion: publishedV2.version,
        reason: 'Error en precio del lote anunciado'
      },
      ADMIN_ID,
      NOW
    )
    expect(rolledBack.status).toBe('rolled_back')
    expect(rolledBack.publishedVersion).toBe(1) // Revertido a la versión 1
  })
})
