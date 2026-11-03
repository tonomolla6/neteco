import { randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { build } from 'esbuild'
import { TOTP, Secret } from 'otpauth'
import { expect, it, vi } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { decryptSecret } from '../../server/utils/secrets'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { accountPrivacyExportSchema, accountPrivacyRequestSchema } from '../../shared/account-privacy'

it('accepts all five account-security notices through compiled canary HTTP and dispatcher on workerd D1/all71, never a real provider', async () => {
  const origin = 'https://account-security-native.neteco.test',
    email = 'synthetic-security-old@example.invalid',
    nextEmail = 'synthetic-security-new@example.invalid'
  const password = 'Synthetic-native-original-password-123',
    replacement = 'Synthetic-native-replacement-password-456'
  const company = {
    legalName: 'Synthetic Native Fiscal SL',
    tradeName: 'Synthetic Native Brand',
    taxId: 'B12345674',
    countryCode: 'ES',
    currentPassword: replacement
  }
  const encryptionKey = randomBytes(32).toString('base64')
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  // In-memory source entry only: no shop build, file artifact or production
  // provider. Normal routes delegate to actual canary inside workerd.
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'account-security-native-entry.ts',
      loader: 'ts',
      contents: `
    import worker from './workers/canary';
    import {publishEmailOutbox,receiveEmailDispatch} from './workers/communications/email-outbox';
    import {dispatchTransactionalEmails} from './workers/communications/transactional-email-delivery';
    import {decryptSecret} from './server/utils/secrets';
    let sends=0;
    export default {async fetch(request,env,context){
      if(new URL(request.url).pathname!='/__native/deliver')return worker.fetch(request,env,context);
      const input=await request.json(),now=new Date().toISOString().replace(/\\.\\d{3}Z$/,'Z');
      const messages=[],receipts=[];
      await publishEmailOutbox(env.DB,{send:async message=>messages.push(message)},{now});
      if(messages.length!==input.expected)throw Error('native_queue_count');
      for(const message of messages){
        if(Object.keys(message).sort().join(',')!=='eventId,type,version')throw Error('native_queue_privacy');
        receipts.push([await receiveEmailDispatch(env.DB,message,now),await receiveEmailDispatch(env.DB,message,now)]);
      }
      const tokens=(await env.DB.prepare('SELECT token_envelope FROM identity_lifecycle_tokens').all()).results.map(row=>decryptSecret(row.token_envelope,env.AUTH_ENCRYPTION_KEY));
      const mfa=(await env.DB.prepare('SELECT encrypted_secret FROM identity_mfa').all()).results.map(row=>decryptSecret(row.encrypted_secret,env.AUTH_ENCRYPTION_KEY));
      const recipients=[];
      const sender={send:async message=>{
        if(![${JSON.stringify(email)},${JSON.stringify(nextEmail)}].includes(message.to))throw Error('native_recipient');
        const serialized=JSON.stringify(message);
        if([...tokens,...mfa,...input.forbidden,${JSON.stringify(password)},${JSON.stringify(replacement)},${JSON.stringify(company.legalName)},${JSON.stringify(company.tradeName)},${JSON.stringify(company.taxId)},env.AUTH_ENCRYPTION_KEY,env.AUTH_TOKEN_PEPPER].some(secret=>serialized.includes(secret)))throw Error('native_secret_or_fiscal_pii');
        recipients.push(message.to===${JSON.stringify(email)}?'original':'replacement');
        sends++;return {messageId:'synthetic-account-security-'+sends};
      }};
      const config={enabled:true,from:'seguridad@neteco.es',now,appEnvironment:'local'};
      const applied=await dispatchTransactionalEmails(env.DB,sender,config),duplicate=await dispatchTransactionalEmails(env.DB,sender,config);
      return Response.json({receipts,applied,duplicate,sends,recipients,queueMessages:messages.length});
    }};
  `
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    external: ['node:*', 'cloudflare:*'],
    write: false,
    logLevel: 'silent'
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'account-security-native',
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      bindings: {
        APP_ENV: 'local',
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: randomBytes(32).toString('hex'),
        AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
        AUTH_ENCRYPTION_KEY: encryptionKey,
        AUTH_RATE_LIMIT_PEPPER: randomBytes(32).toString('hex')
      },
      ratelimits: { AUTH_EDGE_LIMIT: { namespace_id: '900072', simple: { limit: 100, period: 60 } } },
      d1Databases: { DB: '00000000-0000-4000-8000-000000000072' },
      outboundService: outbound
    })
  )
  try {
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const migrations = (await readdir('db/d1/migrations')).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
    expect(migrations.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: 154 }, (_, index) => index + 1)
    )
    for (const name of migrations) {
      // Rebuild 0071 and its deferred foreign-key check MUST be one atomic D1
      // batch. Never split migrations into arbitrary fifty-statement chunks.
      await database.batch(
        splitDemoSql(await readFile('db/d1/migrations/' + name, 'utf8')).map((sql) => database.prepare(sql))
      )
    }
    let cookie = ''
    const api = (method: string, path: string, body?: unknown) =>
      runtime.dispatchFetch(origin + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '192.0.2.72'
        },
        body: JSON.stringify(body)
      })
    const token = async (purpose: string) => {
      const row = await database
        .prepare(
          'SELECT token_envelope FROM identity_lifecycle_tokens WHERE purpose=? AND used_at IS NULL AND revoked_at IS NULL'
        )
        .bind(purpose)
        .first<{ token_envelope: string }>()
      expect(row).not.toBeNull()
      return decryptSecret(row!.token_envelope, encryptionKey)
    }
    const tables = [
      'customers',
      'customer_addresses',
      'identities',
      'auth_sessions',
      'identity_mfa',
      'mfa_enrollments',
      'identity_lifecycle_events',
      'identity_lifecycle_tokens',
      'identity_security_events',
      'identity_account_security_events',
      'companies',
      'company_review_events',
      'orders',
      'order_lines',
      'inventory_balances',
      'inventory_movements',
      'payment_intents',
      'payment_events',
      'newsletter_subscriptions',
      'newsletter_suppressions',
      'delivery_preferences',
      'delivery_preference_commands',
      'operational_email_suppressions'
    ]
    const snapshot = () =>
      Promise.all(
        tables.map(
          async (table) => (await database.prepare('SELECT * FROM ' + table + ' ORDER BY 1 LIMIT 100').all()).results
        )
      )
    let expectedTotal = 0
    async function deliver(expected: number, recipients: string[], forbidden: string[] = []) {
      const before = await snapshot()
      const response = await runtime.dispatchFetch(origin + '/__native/deliver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected, forbidden })
      })
      expect(response.status).toBe(200)
      const result = (await response.json()) as {
        receipts: string[][]
        applied: { sent: number }
        duplicate: { sent: number }
        sends: number
        recipients: string[]
        queueMessages: number
      }
      expectedTotal += expected
      expect(result).toMatchObject({
        queueMessages: expected,
        sends: expectedTotal,
        applied: { sent: expected, manualReview: 0, retryable: 0 },
        duplicate: { sent: 0 }
      })
      expect(result.receipts).toEqual(Array.from({ length: expected }, () => ['stored', 'replayed']))
      expect(result.recipients.sort()).toEqual(recipients.sort())
      expect(await snapshot()).toEqual(before)
    }
    expect(
      (
        await api('POST', '/api/auth/register', {
          name: 'Synthetic native account',
          email,
          password,
          termsAccepted: true,
          newsletter: false
        })
      ).status
    ).toBe(202)
    expect((await api('POST', '/api/auth/verify-email', { token: await token('verify_email') })).status).toBe(200)
    const login = await api('POST', '/api/auth/login', { email, password })
    expect(login.status).toBe(200)
    cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const beforePassword = await snapshot()
    await database
      .prepare(
        "CREATE TRIGGER synthetic_native_account_notice_failure BEFORE INSERT ON email_outbox_events BEGIN SELECT RAISE(ABORT,'synthetic_native_account_notice_failure'); END"
      )
      .run()
    expect(
      (await api('PUT', '/api/account/password', { currentPassword: password, newPassword: replacement })).status
    ).toBe(500)
    expect(await snapshot()).toEqual(beforePassword)
    expect(await database.prepare('SELECT count(*) n FROM email_outbox_events').first()).toEqual({ n: 0 })
    await database.prepare('DROP TRIGGER synthetic_native_account_notice_failure').run()
    const rotated = await api('PUT', '/api/account/password', { currentPassword: password, newPassword: replacement })
    expect(rotated.status).toBe(200)
    expect(await rotated.json()).toMatchObject({ ok: true, sessionVersion: 2 })
    const rotatedCookie = rotated.headers.get('set-cookie')
    expect(rotatedCookie).not.toBeNull()
    const previousCookie = cookie
    cookie = rotatedCookie!.split(';')[0]!
    expect(cookie).not.toBe(previousCookie)
    expect(await database.prepare('SELECT session_version FROM identities').first()).toEqual({ session_version: 2 })
    expect(
      await database.prepare('SELECT session_version FROM auth_sessions WHERE revoked_at IS NULL').first()
    ).toEqual({ session_version: 2 })
    await deliver(1, ['original'])
    const setup = await api('POST', '/api/auth/mfa/setup', { currentPassword: replacement })
    expect(setup.status).toBe(200)
    const pending = (await setup.json()) as { setupId: string; manualKey: string; recoveryCodes: string[] }
    const mfaCode = new TOTP({
      issuer: 'NETECO',
      label: 'account',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(pending.manualKey)
    }).generate()
    expect((await api('POST', '/api/auth/mfa/verify-setup', { setupId: pending.setupId, code: mfaCode })).status).toBe(
      200
    )
    await deliver(1, ['original'], [...pending.recoveryCodes, mfaCode])
    const beforeInvalidFiscal = await snapshot()
    const outboxBeforeInvalidFiscal = (await database.prepare('SELECT * FROM email_outbox_events ORDER BY id').all())
      .results
    for (const taxId of ['A58818502', '---']) {
      expect((await api('PUT', '/api/account/company', { ...company, taxId })).status).toBe(400)
    }
    for (const taxId of ['A58818502']) {
      expect(
        (
          await api('POST', '/api/account/addresses', {
            kind: 'both',
            label: 'Synthetic fiscal address',
            recipientName: 'Synthetic owner',
            companyName: '',
            taxId,
            line1: 'Calle Sintetica 12',
            line2: '',
            postalCode: '28001',
            city: 'Madrid',
            region: 'Madrid',
            countryCode: 'ES',
            phone: '',
            instructions: '',
            isDefault: true
          })
        ).status
      ).toBe(400)
    }
    expect(await snapshot()).toEqual(beforeInvalidFiscal)
    expect((await database.prepare('SELECT * FROM email_outbox_events ORDER BY id').all()).results).toEqual(
      outboxBeforeInvalidFiscal
    )
    expect((await api('PUT', '/api/account/company', company)).status).toBe(200)
    await deliver(1, ['original'], pending.recoveryCodes)
    expect(
      (await api('POST', '/api/account/email-change', { email: nextEmail, currentPassword: replacement })).status
    ).toBe(202)
    expect((await api('POST', '/api/auth/verify-email', { token: await token('email_change') })).status).toBe(200)
    expect(await database.prepare('SELECT email,session_version FROM identities').first()).toEqual({
      email: nextEmail,
      session_version: 3
    })
    await deliver(2, ['original', 'replacement'], pending.recoveryCodes)
    expect(
      await database
        .prepare(
          'SELECT kind,audience,count(*) n FROM identity_account_security_events GROUP BY kind,audience ORDER BY kind,audience'
        )
        .all()
    ).toMatchObject({
      results: [
        { kind: 'email_changed', audience: 'current', n: 1 },
        { kind: 'email_changed', audience: 'previous', n: 1 },
        { kind: 'fiscal_details_submitted', audience: 'current', n: 1 },
        { kind: 'mfa_enabled', audience: 'current', n: 1 },
        { kind: 'password_changed', audience: 'current', n: 1 }
      ]
    })
    expect(
      await database.prepare("SELECT count(*) n FROM transactional_email_deliveries WHERE status='sent'").first()
    ).toEqual({ n: 5 })
    expect(await database.prepare('SELECT count(*) n FROM transactional_email_preparations').first()).toEqual({ n: 5 })
    expect(await database.prepare('PRAGMA foreign_key_check').all()).toMatchObject({ results: [] })

    // Email rotation revoked the old sessions. Authenticate the actual current
    // owner again, using a real recovery code rather than reusing the setup TOTP.
    cookie = ''
    const ownerLogin = await api('POST', '/api/auth/login', { email: nextEmail, password: replacement })
    expect(ownerLogin.status).toBe(200)
    const challenge = (await ownerLogin.json()) as { mfaRequired: boolean; challenge: string }
    expect(challenge.mfaRequired).toBe(true)
    const completed = await api('POST', '/api/auth/mfa/complete', {
      challenge: challenge.challenge,
      code: pending.recoveryCodes[0]
    })
    expect(completed.status).toBe(200)
    cookie = completed.headers.get('set-cookie')!.split(';')[0]!
    const ownerCookie = cookie
    const requested = await api('POST', '/api/account/privacy', {
      requestType: 'export',
      idempotencyKey: crypto.randomUUID()
    })
    expect(requested.status).toBe(202)
    const request = accountPrivacyRequestSchema.parse(await requested.json())
    const downloadPath = `/api/account/privacy/${request.id}/download`
    const beforeDownload = await snapshot()
    const download = await api('GET', downloadPath)
    expect(download.status).toBe(200)
    const exported = accountPrivacyExportSchema.parse(await download.json())
    const ledger = await database
      .prepare(
        'SELECT kind,recipient,audience,created_at AS createdAt FROM identity_account_security_events WHERE identity_id=(SELECT id FROM identities WHERE email=?) ORDER BY created_at,id'
      )
      .bind(nextEmail)
      .all()
    expect(exported.securityNotices).toEqual(ledger.results)
    expect(exported.securityNotices).toHaveLength(5)
    expect(exported.securityNotices.filter((notice) => notice.recipient === email)).toHaveLength(4)
    expect(exported.securityNotices.filter((notice) => notice.recipient === nextEmail)).toHaveLength(1)
    for (const notice of exported.securityNotices)
      expect(Object.keys(notice).sort()).toEqual(['audience', 'createdAt', 'kind', 'recipient'])
    const serialized = JSON.stringify(exported)
    for (const secret of [password, replacement, pending.manualKey, mfaCode, ...pending.recoveryCodes, encryptionKey])
      expect(serialized).not.toContain(secret)
    const privateRows = await database
      .prepare(
        'SELECT password_hash FROM identities UNION ALL SELECT encrypted_secret FROM identity_mfa UNION ALL SELECT token_envelope FROM identity_lifecycle_tokens'
      )
      .all<{ password_hash: string }>()
    for (const row of privateRows.results) expect(serialized).not.toContain(row.password_hash)
    expect(await snapshot()).toEqual(beforeDownload)

    // A separately registered and verified customer cannot download the owner's
    // export, even though the owner's current email differs from its history.
    cookie = ''
    const foreignEmail = 'synthetic-security-foreign@example.invalid'
    expect(
      (
        await api('POST', '/api/auth/register', {
          name: 'Synthetic foreign owner',
          email: foreignEmail,
          password,
          termsAccepted: true,
          newsletter: false
        })
      ).status
    ).toBe(202)
    expect((await api('POST', '/api/auth/verify-email', { token: await token('verify_email') })).status).toBe(200)
    const foreignLogin = await api('POST', '/api/auth/login', { email: foreignEmail, password })
    expect(foreignLogin.status).toBe(200)
    cookie = foreignLogin.headers.get('set-cookie')!.split(';')[0]!
    expect((await api('GET', downloadPath)).status).toBe(404)
    cookie = ownerCookie
    expect((await api('POST', '/api/auth/logout', {})).status).toBe(200)
    expect((await api('GET', downloadPath)).status).toBe(401)
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 60_000)
