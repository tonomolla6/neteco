import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  createOfficialCertification,
  updateOfficialCertification,
  getOfficialCertificationByNumber,
  listOfficialCertifications,
  authorizeBrandPartner,
  revokeBrandPartner,
  upsertBrandAsset,
  getBrandCenterView,
  BrandCenterError
} from '../../workers/brand/brand-center'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000021',
  sessionId: '20000000-0000-4000-8000-000000000021',
  sessionVersion: 1
}

const GUEST_CLAIMS: VerifiedSessionClaims = {
  identityId: '90000000-0000-4000-8000-000000000021',
  sessionId: '91000000-0000-4000-8000-000000000021',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'
const VALID_UNTIL = '2028-10-29T12:00:00Z'

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
      ('catalog.publish', 'catalog', 'publish', 'Publicar catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'catalog.publish');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin-brand@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
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

describe('MED-021: Centro de marca y certificaciones verificables (D1 Core)', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('registers and retrieves authentic accredited certifications with scope and verification link', async () => {
    const certInput = {
      commandId: 'c1000000-0000-4000-8000-000000000001',
      standardCode: 'ISO-9001' as const,
      title: 'Sistema de Gestión de la Calidad UNE-EN ISO 9001:2015',
      issuer: 'AENOR Internacional S.A.U.',
      certificateNumber: 'ER-0428/2021',
      scope:
        'Diseño, fabricación, envasado y comercialización de productos químicos de limpieza profesional e higiene industrial.',
      validFrom: NOW,
      validUntil: VALID_UNTIL,
      verificationUrl: 'https://certificados.aenor.com/verificacion?cert=ER-0428-2021',
      documentUrl: '/media/certificados/aenor-iso-9001-2026.pdf',
      auditedBy: 'Auditor Jefe AENOR Acreditación ENAC nº 01/C-SC001'
    }

    const created = await createOfficialCertification(db, ADMIN_CLAIMS, certInput, NOW)
    expect(created.id).toBeDefined()
    expect(created.standardCode).toBe('ISO-9001')
    expect(created.status).toBe('active')
    expect(created.certificateNumber).toBe('ER-0428/2021')

    // Query by certificate number
    const verified = await getOfficialCertificationByNumber(db, 'ER-0428/2021')
    expect(verified).not.toBeNull()
    expect(verified?.issuer).toBe('AENOR Internacional S.A.U.')
    expect(verified?.scope).toContain('Diseño, fabricación, envasado')

    // List certifications
    const list = await listOfficialCertifications(db)
    expect(list).toHaveLength(1)
  })

  it('rejects unaccredited or vague marketing claims (anti-greenwashing / anti-sellos vagos)', async () => {
    // Attempting to register an unaccredited standard code or vague badge fails
    await expect(
      createOfficialCertification(
        db,
        ADMIN_CLAIMS,
        {
          commandId: 'c1000000-0000-4000-8000-000000000002',
          // @ts-expect-error testing invalid standard code
          standardCode: 'SELLO-VERDE-INVENTADO',
          title: 'Producto 100% Ecológico y Natural',
          issuer: 'Auto-declaración sin auditar',
          certificateNumber: 'FAKE-1234',
          scope: 'Afirmación genérica sin alcance técnico.',
          validFrom: NOW,
          validUntil: VALID_UNTIL,
          verificationUrl: 'https://example.com',
          documentUrl: '/fake.pdf',
          auditedBy: 'Nadie'
        },
        NOW
      )
    ).rejects.toThrow()
  })

  it('manages brand assets and authorized partners with clear boundaries', async () => {
    // 1. Upsert authorized brand logo
    const asset = await upsertBrandAsset(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'c1000000-0000-4000-8000-000000000003',
        name: 'Logotipo Maestro Neteco Pro',
        category: 'logo',
        format: 'svg',
        variant: 'primary',
        url: '/assets/brand/neteco-master-logo.svg',
        minClearspacePx: 24,
        prohibitedUses: [
          'No deformar ni modificar proporciones',
          'No aplicar sombras ni degradados no autorizados',
          'No cambiar los colores corporativos Pantone 300C y Negro'
        ]
      },
      NOW
    )
    expect(asset.category).toBe('logo')
    expect(asset.status).toBe('active')

    // 2. Authorize official partner
    const auth = await authorizeBrandPartner(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'c1000000-0000-4000-8000-000000000004',
        partnerName: 'Distribuciones Químicas del Norte S.L.',
        authorizedDomain: 'distriquim-norte.es',
        scope: 'distribuidor_oficial',
        validFrom: NOW,
        validUntil: VALID_UNTIL
      },
      NOW
    )
    expect(auth.partnerName).toBe('Distribuciones Químicas del Norte S.L.')
    expect(auth.status).toBe('active')

    // 3. Get comprehensive Brand Center view
    const view = await getBrandCenterView(db, NOW)
    expect(view.brandAssets).toHaveLength(1)
    expect(view.authorizations).toHaveLength(1)
    expect(view.usageGuidelines.generalRules.length).toBeGreaterThan(0)

    // 4. Revoke partner
    const revoked = await revokeBrandPartner(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'c1000000-0000-4000-8000-000000000005',
        authorizationId: auth.id
      },
      NOW
    )
    expect(revoked.status).toBe('revoked')
  })

  it('enforces CAS version increment and triggers on commands table', async () => {
    const cert = await createOfficialCertification(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'c1000000-0000-4000-8000-000000000006',
        standardCode: 'ISO-14001',
        title: 'Sistema de Gestión Ambiental ISO 14001:2015',
        issuer: 'Bureau Veritas Certification',
        certificateNumber: 'ES112233-1',
        scope: 'Fabricación y distribución de desinfectantes y detergentes ecológicos.',
        validFrom: NOW,
        validUntil: VALID_UNTIL,
        verificationUrl: 'https://certificate.bureauveritas.com/es112233-1',
        documentUrl: '/media/certificados/bv-iso-14001.pdf',
        auditedBy: 'Bureau Veritas ENAC 04/C-MA005'
      },
      NOW
    )

    // Stale version update must fail
    await expect(
      updateOfficialCertification(
        db,
        ADMIN_CLAIMS,
        {
          commandId: 'c1000000-0000-4000-8000-000000000007',
          certificationId: cert.id,
          expectedVersion: 99, // Mismatch!
          title: 'Título no coincidente',
          scope: cert.scope,
          validFrom: cert.validFrom,
          validUntil: cert.validUntil,
          verificationUrl: cert.verificationUrl,
          documentUrl: cert.documentUrl,
          auditedBy: cert.auditedBy
        },
        NOW
      )
    ).rejects.toThrow(BrandCenterError)

    // Command table immutability
    expect(() => {
      sqlite.exec(`UPDATE brand_center_commands SET action='revoke_partner' WHERE entity_id='${cert.id}'`)
    }).toThrow(/brand_center_commands_immutable/)
  })

  it('rejects duplicate certificate numbers and unique constraints', async () => {
    const certInput = {
      commandId: 'c1000000-0000-4000-8000-000000000008',
      standardCode: 'ISO-9001' as const,
      title: 'UNE-EN ISO 9001:2015',
      issuer: 'AENOR',
      certificateNumber: 'ER-DUPLICATE/2026',
      scope: 'Fabricación de productos químicos de limpieza profesional.',
      validFrom: NOW,
      validUntil: VALID_UNTIL,
      verificationUrl: 'https://certificados.aenor.com/verificacion?cert=ER-DUPLICATE',
      documentUrl: '/media/certificados/iso9001.pdf',
      auditedBy: 'AENOR ENAC'
    }

    await createOfficialCertification(db, ADMIN_CLAIMS, certInput, NOW)

    // Second insert with same certificate number should fail
    await expect(
      createOfficialCertification(
        db,
        ADMIN_CLAIMS,
        {
          ...certInput,
          commandId: 'c1000000-0000-4000-8000-000000000009',
          standardCode: 'ISO-14001' as const
        },
        NOW
      )
    ).rejects.toThrow()
  })

  it('filters out expired certifications when current instant exceeds validUntil', async () => {
    await createOfficialCertification(
      db,
      ADMIN_CLAIMS,
      {
        commandId: 'c1000000-0000-4000-8000-000000000010',
        standardCode: 'IFS-HPC',
        title: 'IFS HPC Norma para Productos Químicos del Hogar',
        issuer: 'TÜV Rheinland',
        certificateNumber: 'IFS-HPC-99881',
        scope: 'Envasado y formulación de limpiadores desinfectantes industriales.',
        validFrom: NOW,
        validUntil: '2026-10-29T18:00:00Z',
        verificationUrl: 'https://tuv.com/cert/99881',
        documentUrl: '/ifs.pdf',
        auditedBy: 'TÜV Auditor'
      },
      NOW
    )

    const activeList = await listOfficialCertifications(db, '2026-10-30T00:00:00Z')
    expect(activeList.some((c) => c.certificateNumber === 'IFS-HPC-99881')).toBe(false)
  })

  it('rejects partner authorization when requested by unprivileged user', async () => {
    await expect(
      authorizeBrandPartner(
        db,
        GUEST_CLAIMS,
        {
          commandId: 'c1000000-0000-4000-8000-000000000011',
          partnerName: 'Distribuidor Sin Permiso',
          authorizedDomain: 'sin-permiso.com',
          scope: 'distribuidor_oficial',
          validFrom: NOW,
          validUntil: VALID_UNTIL
        },
        NOW
      )
    ).rejects.toThrow(BrandCenterError)
  })
})
