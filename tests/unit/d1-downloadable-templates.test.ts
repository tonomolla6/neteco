import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  createDownloadableTemplate,
  updateDownloadableTemplate,
  publishDownloadableTemplate,
  getDownloadableTemplateBySlug,
  listDownloadableTemplates,
  generateTemplateAccessiblePdf,
  DownloadableTemplateError
} from '../../workers/content/downloadable-templates'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000019',
  sessionId: '20000000-0000-4000-8000-000000000019',
  sessionVersion: 1
}

const GUEST_CLAIMS: VerifiedSessionClaims = {
  identityId: '90000000-0000-4000-8000-000000000019',
  sessionId: '91000000-0000-4000-8000-000000000019',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'
const REVIEW_DUE = '2027-10-29T12:00:00Z'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0141_templates_brand_warehouse_adr.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador'),
      ('guest', 'Invitado', 'Sin permisos');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general'),
      ('catalog.publish', 'catalog', 'publish', 'Publicar catálogo/contenido');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'catalog.publish');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin-templates@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${GUEST_CLAIMS.identityId}', 'guest@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_CLAIMS.identityId}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z'),
      ('${GUEST_CLAIMS.sessionId}', '${GUEST_CLAIMS.identityId}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin', '${NOW}'),
      ('${GUEST_CLAIMS.identityId}', 'guest', '${NOW}');
  `)
  return sqlite
}

describe('MED-019: Biblioteca de plantillas descargables (D1 Core)', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('creates, publishes and retrieves an indexable checklist template with versioning', async () => {
    const templateInput = {
      commandId: 'a1000000-0000-4000-8000-000000000001',
      slug: 'checklist-limpieza-desinfeccion-cocinas',
      title: 'Checklist de Limpieza y Desinfección en Cocinas Centrales (APPCC)',
      description: 'Protocolo de autocontrol higiénico sanitario según normativa APPCC para hostelería.',
      templateType: 'checklist' as const,
      category: 'hosteleria' as const,
      targetAudience: 'Responsables de calidad, jefes de cocina y personal de limpieza profesional',
      sections: [
        {
          id: 'zona-coccion',
          title: 'Zona de Cocción y Campanas Extractoras',
          description: 'Puntos críticos de control en planchas, freidoras y filtros.',
          items: [
            {
              id: 'item-desengrase-planchas',
              label: 'Desengrase en caliente con desengrasante alcalino certificado UNE-EN 13697',
              mandatory: true,
              frequency: 'diaria' as const,
              criticalControlPoint: true
            },
            {
              id: 'item-aclarado-potable',
              label: 'Aclarado con agua potable y verificación de ausencia de residuo químico',
              mandatory: true,
              frequency: 'diaria' as const,
              criticalControlPoint: true
            }
          ]
        }
      ],
      reviewedAt: NOW,
      reviewDueAt: REVIEW_DUE
    }

    // 1. Create template
    const created = await createDownloadableTemplate(db, ADMIN_CLAIMS, templateInput, NOW)
    expect(created.id).toBeDefined()
    expect(created.slug).toBe('checklist-limpieza-desinfeccion-cocinas')
    expect(created.status).toBe('draft')
    expect(created.version).toBe(1)
    expect(created.canonicalPath).toBe('/plantillas/checklist-limpieza-desinfeccion-cocinas')
    expect(created.downloadUrl).toBe('/api/templates/checklist-limpieza-desinfeccion-cocinas/pdf')

    // 2. Publish template
    const published = await publishDownloadableTemplate(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'a1000000-0000-4000-8000-000000000002',
        templateId: created.id,
        expectedVersion: 1
      },
      NOW
    )
    expect(published.status).toBe('published')
    expect(published.version).toBe(2)
    expect(published.publishedAt).toBe(NOW)
    expect(published.indexable).toBe(true)

    // 3. Query public detail
    const retrieved = await getDownloadableTemplateBySlug(db, 'checklist-limpieza-desinfeccion-cocinas')
    expect(retrieved).not.toBeNull()
    expect(retrieved?.title).toBe(templateInput.title)
    expect(retrieved?.sections[0]?.items).toHaveLength(2)
    expect(retrieved?.indexable).toBe(true)

    // 4. List templates
    const list = await listDownloadableTemplates(db, {
      q: 'APPCC',
      category: 'hosteleria',
      page: 1,
      perPage: 10
    })
    expect(list.total).toBe(1)
    expect(list.items[0]?.slug).toBe('checklist-limpieza-desinfeccion-cocinas')
    expect(list.items[0]?.itemCount).toBe(2)
  })

  it('rejects creation when user does not have permission', async () => {
    await expect(
      createDownloadableTemplate(
        db,
        GUEST_CLAIMS,
        {
          commandId: 'a1000000-0000-4000-8000-000000000003',
          slug: 'plan-dosificacion-lavanderia',
          title: 'Plan de Dosificación de Lavandería Industrial',
          description: 'Control de gasto y dosificación de blanqueantes y desinfectantes.',
          templateType: 'plan',
          category: 'lavanderia',
          targetAudience: 'Operarios de lavandería',
          sections: [
            {
              id: 'fase-prelavado',
              title: 'Prelavado',
              items: [{ id: 'item-1', label: 'Dosificar a 40°C', mandatory: true }]
            }
          ],
          reviewedAt: NOW,
          reviewDueAt: REVIEW_DUE
        },
        NOW
      )
    ).rejects.toThrow(DownloadableTemplateError)
  })

  it('enforces CAS version check on updates and rejects stale version update', async () => {
    const created = await createDownloadableTemplate(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'a1000000-0000-4000-8000-000000000004',
        slug: 'guia-compatibilidad-quimica',
        title: 'Guía de Compatibilidad Química y Almacenamiento Seguro',
        description: 'Matriz de segregación para evitar mezclas peligrosas.',
        templateType: 'guide',
        category: 'industria',
        targetAudience: 'Responsables de almacén y PRL',
        sections: [
          {
            id: 'segregacion-acidos-bases',
            title: 'Segregación Ácidos y Bases',
            items: [
              { id: 'item-seg-1', label: 'Separación física mínima 3 metros o cubeto independiente', mandatory: true }
            ]
          }
        ],
        reviewedAt: NOW,
        reviewDueAt: REVIEW_DUE
      },
      NOW
    )

    // Valid update with expectedVersion = 1
    const updated = await updateDownloadableTemplate(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'a1000000-0000-4000-8000-000000000005',
        templateId: created.id,
        expectedVersion: 1,
        title: 'Guía Avanzada de Compatibilidad Química y Almacenamiento Seguro (ADR/APQ)',
        description: 'Matriz de segregación actualizada conforme a APQ-6 y APQ-7.',
        sections: created.sections,
        reviewedAt: NOW,
        reviewDueAt: REVIEW_DUE
      },
      NOW
    )
    expect(updated.version).toBe(2)

    // Stale update with expectedVersion = 1 fails with version conflict
    await expect(
      updateDownloadableTemplate(
        db,
        ADMIN_CLAIMS,
        {
          commandId: 'a1000000-0000-4000-8000-000000000006',
          templateId: created.id,
          expectedVersion: 1,
          title: 'Intento de actualización con versión obsoleta',
          description: 'Debe fallar por versión vieja.',
          sections: created.sections,
          reviewedAt: NOW,
          reviewDueAt: REVIEW_DUE
        },
        NOW
      )
    ).rejects.toThrow(DownloadableTemplateError)
  })

  it('generates an accessible PDF stream with valid PDF structure and headers', async () => {
    const template = await createDownloadableTemplate(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'a1000000-0000-4000-8000-000000000007',
        slug: 'checklist-auditoria-sanitaria',
        title: 'Checklist de Auditoría Previa a Inspección Sanitaria',
        description: 'Revisión preventiva de registros de temperatura, biocidas y fichas técnicas.',
        templateType: 'checklist',
        category: 'sanitario',
        targetAudience: 'Directores higiénico-sanitarios',
        sections: [
          {
            id: 'registros-l-d',
            title: 'Registros Obligatorios L+D',
            items: [{ id: 'item-reg-1', label: 'Libro de registro de biocidas actualizado y firmado', mandatory: true }]
          }
        ],
        reviewedAt: NOW,
        reviewDueAt: REVIEW_DUE
      },
      NOW
    )

    const pdfBuffer = await generateTemplateAccessiblePdf(template)
    expect(pdfBuffer).toBeInstanceOf(Uint8Array)
    const pdfString = new TextDecoder('latin1').decode(pdfBuffer)
    // Conforms to PDF specification
    expect(pdfString.startsWith('%PDF-1.4')).toBe(true)
    expect(pdfString).toContain('/Title (Checklist de Auditor')
    expect(pdfString).toContain('/Lang (es-ES)')
    expect(pdfString).toContain('%%EOF')
  })

  it('prevents direct mutation or deletion of audit commands ledger', async () => {
    const template = await createDownloadableTemplate(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'a1000000-0000-4000-8000-000000000008',
        slug: 'plan-gestion-derrames',
        title: 'Plan de Gestión de Derrames Químicos en Almacén',
        description: 'Procedimiento de emergencia y neutralización.',
        templateType: 'plan',
        category: 'industria',
        targetAudience: 'Operarios y supervisores',
        sections: [
          {
            id: 'fase-aislamiento',
            title: 'Aislamiento del Área',
            items: [{ id: 'item-derrame-1', label: 'Evacuar y delimitar con absorbente inerte', mandatory: true }]
          }
        ],
        reviewedAt: NOW,
        reviewDueAt: REVIEW_DUE
      },
      NOW
    )

    // Try to update commands table directly: trigger must abort
    expect(() => {
      sqlite.exec(`UPDATE downloadable_template_commands SET action='archive' WHERE template_id='${template.id}'`)
    }).toThrow(/downloadable_template_commands_immutable/)

    // Try to delete commands table directly: trigger must abort
    expect(() => {
      sqlite.exec(`DELETE FROM downloadable_template_commands WHERE template_id='${template.id}'`)
    }).toThrow(/downloadable_template_commands_immutable/)
  })

  it('rejects duplicate commandId and idempotency collisions', async () => {
    const input = {
      commandId: 'a1000000-0000-4000-8000-000000000009',
      slug: 'checklist-appcc-obradores',
      title: 'Checklist APPCC para Obradores',
      description: 'Control de harinas, alérgenos y superficies.',
      templateType: 'checklist' as const,
      category: 'alimentaria' as const,
      targetAudience: 'Panaderías y confiterías',
      sections: [
        {
          id: 'sec-harinas',
          title: 'Control de Harinas',
          items: [{ id: 'item-h1', label: 'Tamizado de harinas previo a elaboración', mandatory: true }]
        }
      ],
      reviewedAt: NOW,
      reviewDueAt: REVIEW_DUE
    }

    await createDownloadableTemplate(db, ADMIN_CLAIMS, input, NOW)

    // Replay with exact same commandId must fail
    await expect(createDownloadableTemplate(db, ADMIN_CLAIMS, { ...input, slug: 'otro-slug' }, NOW)).rejects.toThrow(
      DownloadableTemplateError
    )
  })

  it('rejects creation when reviewDueAt is not strictly after reviewedAt', async () => {
    await expect(
      createDownloadableTemplate(
        db,
        ADMIN_CLAIMS,
        {
          commandId: 'a1000000-0000-4000-8000-000000000010',
          slug: 'plan-fechas-invalidas',
          title: 'Plan con fechas inválidas',
          description: 'Intento de crear con fecha de revisión pasada o igual.',
          templateType: 'plan',
          category: 'mantenimiento',
          targetAudience: 'Técnicos',
          sections: [
            {
              id: 'sec-1',
              title: 'Mantenimiento',
              items: [{ id: 'item-1', label: 'Revisión mensual de filtros', mandatory: true }]
            }
          ],
          reviewedAt: NOW,
          reviewDueAt: NOW // Invalid: must be > reviewedAt
        },
        NOW
      )
    ).rejects.toThrow(DownloadableTemplateError)
  })

  it('filters downloadable templates by category, type, and pagination', async () => {
    // Create and publish two different templates
    const t1 = await createDownloadableTemplate(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'a1000000-0000-4000-8000-000000000011',
        slug: 'checklist-sanitario-residencias',
        title: 'Checklist Sanitario para Residencias de Mayores',
        description: 'Protocolo de higiene de habitaciones y zonas comunes.',
        templateType: 'checklist',
        category: 'sanitario',
        targetAudience: 'Personal de limpieza sociosanitaria',
        sections: [
          {
            id: 'sec-hab',
            title: 'Habitaciones',
            items: [{ id: 'item-h', label: 'Desinfección de pomos y barandillas', mandatory: true }]
          }
        ],
        reviewedAt: NOW,
        reviewDueAt: REVIEW_DUE
      },
      NOW
    )
    await publishDownloadableTemplate(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'a1000000-0000-4000-8000-000000000012',
        templateId: t1.id,
        expectedVersion: 1
      },
      NOW
    )

    const t2 = await createDownloadableTemplate(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'a1000000-0000-4000-8000-000000000013',
        slug: 'guia-lavanderia-hospitalaria',
        title: 'Guía de Procesamiento de Ropa Hospitalaria',
        description: 'Ciclos de termodesinfección química a 60°C.',
        templateType: 'guide',
        category: 'lavanderia',
        targetAudience: 'Jefes de planta de lavandería',
        sections: [
          {
            id: 'sec-termo',
            title: 'Termodesinfección',
            items: [{ id: 'item-t', label: 'Verificar temperatura de 65°C durante 15 min', mandatory: true }]
          }
        ],
        reviewedAt: NOW,
        reviewDueAt: REVIEW_DUE
      },
      NOW
    )
    await publishDownloadableTemplate(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'a1000000-0000-4000-8000-000000000014',
        templateId: t2.id,
        expectedVersion: 1
      },
      NOW
    )

    // Filter by type=guide
    const guideRes = await listDownloadableTemplates(db, { type: 'guide' })
    expect(guideRes.items.some((i) => i.slug === 'guia-lavanderia-hospitalaria')).toBe(true)
    expect(guideRes.items.some((i) => i.slug === 'checklist-sanitario-residencias')).toBe(false)

    // Filter by category=sanitario
    const sanitRes = await listDownloadableTemplates(db, { category: 'sanitario' })
    expect(sanitRes.items.some((i) => i.slug === 'checklist-sanitario-residencias')).toBe(true)
    expect(sanitRes.items.some((i) => i.slug === 'guia-lavanderia-hospitalaria')).toBe(false)
  })
})
