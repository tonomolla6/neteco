import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffContentDocuments, type ContentDocumentSnapshot } from '../../shared/cms-preview-comparison'
import {
  createBaTestWorld,
  ADMIN_IDENTITY,
  CONTENT_MGR_IDENTITY,
  UNPRIVILEGED_IDENTITY,
  FIXTURE_NOW,
  type BaTestWorld
} from './d1-ba-preview-diff-fixtures'
import {
  compareCmsPreviewVersions,
  executeTemplateVisualRegressionCheck,
  getTemplateVisualBaselines,
  PreviewComparisonError
} from '../../workers/cms/preview-comparison'

describe('ADM-024: Visual preview comparison & automated regression for critical templates', () => {
  let world: BaTestWorld
  const PAGE_ID = '40000000-0000-4000-8000-000000000001'
  const V1_ID = '50000000-0000-4000-8000-000000000001'
  const V2_ID = '50000000-0000-4000-8000-000000000002'

  beforeEach(async () => {
    world = await createBaTestWorld()

    // Insert CMS test page with draft_version = 0 first to satisfy circular FK constraint
    world.sqlite.exec(`
      INSERT INTO content_pages (id, slug, title, status, page_version, draft_version, draft_version_id, created_by, created_at, updated_at)
      VALUES ('${PAGE_ID}', 'desengrasante-industrial-ecologico', 'Desengrasante Industrial Ecológico', 'draft', 1, 0, NULL, '${CONTENT_MGR_IDENTITY}', '${FIXTURE_NOW}', '${FIXTURE_NOW}');

      INSERT INTO content_versions (id, page_id, version, document, based_on_id, created_by, created_at)
      VALUES
        ('${V1_ID}', '${PAGE_ID}', 1, json('${JSON.stringify({
          title: 'Desengrasante Industrial Ecológico',
          slug: 'desengrasante-industrial-ecologico',
          seo: {
            title: 'Desengrasante Industrial Ecológico | Neteco',
            description: 'Limpieza pesada sin fosfatos',
            noindex: false
          },
          changeSummary: 'Versión inicial aprobada',
          blocks: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              type: 'heading',
              level: 'h2',
              text: 'Eficacia profesional sostenible'
            },
            {
              id: '22222222-2222-4222-8222-222222222222',
              type: 'paragraph',
              text: 'Formulado para talleres y cocinas industriales.'
            },
            {
              id: '33333333-3333-4333-8333-333333333333',
              type: 'cta',
              label: 'Comprar formato 5L',
              href: '/producto/desengrasante-5l'
            }
          ]
        })}'), NULL, '${CONTENT_MGR_IDENTITY}', '${FIXTURE_NOW}'),

        ('${V2_ID}', '${PAGE_ID}', 2, json('${JSON.stringify({
          title: 'Desengrasante Industrial Ecológico ULTRA',
          slug: 'desengrasante-industrial-ecologico',
          seo: {
            title: 'Desengrasante Industrial ULTRA Ecológico | Neteco',
            description: 'Nueva fórmula certificada Ecolabel',
            noindex: false
          },
          changeSummary: 'Añadido bloque de certificación y nuevo botón de muestra gratuita',
          blocks: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              type: 'heading',
              level: 'h2',
              text: 'Eficacia profesional certificada Ecolabel'
            },
            {
              id: '22222222-2222-4222-8222-222222222222',
              type: 'paragraph',
              text: 'Formulado para talleres y cocinas industriales sin residuos.'
            },
            {
              id: '44444444-4444-4444-8444-444444444444',
              type: 'callout',
              tone: 'success',
              title: 'Certificación ISO 14001',
              text: 'Biodegradable en 28 días según norma OCDE.'
            },
            {
              id: '33333333-3333-4333-8333-333333333333',
              type: 'cta',
              label: 'Comprar formato 5L o 25L',
              href: '/producto/desengrasante-5l'
            }
          ]
        })}'), '${V1_ID}', '${CONTENT_MGR_IDENTITY}', '${FIXTURE_NOW}');

      UPDATE content_pages
      SET page_version = 2, draft_version = 2, draft_version_id = '${V2_ID}', title = 'Desengrasante Industrial Ecológico ULTRA'
      WHERE id = '${PAGE_ID}';
    `)
  })

  afterEach(() => world.close())

  describe('diffContentDocuments unit diff calculation', () => {
    it('detects added, modified and removed blocks accurately', () => {
      const docA: ContentDocumentSnapshot = {
        title: 'Original Title',
        slug: 'original-slug',
        seo: { title: 'Original SEO', description: 'Desc A', noindex: false },
        changeSummary: 'Init',
        blocks: [
          { id: 'b1', type: 'heading', level: 'h2', text: 'Heading 1' },
          { id: 'b2', type: 'paragraph', text: 'Para 1' },
          { id: 'b3', type: 'cta', label: 'Buy', href: '/buy' }
        ]
      }

      const docB: ContentDocumentSnapshot = {
        title: 'Modified Title',
        slug: 'original-slug',
        seo: { title: 'Original SEO', description: 'Desc Updated', noindex: true },
        changeSummary: 'Update',
        blocks: [
          { id: 'b1', type: 'heading', level: 'h3', text: 'Heading 1 Modified' }, // modified
          // b2 removed
          { id: 'b4', type: 'callout', tone: 'warning', title: 'Notice', text: 'New block' }, // added
          { id: 'b3', type: 'cta', label: 'Buy Now', href: '/buy-now' } // modified
        ]
      }

      const diff = diffContentDocuments(docA, docB)

      expect(diff.hasChanges).toBe(true)
      expect(diff.metadataDiff.titleChanged).toBe(true)
      expect(diff.metadataDiff.oldTitle).toBe('Original Title')
      expect(diff.metadataDiff.newTitle).toBe('Modified Title')
      expect(diff.metadataDiff.seoChanged).toBe(true)
      expect(diff.metadataDiff.noindexChanged).toBe(true)

      expect(diff.summary.addedBlocksCount).toBe(1)
      expect(diff.summary.removedBlocksCount).toBe(1)
      expect(diff.summary.modifiedBlocksCount).toBe(2)
      expect(diff.summary.unchangedBlocksCount).toBe(0)

      const added = diff.blockDiffs.find((b) => b.changeType === 'added')
      expect(added?.newBlock?.id).toBe('b4')

      const removed = diff.blockDiffs.find((b) => b.changeType === 'removed')
      expect(removed?.oldBlock?.id).toBe('b2')

      const modified = diff.blockDiffs.filter((b) => b.changeType === 'modified')
      expect(modified.length).toBe(2)
    })

    it('returns hasChanges=false when documents are identical', () => {
      const doc: ContentDocumentSnapshot = {
        title: 'Stable Page',
        slug: 'stable-page',
        seo: { title: 'SEO Title', description: 'SEO Desc', noindex: false },
        changeSummary: 'No change',
        blocks: [{ id: 'b1', type: 'paragraph', text: 'Clean text.' }]
      }
      const diff = diffContentDocuments(doc, doc)
      expect(diff.hasChanges).toBe(false)
      expect(diff.summary.addedBlocksCount).toBe(0)
      expect(diff.summary.removedBlocksCount).toBe(0)
      expect(diff.summary.modifiedBlocksCount).toBe(0)
      expect(diff.summary.unchangedBlocksCount).toBe(1)
    })
  })

  describe('compareCmsPreviewVersions worker', () => {
    it('compares version 1 and version 2 with responsive breakpoints and visual viewport specs', async () => {
      const result = await compareCmsPreviewVersions(world.db, {
        actorId: CONTENT_MGR_IDENTITY,
        pageId: PAGE_ID,
        baseVersion: 1,
        compareVersion: 2,
        now: FIXTURE_NOW
      })

      expect(result.pageId).toBe(PAGE_ID)
      expect(result.baseVersion).toBe(1)
      expect(result.compareVersion).toBe(2)
      expect(result.diff.hasChanges).toBe(true)
      expect(result.diff.summary.addedBlocksCount).toBe(1)
      expect(result.diff.summary.modifiedBlocksCount).toBe(3)

      // Breakpoints supported
      expect(result.breakpoints).toHaveProperty('mobile')
      expect(result.breakpoints).toHaveProperty('tablet')
      expect(result.breakpoints).toHaveProperty('desktop')
      expect(result.breakpoints.mobile.width).toBe(375)
      expect(result.breakpoints.tablet.width).toBe(768)
      expect(result.breakpoints.desktop.width).toBe(1280)
    })

    it('denies access to actor without content.preview or administration.manage permission', async () => {
      await expect(
        compareCmsPreviewVersions(world.db, {
          actorId: UNPRIVILEGED_IDENTITY,
          pageId: PAGE_ID,
          baseVersion: 1,
          compareVersion: 2,
          now: FIXTURE_NOW
        })
      ).rejects.toThrow(PreviewComparisonError)
    })

    it('throws not_found if the page or version does not exist', async () => {
      await expect(
        compareCmsPreviewVersions(world.db, {
          actorId: ADMIN_IDENTITY,
          pageId: '99999999-9999-4999-8999-999999999999',
          baseVersion: 1,
          compareVersion: 2,
          now: FIXTURE_NOW
        })
      ).rejects.toThrow('page_not_found')
    })
  })

  describe('Critical templates automated visual regression suite', () => {
    it('loads baselines and validates template visual regression across breakpoints', async () => {
      // Seed a template baseline
      world.sqlite.exec(`
        INSERT INTO cms_template_visual_baselines (
          id, template_name, breakpoint, dom_structure_hash, critical_selectors_json, status, version, created_at, updated_at
        ) VALUES (
          '70000000-0000-4000-8000-000000000001',
          'home',
          'desktop',
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          json('["header", "nav.main", "section.hero", "section.featured-products", "footer"]'),
          'active',
          1,
          '${FIXTURE_NOW}',
          '${FIXTURE_NOW}'
        );
      `)

      const baselines = await getTemplateVisualBaselines(world.db, 'home')
      expect(baselines.length).toBeGreaterThan(0)
      expect(baselines[0].templateName).toBe('home')
      expect(baselines[0].breakpoint).toBe('desktop')

      // Run visual regression check with valid matching DOM selectors
      const checkResult = await executeTemplateVisualRegressionCheck(world.db, {
        actorId: ADMIN_IDENTITY,
        templateName: 'home',
        breakpoint: 'desktop',
        renderedSelectors: ['header', 'nav.main', 'section.hero', 'section.featured-products', 'footer'],
        now: FIXTURE_NOW
      })

      expect(checkResult.passed).toBe(true)
      expect(checkResult.missingCriticalSelectors).toEqual([])

      // Run with missing critical selectors (regression detected!)
      const failedCheck = await executeTemplateVisualRegressionCheck(world.db, {
        actorId: ADMIN_IDENTITY,
        templateName: 'home',
        breakpoint: 'desktop',
        renderedSelectors: ['header', 'footer'], // missing hero and products!
        now: FIXTURE_NOW
      })

      expect(failedCheck.passed).toBe(false)
      expect(failedCheck.missingCriticalSelectors).toContain('section.hero')
      expect(failedCheck.missingCriticalSelectors).toContain('section.featured-products')
    })
  })
})
