import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { CMS_CLAIMS, cmsDocument, cmsUtc } from './d1-cms-fixture'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
import { testUuid } from '../support/deterministic'
export const editorial = (extra: Record<string, unknown> = {}) => ({
  kind: 'article',
  category: { slug: 'limpieza-profesional', label: 'Limpieza profesional' },
  author: { name: 'Autora sintética', experience: 'Experiencia editorial sintética, exclusivamente para pruebas.' },
  reviewedAt: cmsUtc(-60000),
  reviewDueAt: cmsUtc(86400000),
  pillarSlug: null,
  relatedProducts: [],
  relatedCategories: [],
  relatedResources: [],
  ...extra
})
export async function resourceHubFixture() {
  const f = await cmsPublicationFixture()
  async function resource(extra: Record<string, unknown> = {}, published = true) {
    const receipt = await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'create_draft',
      {},
      {
        ...cmsDocument({ slug: `recurso-${testUuid()}`, resourceHub: editorial(), ...extra }),
        expectedVersion: 0
      },
      { idempotencyKey: testUuid() }
    )
    if (published)
      await executeCmsPublicationCommand(
        f.deps,
        CMS_CLAIMS,
        receipt.pageId,
        {
          action: 'publish',
          expectedRevision: 0,
          expectedVersion: 1,
          versionId: receipt.versionId,
          reason: 'Revisión editorial sintética, no aprobación de contenido real'
        },
        testUuid()
      )
    return receipt
  }
  return { ...f, resource }
}
