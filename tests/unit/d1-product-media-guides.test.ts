import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase, d1OverSqlite, seedInventoryFixture } from '../support/d1-sqlite'
import {
  upsertProductMediaGuide,
  listProductMediaGuides,
  recordMediaUsageMetric,
  getMediaUsageStats
} from '../../workers/catalog/product-media-guides'

const now = '2026-10-29T12:00:00Z'

async function fixture() {
  const sqlite = await openMigratedDatabase()
  try {
    seedInventoryFixture(sqlite)
    const migration = await readFile('db/d1/migrations/0113_product_reviews_qa_and_media_guides.sql', 'utf8')
    sqlite.exec(migration)

    sqlite.exec(`
      INSERT INTO identities(id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at) VALUES
      ('id-admin-1', 'staff@example.invalid', 'syn', '${now}', 'active', 1, '${now}', '${now}');

      INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('sess-admin-1', 'id-admin-1', 1, 1, '${now}', '2026-10-30T12:00:00Z');

      INSERT INTO identity_mfa(identity_id, encrypted_secret, verified_at, updated_at) VALUES
      ('id-admin-1', 'synth-secret', '${now}', '${now}');

      INSERT INTO permissions(code, resource, action, description) VALUES('catalog.manage', 'catalog', 'manage', 'Synthetic');
      INSERT INTO roles(code, name, description) VALUES('catalog_manager', 'Catalog Manager', 'Synthetic');
      INSERT INTO role_permissions(role_code, permission_code) VALUES('catalog_manager', 'catalog.manage');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES('id-admin-1', 'catalog_manager', '${now}');
    `)

    return { sqlite, db: d1OverSqlite(sqlite) }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

describe('PDP-018 & MED-016: Product video guides, subtitles, dosage & usage metrics domain', () => {
  it('upserts and retrieves an expert video demo with subtitles and transcript (PDP-018)', async () => {
    const { sqlite, db } = await fixture()
    try {
      const guide = await upsertProductMediaGuide(db, {
        id: 'guide-expert-1',
        productId: 'p-1',
        guideType: 'expert_demo',
        title: 'Masterclass: Desengrase en frío de circuitos cerrados',
        description: 'Explicación del técnico químico sobre el uso de tensioactivos no iónicos.',
        expertPresenter: 'Dr. Alejandro Valls',
        expertTitle: 'Director Técnico Químico',
        videoUrl: '/media/video-desengrase.mp4',
        mimeType: 'video/mp4',
        durationSeconds: 180,
        aspectRatio: '16:9',
        posterUrl: '/media/posters/desengrase.jpg',
        posterOptimizedWebp: '/media/posters/desengrase.webp',
        posterWidth: 1280,
        posterHeight: 720,
        subtitlesVttUrl: '/media/subtitles/desengrase-es.vtt',
        subtitlesLanguage: 'es',
        transcriptText: '00:00 Introducción a la química de desengrase. 01:00 Aplicación en superficie...',
        steps: [],
        requiresConsent: false,
        status: 'published',
        actorId: 'id-admin-1',
        expectedVersion: 0,
        commandId: 'cmd-guide-exp-01',
        now
      })

      expect(guide.guideType).toBe('expert_demo')
      expect(guide.expertPresenter).toBe('Dr. Alejandro Valls')
      expect(guide.subtitlesVttUrl).toBe('/media/subtitles/desengrase-es.vtt')
      expect(guide.transcriptText).toContain('Introducción a la química')
      expect(guide.version).toBe(1)

      const guides = await listProductMediaGuides(db, 'p-1')
      expect(guides.length).toBe(1)
      expect(guides[0]?.id).toBe('guide-expert-1')
    } finally {
      sqlite.close()
    }
  })

  it('upserts and retrieves a short dosage and assembly video with step guide (MED-016)', async () => {
    const { sqlite, db } = await fixture()
    try {
      const dosageGuide = await upsertProductMediaGuide(db, {
        id: 'guide-dosage-1',
        productId: 'p-1',
        guideType: 'dosage',
        title: 'Dosificación exacta y dilución recomendada',
        description: 'Vídeo corto de 30 segundos sobre proporción 1:50 y uso de vaso medidor.',
        expertPresenter: 'Servicio Técnico Neteco',
        expertTitle: 'Asistencia de Aplicación',
        videoUrl: '/media/video-dosificacion.mp4',
        mimeType: 'video/mp4',
        durationSeconds: 32,
        aspectRatio: '9:16', // Short vertical format
        posterUrl: '/media/posters/dosificacion.jpg',
        posterOptimizedWebp: '/media/posters/dosificacion.webp',
        posterWidth: 720,
        posterHeight: 1280,
        subtitlesVttUrl: '/media/subtitles/dosificacion-es.vtt',
        subtitlesLanguage: 'es',
        transcriptText: 'Paso 1: Colocarse guantes de nitrilo. Paso 2: Añadir 20 ml en 1 litro de agua tibia.',
        steps: [
          { stepIndex: 1, title: 'Equipos de Protección (EPI)', description: 'Utilizar gafas y guantes de nitrilo.' },
          { stepIndex: 2, title: 'Dilución 1:50', description: '20 ml de producto por cada litro de agua.' },
          { stepIndex: 3, title: 'Aplicación', description: 'Pulverizar a 20 cm de distancia y dejar actuar 3 min.' }
        ],
        requiresConsent: false,
        status: 'published',
        actorId: 'id-admin-1',
        expectedVersion: 0,
        commandId: 'cmd-guide-dos-01',
        now
      })

      expect(dosageGuide.guideType).toBe('dosage')
      expect(dosageGuide.aspectRatio).toBe('9:16')
      expect(dosageGuide.steps.length).toBe(3)
      expect(dosageGuide.steps[1]?.title).toContain('Dilución 1:50')
    } finally {
      sqlite.close()
    }
  })

  it('records anonymous telemetry events for video playback and transcript usage (PDP-018 & MED-016)', async () => {
    const { sqlite, db } = await fixture()
    try {
      // Create a guide first
      await upsertProductMediaGuide(db, {
        id: 'guide-telemetry-1',
        productId: 'p-1',
        guideType: 'expert_demo',
        title: 'Demo de producto',
        videoUrl: '/media/v.mp4',
        mimeType: 'video/mp4',
        durationSeconds: 60,
        aspectRatio: '16:9',
        posterUrl: '/media/p.jpg',
        transcriptText: 'Transcripción completa...',
        steps: [],
        requiresConsent: false,
        status: 'published',
        actorId: 'id-admin-1',
        expectedVersion: 0,
        commandId: 'cmd-guide-tel-init',
        now
      })

      // Simulate client telemetry events
      const sessionHash = 'a'.repeat(64)
      await recordMediaUsageMetric(db, {
        guideId: 'guide-telemetry-1',
        eventType: 'impression',
        sessionHash,
        consentVerified: true,
        now
      })

      await recordMediaUsageMetric(db, {
        guideId: 'guide-telemetry-1',
        eventType: 'play_start',
        sessionHash,
        consentVerified: true,
        now
      })

      await recordMediaUsageMetric(db, {
        guideId: 'guide-telemetry-1',
        eventType: 'complete',
        playPositionSeconds: 60.0,
        sessionHash,
        consentVerified: true,
        now
      })

      await recordMediaUsageMetric(db, {
        guideId: 'guide-telemetry-1',
        eventType: 'transcript_view',
        sessionHash,
        consentVerified: true,
        now
      })

      const stats = await getMediaUsageStats(db, 'guide-telemetry-1')
      expect(stats.totalImpressions).toBe(1)
      expect(stats.totalPlays).toBe(1)
      expect(stats.totalCompletions).toBe(1)
      expect(stats.totalTranscriptViews).toBe(1)
    } finally {
      sqlite.close()
    }
  })

  it('does not record identifiable session hash if consent is not verified', async () => {
    const { sqlite, db } = await fixture()
    try {
      await upsertProductMediaGuide(db, {
        id: 'guide-consent-1',
        productId: 'p-1',
        guideType: 'dosage',
        title: 'Guía con consentimiento',
        videoUrl: '/media/v2.mp4',
        mimeType: 'video/mp4',
        durationSeconds: 40,
        aspectRatio: '16:9',
        posterUrl: '/media/p2.jpg',
        transcriptText: 'Texto explicativo de la guía...',
        steps: [],
        requiresConsent: true,
        status: 'published',
        actorId: 'id-admin-1',
        expectedVersion: 0,
        commandId: 'cmd-guide-cons-init',
        now
      })

      const sessionHash = 'b'.repeat(64)
      // Telemetry when user rejected consent
      await recordMediaUsageMetric(db, {
        guideId: 'guide-consent-1',
        eventType: 'play_start',
        sessionHash,
        consentVerified: false,
        now
      })

      // Query raw metrics row to verify session_hash was zeroed/anonymized
      const row = sqlite
        .prepare(
          "SELECT session_hash, consent_verified FROM product_media_usage_metrics WHERE guide_id = 'guide-consent-1'"
        )
        .get() as { session_hash: string; consent_verified: number }

      expect(row.consent_verified).toBe(0)
      expect(row.session_hash).toBe('0'.repeat(64)) // Anonymized
    } finally {
      sqlite.close()
    }
  })
})
