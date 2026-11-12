import { randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { buildNativeCanary as build } from '../support/native-canary-build'
import { expect, it, vi } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { decryptSecret } from '../../server/utils/secrets'
import { verifyWorkerPassword } from '../../workers/auth/password'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'

it('runs actual canary source reset and compiled dispatcher on workerd D1/all71 with atomic notice, queue replay and zero outbound', async () => {
  const origin = 'https://identity-security-native.neteco.test'
  const email = 'synthetic-security-native@example.invalid'
  const original = 'Synthetic-native-original-password-123'
  const replacement = 'Synthetic-native-replacement-password-456'
  const encryptionKey = randomBytes(32).toString('base64')
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  // Same in-memory esbuild/workerd pattern as audit-d1-media. This is a small
  // source acceptance entry, NOT a shop rebuild or the compiled browser bundle.
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'identity-security-native-entry.ts',
      loader: 'ts',
      contents: `
        import worker from './workers/canary';
        import {publishEmailOutbox,receiveEmailDispatch} from './workers/communications/email-outbox';
        import {dispatchTransactionalEmails} from './workers/communications/transactional-email-delivery';
        import {decryptSecret} from './server/utils/secrets';
        let sends=0;
        export default {async fetch(request,env,context){
          if(new URL(request.url).pathname!='/__native/deliver') return worker.fetch(request,env,context);
          const {now}=await env.DB.prepare("SELECT MAX(available_at) AS now FROM email_outbox_delivery WHERE status='ready'").first();
          if(!now)throw Error('native_queue_not_ready');
          const messages=[];
          await publishEmailOutbox(env.DB,{send:async message=>{messages.push(message)}},{now});
          if(messages.length!==1)throw Error('native_queue_count');
          if(Object.keys(messages[0]).sort().join(',')!=='eventId,type,version')throw Error('native_queue_privacy');
          const first=await receiveEmailDispatch(env.DB,messages[0],now);
          const replay=await receiveEmailDispatch(env.DB,messages[0],now);
          const tokens=(await env.DB.prepare('SELECT token_envelope FROM identity_lifecycle_tokens').all()).results.map(row=>decryptSecret(row.token_envelope,env.AUTH_ENCRYPTION_KEY));
          const sender={send:async message=>{
            const serialized=JSON.stringify(message);
            if(message.to!==${JSON.stringify(email)}||!message.text.includes('restablecido'))throw Error('native_message_authority');
            if([...tokens,${JSON.stringify(original)},${JSON.stringify(replacement)},env.AUTH_ENCRYPTION_KEY,env.AUTH_TOKEN_PEPPER].some(secret=>serialized.includes(secret)))throw Error('native_message_secret');
            sends++;return {messageId:'synthetic-native-security-receipt'};
          }};
          const config={enabled:true,from:'seguridad@neteco.es',now,appEnvironment:'local'};
          const applied=await dispatchTransactionalEmails(env.DB,sender,config);
          const duplicate=await dispatchTransactionalEmails(env.DB,sender,config);
          return Response.json({first,replay,applied,duplicate,sends,queueMessages:messages.length});
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
      name: 'identity-security-native',
      ...bundle.nativeSource,
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
      ratelimits: { AUTH_EDGE_LIMIT: { namespace_id: '900071', simple: { limit: 100, period: 60 } } },
      d1Databases: { DB: '00000000-0000-4000-8000-000000000071' },
      outboundService: outbound
    })
  )
  try {
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const migrations = (await readdir('db/d1/migrations')).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
    expect(migrations.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: 155 }, (_, index) => index + 1)
    )
    for (const name of migrations) {
      const sql = splitDemoSql(await readFile('db/d1/migrations/' + name, 'utf8'))
      await database.batch(sql.map((text) => database.prepare(text)))
    }
    const api = (path: string, body: unknown) =>
      runtime.dispatchFetch(origin + path, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.71' },
        body: JSON.stringify(body)
      })
    const registration = await api('/api/auth/register', {
      name: 'Synthetic native customer',
      email,
      password: original,
      termsAccepted: true,
      newsletter: false
    })
    expect(registration.status).toBe(202)
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
    expect((await api('/api/auth/verify-email', { token: await token('verify_email') })).status).toBe(200)
    expect((await api('/api/auth/forgot-password', { email })).status).toBe(202)
    const resetToken = await token('password_reset')
    const before = await database.prepare('SELECT id,password_hash,session_version FROM identities').first()
    // Deliberate isolated failure injection, not a production schema change.
    await database
      .prepare(
        "CREATE TRIGGER synthetic_native_notice_failure BEFORE INSERT ON email_outbox_events BEGIN SELECT RAISE(ABORT,'synthetic_native_notice_failure'); END"
      )
      .run()
    expect((await api('/api/auth/reset-password', { token: resetToken, password: replacement })).status).toBe(503)
    expect(await database.prepare('SELECT id,password_hash,session_version FROM identities').first()).toEqual(before)
    expect(
      await database.prepare("SELECT used_at FROM identity_lifecycle_tokens WHERE purpose='password_reset'").first()
    ).toEqual({ used_at: null })
    expect(
      await database
        .prepare("SELECT count(*) n FROM identity_lifecycle_events WHERE event_type='password_reset'")
        .first()
    ).toEqual({ n: 0 })
    expect(await database.prepare('SELECT count(*) n FROM email_outbox_events').first()).toEqual({ n: 0 })
    await database.prepare('DROP TRIGGER synthetic_native_notice_failure').run()
    expect((await api('/api/auth/reset-password', { token: resetToken, password: replacement })).status).toBe(200)
    const changed = await database
      .prepare('SELECT password_hash,session_version FROM identities')
      .first<{ password_hash: string; session_version: number }>()
    expect(changed!.session_version).toBe(2)
    expect(await verifyWorkerPassword(changed!.password_hash, replacement)).toBe(true)
    expect(
      await database
        .prepare(
          'SELECT e.event_type,e.source_kind,l.event_type operation,t.used_at=l.created_at consumed FROM email_outbox_events e JOIN identity_lifecycle_events l ON l.id=e.source_event_id AND l.identity_id=e.source_id JOIN identity_lifecycle_tokens t ON t.id=l.token_id'
        )
        .first()
    ).toEqual({
      event_type: 'identity.security.password_changed',
      source_kind: 'identity',
      operation: 'password_reset',
      consumed: 1
    })
    expect((await api('/api/auth/reset-password', { token: resetToken, password: replacement })).status).toBe(400)
    const tables = [
      'identities',
      'auth_sessions',
      'identity_lifecycle_events',
      'identity_lifecycle_tokens',
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
    const domain = await snapshot()
    const delivery = await runtime.dispatchFetch(origin + '/__native/deliver')
    expect(delivery.status, await delivery.clone().text()).toBe(200)
    expect(await delivery.json()).toMatchObject({
      first: 'stored',
      replay: 'replayed',
      queueMessages: 1,
      sends: 1,
      applied: { sent: 1, manualReview: 0, retryable: 0 },
      duplicate: { sent: 0 }
    })
    expect(
      await database.prepare('SELECT status,attempts,provider_message_id FROM transactional_email_deliveries').first()
    ).toEqual({ status: 'sent', attempts: 1, provider_message_id: 'synthetic-native-security-receipt' })
    expect(await database.prepare('SELECT count(*) n FROM transactional_email_preparations').first()).toEqual({ n: 1 })
    expect(await snapshot()).toEqual(domain)
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 60_000)
