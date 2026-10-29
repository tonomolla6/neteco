import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase, d1OverSqlite, seedInventoryFixture } from '../support/d1-sqlite'
import {
  handleProductMediaGuidesHttp,
  ownsProductMediaGuidesNamespace
} from '../../workers/catalog/product-media-guides-http'

const now = '2026-10-29T12:00:00Z'

async function fixture() {
  const sqlite = await openMigratedDatabase()
  try {
    seedInventoryFixture(sqlite)
    const migration = await readFile('db/d1/migrations/0113_product_reviews_qa_and_media_guides.sql', 'utf8')
    sqlite.exec(migration)

    sqlite.exec(`
      INSERT INTO identities(id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at) VALUES
      ('id-admin-1', 'staff@example.invalid', 'syn', '${now}', 'active', 1, '${now}', '${now}'),
      ('id-editor-1', 'editor@example.invalid', 'syn', '${now}', 'active', 1, '${now}', '${now}');

      INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('sess-admin-1', 'id-admin-1', 1, 1, '${now}', '2026-10-30T12:00:00Z'),
      ('sess-editor-1', 'id-editor-1', 1, 1, '${now}', '2026-10-30T12:00:00Z');

      INSERT INTO identity_mfa(identity_id, encrypted_secret, verified_at, updated_at) VALUES
      ('id-admin-1', 'synth-secret', '${now}', '${now}'),
      ('id-editor-1', 'synth-secret', '${now}', '${now}');

      INSERT INTO permissions(code, resource, action, description) VALUES
        ('catalog.manage', 'catalog', 'manage', 'Synthetic'),
        ('catalog.write', 'catalog', 'write', 'Synthetic');
      INSERT INTO roles(code, name, description) VALUES
        ('catalog_manager', 'Catalog Manager', 'Synthetic'),
        ('catalog_writer', 'Catalog Writer', 'Synthetic');
      INSERT INTO role_permissions(role_code, permission_code) VALUES
        ('catalog_manager', 'catalog.manage'),
        ('catalog_writer', 'catalog.write');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES
        ('id-admin-1', 'catalog_manager', '${now}'),
        ('id-editor-1', 'catalog_writer', '${now}');

      -- Seed sample video guide for product p-1 (which was seeded by seedInventoryFixture)
      INSERT INTO product_media_guides (
        id, product_id, guide_type, title, description, expert_presenter, expert_title,
        video_url, mime_type, duration_seconds, aspect_ratio, poster_url, poster_optimized_webp,
        poster_width, poster_height, subtitles_vtt_url, subtitles_language, transcript_text,
        steps_json, requires_consent, status, sort_order, version, created_at, updated_at
      ) VALUES (
        'guide-p1-1', 'p-1', 'dosage', 'Guía de dosificación de desengrasante',
        'Explicación técnica de dilución.', 'Servicio Técnico', 'Especialista',
        '/media/videos/dosage.mp4', 'video/mp4', 45, '16:9', '/media/posters/dosage.jpg',
        '/media/posters/dosage.webp', 1280, 720, '/media/subtitles/es.vtt', 'es',
        'Paso 1: Medir 50ml...', '[{"stepIndex":1,"title":"Medición","description":"50ml en 1L"}]',
        0, 'published', 1, 1, '${now}', '${now}'
      );
    `)

    return { sqlite, db: d1OverSqlite(sqlite) }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

describe('PDP-018 & MED-016: Media guides and video telemetry HTTP router', () => {
  it('recognizes namespace ownership for media guides endpoints', () => {
    expect(ownsProductMediaGuidesNamespace('/api/products/p-1/media-guides')).toBe(true)
    expect(ownsProductMediaGuidesNamespace('/api/media/guides/guide-1')).toBe(true)
    expect(ownsProductMediaGuidesNamespace('/api/media/guides/guide-1/telemetry')).toBe(true)
    expect(ownsProductMediaGuidesNamespace('/api/admin/media/guides')).toBe(true)
    expect(ownsProductMediaGuidesNamespace('/api/admin/media/guides/commands')).toBe(true)
    expect(ownsProductMediaGuidesNamespace('/api/catalog/products')).toBe(false)
  })

  it('GET /api/products/:productId/media-guides returns 200 with published video guides', async () => {
    const { sqlite, db } = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/products/p-1/media-guides')
      const response = await handleProductMediaGuidesHttp(request, {
        database: db,
        now: () => now,
        sessionClaimsResolver: async () => null
      })

      expect(response).not.toBeNull()
      expect(response?.status).toBe(200)
      const data = (await response?.json()) as {
        guides: Array<{ id: string; subtitlesVttUrl: string; transcriptText: string }>
      }
      expect(data.guides.length).toBe(1)
      expect(data.guides[0]?.id).toBe('guide-p1-1')
      expect(data.guides[0]?.subtitlesVttUrl).toBe('/media/subtitles/es.vtt')
      expect(data.guides[0]?.transcriptText).toContain('Paso 1')
    } finally {
      sqlite.close()
    }
  })

  it('POST /api/media/guides/:guideId/telemetry records usage event without PII', async () => {
    const { sqlite, db } = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/media/guides/guide-p1-1/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'play_start',
          playPositionSeconds: 0.0,
          sessionHash: 'c'.repeat(64),
          consentVerified: true
        })
      })

      const response = await handleProductMediaGuidesHttp(request, {
        database: db,
        now: () => now,
        sessionClaimsResolver: async () => null
      })

      expect(response?.status).toBe(200)
      const data = (await response?.json()) as { recorded: boolean }
      expect(data.recorded).toBe(true)
    } finally {
      sqlite.close()
    }
  })

  it('POST /api/admin/media/guides/commands upserts guide with admin authority', async () => {
    const { sqlite, db } = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/admin/media/guides/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert_guide',
          guide: {
            id: 'guide-new-assembly-1',
            productId: 'p-1',
            guideType: 'assembly',
            title: 'Montaje de difusor espumante',
            description: 'Instrucciones para acoplar el cabezal espumante al bidón.',
            videoUrl: '/media/videos/assembly.mp4',
            mimeType: 'video/mp4',
            durationSeconds: 25,
            aspectRatio: '16:9',
            posterUrl: '/media/posters/assembly.jpg',
            posterOptimizedWebp: '/media/posters/assembly.webp',
            posterWidth: 1280,
            posterHeight: 720,
            subtitlesVttUrl: '/media/subtitles/assembly-es.vtt',
            subtitlesLanguage: 'es',
            transcriptText: 'Alinear la boquilla y girar 90 grados.',
            steps: [{ stepIndex: 1, title: 'Alineación', description: 'Encarar la pestaña con la ranura.' }],
            requiresConsent: false,
            status: 'published'
          },
          expectedVersion: 0,
          commandId: 'cmd-guide-adm-1'
        })
      })

      const response = await handleProductMediaGuidesHttp(request, {
        database: db,
        now: () => now,
        sessionClaimsResolver: async () => ({
          identityId: 'id-admin-1',
          customerId: null,
          sessionId: 'sess-admin-1',
          sessionVersion: 1
        })
      })

      expect(response?.status).toBe(200)
      const data = (await response?.json()) as { guide: { id: string; version: number } }
      expect(data.guide.id).toBe('guide-new-assembly-1')
      expect(data.guide.version).toBe(1)
    } finally {
      sqlite.close()
    }
  })

  it('authorizes admin media guide listing for identities with catalog.write', async () => {
    const { sqlite, db } = await fixture()
    try {
      const request = new Request('https://tienda.example.com/api/admin/media/guides', {
        method: 'GET'
      })
      const response = await handleProductMediaGuidesHttp(request, {
        database: db,
        now: () => now,
        sessionClaimsResolver: async () => ({
          identityId: 'id-editor-1',
          customerId: null,
          sessionId: 'sess-editor-1',
          sessionVersion: 1
        })
      })
      expect(response?.status).toBe(200)
    } finally {
      sqlite.close()
    }
  })
})
