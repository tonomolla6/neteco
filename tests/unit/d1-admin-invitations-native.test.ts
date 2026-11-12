import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { convertV4MiniflareOptions, Miniflare, NoOpLog } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import {
  applyD1AdminBootstrap,
  inspectD1AdminBootstrap,
  type BootstrapQuery
} from '../../scripts/lib/d1-admin-bootstrap'
import worker from '../../workers/canary'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  adminInvitationIntentHash,
  adminInvitationPreviewSchema,
  adminInvitationReceiptSchema,
  adminInvitationTokenHash
} from '../../shared/admin-invitations'
import { testUuid } from '../support/deterministic'

it('bootstraps once and accepts a delegated invitation through canary/workerd D1, then recovers only with a fresh MFA session', async () => {
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'admin-invitations-native',
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000082' },
      outboundService: outbound
    })
  )
  try {
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const migrations = (await readdir('db/d1/migrations')).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
    expect(migrations).toContain('0083_admin_bootstrap.sql')
    expect(migrations).toContain('0084_admin_audit.sql')
    expect(migrations.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: migrations.length }, (_, i) => i + 1)
    )
    for (const migration of migrations) {
      const statements = splitDemoSql(await readFile(join('db/d1/migrations', migration), 'utf8'))
      for (let offset = 0; offset < statements.length; offset += 50)
        await database.batch(statements.slice(offset, offset + 50).map((sql) => database.prepare(sql)))
    }
    const now = (await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now").first<{ now: string }>())!
      .now
    const past = new Date(Date.parse(now) - 60000).toISOString().replace('.000Z', 'Z')
    const future = new Date(Date.parse(now) + 86400000).toISOString().replace('.000Z', 'Z')
    const issuer = { identityId: testUuid(), sessionId: testUuid(), sessionVersion: 1 }
    const recipient = { identityId: testUuid(), sessionId: testUuid(), sessionVersion: 1 }
    await database.batch([
      database.prepare(
        "INSERT INTO roles VALUES('admin','Synthetic administrator','Local native fixture'),('support','Synthetic support','Local native fixture')"
      ),
      database.prepare(
        "INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic'),('support.manage','support','manage','Synthetic')"
      ),
      database.prepare(
        "INSERT INTO role_permissions VALUES('admin','administration.manage'),('admin','support.manage'),('support','support.manage')"
      )
    ])
    // Synthetic existing accounts/factors; no grants are seeded. Bootstrap and
    // invitation acceptance below are the only paths that grant these roles.
    for (const [claims, email] of [
      [issuer, 'issuer-native@example.invalid'],
      [recipient, 'recipient-native@example.invalid']
    ] as const) {
      const customerId = testUuid()
      await database.batch([
        database
          .prepare("INSERT INTO customers(id,status,created_at,updated_at) VALUES(?,'active',?,?)")
          .bind(customerId, past, past),
        database
          .prepare(
            "INSERT INTO identities(id,email,password_hash,email_verified_at,status,session_version,customer_id,created_at,updated_at) VALUES(?,?,'synthetic-not-a-password',?,'active',1,?,?,?)"
          )
          .bind(claims.identityId, email, past, customerId, past, past),
        database
          .prepare(
            'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
          )
          .bind(claims.sessionId, claims.identityId, past, future),
        database
          .prepare(
            "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-verified-enrollment','[]',?,?)"
          )
          .bind(claims.identityId, past, past)
      ])
    }
    expect(await database.prepare('SELECT count(*) AS n FROM identity_roles').first()).toEqual({ n: 0 })
    const queryD1: BootstrapQuery = async (sql) => (await database.prepare(sql).all<Record<string, unknown>>()).results
    const plan = await inspectD1AdminBootstrap(issuer.identityId, queryD1)
    const bootstrapInput = {
      identityId: issuer.identityId,
      commandId: testUuid(),
      expectedPlanHash: plan.planHash,
      reason: 'Aprobación explícita del primer administrador sintético.'
    }
    const bootstrapReceipt = await applyD1AdminBootstrap(bootstrapInput, queryD1)
    expect(bootstrapReceipt).toMatchObject({ identityId: issuer.identityId, roleCode: 'admin', sessionRevoked: true })
    expect(await applyD1AdminBootstrap(bootstrapInput, queryD1)).toEqual(bootstrapReceipt)
    expect(
      await database.prepare('SELECT session_version FROM identities WHERE id=?').bind(issuer.identityId).first()
    ).toEqual({ session_version: 2 })
    const administrator = { ...issuer, sessionId: testUuid(), sessionVersion: 2 }
    await database
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,2,1,?,?)'
      )
      .bind(administrator.sessionId, administrator.identityId, past, future)
      .run()
    const configuration = { password: 'synthetic-invitations-native-cookie-password-32', maxAgeSeconds: 3600 }
    const adminCookie = (await issueD1SessionCookie(database, administrator, configuration))!.split(';')[0]!
    const recipientCookie = (await issueD1SessionCookie(database, recipient, configuration))!.split(';')[0]!
    const origin = 'https://invitations-native.neteco.test'
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      EMAIL_ENABLED: 'false',
      DB: database,
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: configuration.password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-invitations-native-rate-limit-pepper-32',
      AUTH_TOKEN_PEPPER: 'synthetic-invitations-native-token-pepper-32',
      AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) }
    } as unknown as CloudflareEnv
    const send = (path: string, cookie: string, body?: unknown, key = testUuid()) =>
      worker.fetch(
        new Request(origin + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            cookie,
            origin,
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '192.0.2.82',
            'Idempotency-Key': key
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        }),
        env
      )
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
    const createInput = {
      recipientEmail: 'recipient-native@example.invalid',
      roleCode: 'support' as const,
      tokenHash: await adminInvitationTokenHash(token),
      expiresInHours: 24,
      reason: 'Delegación revisada de soporte en entorno local.'
    }
    const createKey = testUuid()
    const created = await send('/api/admin/invitations', adminCookie, createInput, createKey)
    expect(created.status).toBe(201)
    const createdReceipt = adminInvitationReceiptSchema.parse(await created.json())
    expect(createdReceipt).toMatchObject({ commandId: createKey, action: 'create', version: 1, sessionRevoked: false })
    const exact = await send('/api/admin/invitations/' + createdReceipt.invitationId, adminCookie)
    expect(exact.status).toBe(200)
    expect(await exact.json()).toMatchObject({
      id: createdReceipt.invitationId,
      status: 'pending',
      version: 1,
      recipientEmail: createInput.recipientEmail
    })
    expect(
      await database
        .prepare('SELECT count(*) AS n FROM identity_roles WHERE identity_id=?')
        .bind(recipient.identityId)
        .first()
    ).toEqual({ n: 0 })
    const logout = await send('/api/auth/logout', adminCookie, {})
    expect(logout.status).toBe(200)
    expect((await send('/api/admin/invitations', adminCookie)).status).toBe(401)
    const preview = await send('/api/account/invitations/preview', recipientCookie, { token })
    expect(preview.status).toBe(200)
    expect(adminInvitationPreviewSchema.parse(await preview.json())).toMatchObject({
      invitationId: createdReceipt.invitationId,
      roleCode: 'support',
      permissions: ['support.manage']
    })
    const acceptKey = testUuid(),
      acceptInput = { token }
    const accepted = await send('/api/account/invitations/accept', recipientCookie, acceptInput, acceptKey)
    expect(accepted.status).toBe(201)
    expect(accepted.headers.get('set-cookie')).toContain('Max-Age=0')
    const acceptedReceipt = adminInvitationReceiptSchema.parse(await accepted.json())
    expect(acceptedReceipt).toMatchObject({
      commandId: acceptKey,
      invitationId: createdReceipt.invitationId,
      action: 'accept',
      version: 2,
      sessionRevoked: true
    })
    const acceptHash = await adminInvitationIntentHash('accept', null, acceptInput)
    const recoveryPath = '/api/account/invitations/commands/' + acceptKey + '?payloadHash=' + acceptHash
    expect((await send(recoveryPath, recipientCookie)).status).toBe(401)
    const freshRecipient = { ...recipient, sessionId: testUuid(), sessionVersion: 2 }
    await database
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,2,1,?,?)'
      )
      .bind(freshRecipient.sessionId, freshRecipient.identityId, past, future)
      .run()
    const freshCookie = (await issueD1SessionCookie(database, freshRecipient, configuration))!.split(';')[0]!
    const recovered = await send(recoveryPath, freshCookie)
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt: acceptedReceipt })
    expect(
      await database
        .prepare("SELECT count(*) AS n FROM identity_roles WHERE identity_id=? AND role_code='support'")
        .bind(recipient.identityId)
        .first()
    ).toEqual({ n: 1 })
    expect(
      await database.prepare("SELECT count(*) AS n FROM admin_invitation_commands WHERE action='accept'").first()
    ).toEqual({ n: 1 })
    expect(
      await database.prepare('SELECT session_version FROM identities WHERE id=?').bind(recipient.identityId).first()
    ).toEqual({ session_version: 2 })
    expect(
      await database
        .prepare('SELECT status,version,command_id FROM admin_invitations WHERE id=?')
        .bind(createdReceipt.invitationId)
        .first()
    ).toEqual({ status: 'accepted', version: 2, command_id: acceptKey })
    const ledger = await database
      .prepare('SELECT input_json,receipt_json FROM admin_invitation_commands ORDER BY id')
      .all<{ input_json: string; receipt_json: string }>()
    expect(JSON.stringify(ledger.results)).not.toContain(token)
    await expect(
      database.prepare("UPDATE admin_invitation_commands SET reason='attempted history overwrite'").run()
    ).rejects.toThrow(/immutable/)
    await expect(database.prepare('DELETE FROM admin_invitation_commands').run()).rejects.toThrow(/immutable/)
    expect(await database.prepare('SELECT count(*) AS n FROM admin_invitation_guards').first()).toEqual({ n: 0 })
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 120000)
