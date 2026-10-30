import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  upsertEditorialArticle,
  reviewEditorialArticle,
  getEditorialArticle,
  listEditorialArticles,
  EditorialContentError
} from '../../workers/catalog/editorial-content'
import { evaluateEditorialQuality, calculateSupplierContentSimilarity } from '../../shared/catalog-editorial-content'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000019',
  sessionId: '20000000-0000-4000-8000-000000000019',
  sessionVersion: 1
}

const UNAUTHORIZED_CLAIMS: VerifiedSessionClaims = {
  identityId: '90000000-0000-4000-8000-000000000099',
  sessionId: '91000000-0000-4000-8000-000000000099',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol admin'),
      ('guest', 'Invitado', 'Sin permisos');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('catalog.write', 'catalog', 'write', 'Edición catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'catalog.write');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'editorial@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${UNAUTHORIZED_CLAIMS.identityId}', 'guest@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_CLAIMS.identityId}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('${UNAUTHORIZED_CLAIMS.sessionId}', '${UNAUTHORIZED_CLAIMS.identityId}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin', '${NOW}'),
      ('${UNAUTHORIZED_CLAIMS.identityId}', 'guest', '${NOW}');
  `)

  return sqlite
}

describe('CAT-019: Contenido editorial propio por producto y categoría', () => {
  let sqlite: DatabaseSync
  let d1: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupTestDb()
    d1 = d1OverSqlite(sqlite)
  })

  it('evaluates professional intent and anti-duplication against supplier text', () => {
    const rawSupplierText =
      'Detergente líquido multiusos concentrado con aroma a limón para todo tipo de suelos y superficies lavables.'

    // Case 1: Copied supplier text (should fail due to duplication)
    const duplicateBody =
      'Detergente líquido multiusos concentrado con aroma a limón para todo tipo de suelos y superficies lavables de empresa.'
    const evalDuplicate = evaluateEditorialQuality({
      bodyMarkdown: duplicateBody,
      applicationScope: 'Hostelería',
      surfaceCompatibility: { compatible: ['Gres', 'Terrazo'], incompatible: [] },
      dilutionDosageGuide: 'Diluir al 2%',
      safetyAndPpe: { requiredPpe: ['Guantes'], hazardWarnings: ['Evitar contacto ojos'] },
      supplierReferenceText: rawSupplierText
    })
    expect(calculateSupplierContentSimilarity(duplicateBody, rawSupplierText)).toBeGreaterThan(0.35)
    expect(evalDuplicate.isValid).toBe(false)
    expect(evalDuplicate.similarityScore).toBeGreaterThan(0.35)
    expect(evalDuplicate.reasons[0]).toContain('duplica el texto del proveedor')

    // Case 2: Original technical professional guide exceeding supplier
    const professionalGuide =
      'Guía técnica para higienización profesional en hostelería e industria alimentaria (HACCP). Formulado para desincrustar residuos grasos y orgánicos en pavimentos industriales de alto tránsito. Aplicar mediante fregadora automática o mopa con dilución controlada al 1.5% (150 ml por 10L de agua descalcificada). Apto para acero inoxidable 316 y gres vitrificado. Incompatible con superficies pulidas de aluminio no anodizado. Emplear obligatoriamente guantes de nitrilo UNE-EN 374 y gafas panorámicas UNE-EN 166.'

    const evalProfessional = evaluateEditorialQuality({
      bodyMarkdown: professionalGuide,
      applicationScope: 'Cocinas industriales e industria alimentaria',
      surfaceCompatibility: {
        compatible: ['Acero inoxidable 316', 'Gres vitrificado', 'Resina epoxi'],
        incompatible: ['Aluminio no anodizado']
      },
      dilutionDosageGuide: '150 ml por cada 10 litros de agua (1.5% v/v) a temperatura ambiente',
      safetyAndPpe: {
        requiredPpe: ['Guantes de nitrilo (UNE-EN 374)', 'Gafas de seguridad panorámicas (UNE-EN 166)'],
        hazardWarnings: ['Provoca irritación ocular grave', 'No mezclar con ácidos fuertes'],
        firstAidMeasures: 'Aclarar con abundante agua durante 15 minutos en caso de contacto.'
      },
      supplierReferenceText: rawSupplierText
    })

    expect(evalProfessional.isValid).toBe(true)
    expect(evalProfessional.similarityScore).toBeLessThan(0.35)
    expect(evalProfessional.surpassesSupplier).toBe(true)
  })

  it('creates and updates structured editorial content for a product', async () => {
    const article = await upsertEditorialArticle(
      d1,
      ADMIN_CLAIMS,
      {
        targetType: 'product',
        targetId: 'prod-desengrasante-100',
        title: 'Protocolo de Limpieza y Desengrase Pesado en Cocinas Colectivas',
        summary: 'Manual técnico de aplicación profesional del desengrasante alcalino de alta densidad.',
        bodyMarkdown:
          'Protocolo de desengrase para campanas extractoras, freidoras industriales y filtros de cocina. Formulación con tensioactivos biodegradables y álcalis libres que emulsifican grasa polimerizada. Aplicar pulverizado puro o diluido al 10%, dejar actuar 5 minutos y retirar con bayeta de microfibra o agua a presión. Requiere aclarado exhaustivo posterior en áreas de contacto con alimentos cumpliendo normativa APPCC.',
        applicationScope: 'Hostelería, restauración colectiva y catering',
        surfaceCompatibility: {
          compatible: ['Acero inoxidable', 'Gres porcelánico', 'Hierro fundido'],
          incompatible: ['Aluminio', 'Pinturas al esmalte', 'Superficies galvanizadas']
        },
        dilutionDosageGuide: 'Uso directo sobre grasa carbonizada; dilución al 10% (1:10) para limpieza diaria.',
        safetyAndPpe: {
          requiredPpe: ['Guantes de nitrilo de caña larga', 'Gafas de protección química'],
          hazardWarnings: ['Líquido corrosivo', 'Utilizar con ventilación adecuada']
        },
        technicalStandards: ['UNE-EN 13697', 'Protocolo APPCC'],
        supplierReferenceText: 'Desengrasante para grasas difíciles de cocina.'
      },
      { now: NOW }
    )

    expect(article.id).toBeDefined()
    expect(article.targetType).toBe('product')
    expect(article.targetId).toBe('prod-desengrasante-100')
    expect(article.status).toBe('draft')
    expect(article.version).toBe(1)
    expect(article.supplierSimilarityScore).toBeLessThan(0.35)

    // Read back
    const fetched = await getEditorialArticle(d1, 'product', 'prod-desengrasante-100')
    expect(fetched).not.toBeNull()
    expect(fetched?.title).toBe('Protocolo de Limpieza y Desengrase Pesado en Cocinas Colectivas')
  })

  it('creates structured editorial content for a category', async () => {
    const categoryArticle = await upsertEditorialArticle(
      d1,
      ADMIN_CLAIMS,
      {
        targetType: 'category',
        targetId: 'cat-quimicos-sanitarios',
        title: 'Criterios de Selección y Desinfección en Áreas Sanitarias y Hospitalarias',
        summary: 'Guía técnica de compra y dosificación de biocidas y limpiadores hospitalarios.',
        bodyMarkdown:
          'Guía sectorial para responsables de compras y limpieza en centros hospitalarios y clínicas. Los desinfectantes deben contar con registro de la AEMPS y acreditar actividad bactericida, virucida y fungicida conforme a las normas UNE-EN 14476 y UNE-EN 13727. Establecer rotación de principios activos (amonio cuaternario, peróxido de hidrógeno acelerado) para evitar resistencias microbianas.',
        applicationScope: 'Hospitales, clínicas dentales, residencias sociosanitarias',
        surfaceCompatibility: {
          compatible: ['PVC hospitalario', 'Acero inoxidable quirúrgico', 'Superficies de melamina'],
          incompatible: ['Maderas porosas no selladas']
        },
        dilutionDosageGuide: 'Dilución según ficha técnica: 25 ml por 5L (0.5%) para nivel intermedio.',
        safetyAndPpe: {
          requiredPpe: ['Guantes de examen desechables', 'Mascarilla tipo IIR'],
          hazardWarnings: ['Mantener alejado de pacientes y alimentos']
        },
        technicalStandards: ['UNE-EN 14476', 'UNE-EN 13727', 'Registro Plaguicidas DGSP']
      },
      { now: NOW }
    )

    expect(categoryArticle.targetType).toBe('category')
    expect(categoryArticle.targetId).toBe('cat-quimicos-sanitarios')
    expect(categoryArticle.status).toBe('draft')
  })

  it('rejects editorial content duplicating supplier text', async () => {
    const supplierText =
      'Limpiador multiusos con bioalcohol que seca rápidamente y no deja huellas en cristales ni espejos.'

    await expect(
      upsertEditorialArticle(
        d1,
        ADMIN_CLAIMS,
        {
          targetType: 'product',
          targetId: 'prod-bioalcohol-99',
          title: 'Limpiador Multiusos Profesional',
          summary: 'Limpiador con bioalcohol rápido.',
          bodyMarkdown:
            'Limpiador multiusos con bioalcohol que seca rápidamente y no deja huellas en cristales ni espejos de oficinas.',
          applicationScope: 'Limpieza de oficinas y cristales',
          surfaceCompatibility: { compatible: ['Cristal', 'Espejo'], incompatible: [] },
          dilutionDosageGuide: 'Uso directo en pulverizador.',
          safetyAndPpe: { requiredPpe: ['Guantes'], hazardWarnings: ['Líquido inflamable'] },
          supplierReferenceText: supplierText
        },
        { now: NOW }
      )
    ).rejects.toThrow('supplier_content_duplicated')
  })

  it('supports review, approval and publishing workflow with CAS', async () => {
    const created = await upsertEditorialArticle(
      d1,
      ADMIN_CLAIMS,
      {
        targetType: 'product',
        targetId: 'prod-cloro-50',
        title: 'Dosificación Técnica de Cloro Activo en Aguas de Proceso',
        summary: 'Manual de cloración profesional y desinfección preventiva.',
        bodyMarkdown:
          'Procedimiento técnico para dosificación de hipoclorito sódico en depósitos y circuitos de agua no potable. Medición continua de cloro libre residual (entre 0.5 y 1.5 ppm). Utilizar bombas peristálticas dosificadoras automáticas reguladas por sonda redox para prevenir subdosificaciones o sobrecloración.',
        applicationScope: 'Instalaciones industriales y torres de refrigeración',
        surfaceCompatibility: { compatible: ['PEAD', 'PVC presión'], incompatible: ['Cobre', 'Hierro dulce'] },
        dilutionDosageGuide: 'Inyección continua calculada según caudal de entrada (5 a 10 ppm dosis de choque).',
        safetyAndPpe: {
          requiredPpe: ['Gafas herméticas', 'Pantalla facial'],
          hazardWarnings: ['Desprende gases tóxicos en contacto con ácidos']
        }
      },
      { now: NOW }
    )

    // Publish with wrong version fails CAS
    await expect(
      reviewEditorialArticle(
        d1,
        ADMIN_CLAIMS,
        {
          articleId: created.id,
          decision: 'published',
          expectedVersion: 999
        },
        { now: NOW }
      )
    ).rejects.toThrow(EditorialContentError)

    // Publish with correct version succeeds
    const published = await reviewEditorialArticle(
      d1,
      ADMIN_CLAIMS,
      {
        articleId: created.id,
        decision: 'published',
        expectedVersion: created.version,
        reviewNotes: 'Revisado y validado por departamento técnico químico'
      },
      { now: NOW }
    )

    expect(published.status).toBe('published')
    expect(published.version).toBe(created.version + 1)
  })

  it('blocks unauthorized access without catalog.write permission', async () => {
    await expect(
      upsertEditorialArticle(
        d1,
        UNAUTHORIZED_CLAIMS,
        {
          targetType: 'product',
          targetId: 'prod-test',
          title: 'Test No Auth',
          summary: 'Summary test',
          bodyMarkdown: 'Body markdown test content that is long enough.',
          applicationScope: 'Test',
          surfaceCompatibility: { compatible: ['Gres'], incompatible: [] },
          dilutionDosageGuide: '10%',
          safetyAndPpe: { requiredPpe: ['Guantes'], hazardWarnings: ['Peligro'] }
        },
        { now: NOW }
      )
    ).rejects.toThrow(EditorialContentError)
  })

  it('rejects editorial content when it does not surpass supplier description length or detail', async () => {
    const longSupplierText =
      'Detergente líquido concentrado formulado específicamente con sales inorgánicas y surfactantes aniónicos para la limpieza exhaustiva de líneas de envasado en fábricas de bebidas y refrescos embotellados. Gran estabilidad a bajas temperaturas y compatibilidad probada.'

    await expect(
      upsertEditorialArticle(
        d1,
        ADMIN_CLAIMS,
        {
          targetType: 'product',
          targetId: 'prod-short',
          title: 'Detergente Breve',
          summary: 'Resumen breve para prueba de superación.',
          bodyMarkdown: 'Detergente para líneas.', // shorter than supplier text
          applicationScope: 'Líneas',
          surfaceCompatibility: { compatible: ['Inox'], incompatible: [] },
          dilutionDosageGuide: 'Diluir al 1%',
          safetyAndPpe: { requiredPpe: ['Guantes'], hazardWarnings: ['Peligro'] },
          supplierReferenceText: longSupplierText
        },
        { now: NOW }
      )
    ).rejects.toThrow('supplier_content_not_surpassed')
  })

  it('lists editorial articles filtered by targetType and status', async () => {
    const list = await listEditorialArticles(d1, { targetType: 'product' })
    expect(Array.isArray(list)).toBe(true)
  })
})
