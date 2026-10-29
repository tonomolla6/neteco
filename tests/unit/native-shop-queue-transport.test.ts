import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import ts from 'typescript'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'

async function actualTransportFactory(converter: typeof convertV4MiniflareOptions = convertV4MiniflareOptions) {
  const source = await readFile(new URL('../../scripts/audit-cloudflare-shop.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('audit-cloudflare-shop.ts', source, ts.ScriptTarget.ESNext, true)
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'nativeShopRuntimeOptions'
  )
  expect(declaration, 'actual compiled-shop queue transport factory required').toBeDefined()
  // Execute only the actual options factory, never the full audit, business
  // helpers, assets or a browser. The receiver below tests the real Queue API.
  const compiled = ts.transpileModule(declaration!.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const exports: {
    nativeShopRuntimeOptions?: (
      options: Parameters<typeof convertV4MiniflareOptions>[0],
      secret: string
    ) => ReturnType<typeof convertV4MiniflareOptions>
  } = {}
  new Function('exports', 'convertV4MiniflareOptions', 'assert', compiled.outputText)(exports, converter, assert)
  return exports.nativeShopRuntimeOptions!
}

async function capturedTopology() {
  const captured: Parameters<typeof convertV4MiniflareOptions>[0][] = []
  const factory = await actualTransportFactory((options) => {
    captured.push(options)
    return convertV4MiniflareOptions(options)
  })
  const original = {
    name: 'topology-shop',
    modules: true,
    script: 'export default {fetch(){return new Response("original bytes")},queue(){}}',
    compatibilityDate: '2026-08-15',
    compatibilityFlags: ['nodejs_compat'],
    bindings: { AUTH_ENABLED: 'true', PUBLIC_SITE_ORIGIN: 'https://shop-audit.neteco.test' },
    d1Databases: { DB: '00000000-0000-4000-8000-000000000001' },
    kvNamespaces: { CACHE: 'topology-cache' },
    r2Buckets: { MEDIA: 'topology-media' },
    queueProducers: { ASYNC_JOBS: 'shop-audit-jobs' },
    queueConsumers: ['shop-audit-jobs'],
    routes: ['https://shop-audit.neteco.test/*'],
    unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }],
    assets: {
      directory: '/not-opened-by-options-converter',
      binding: 'ASSETS',
      run_worker_first: true,
      routerConfig: { has_user_worker: true }
    },
    durableObjects: {
      STRING_LOCAL: 'StringLocal',
      SQLITE_LOCAL: { className: 'SqliteLocal', useSQLite: true },
      EXTERNAL: { className: 'External', scriptName: 'other-worker', useSQLite: true }
    },
    workflows: {
      LOCAL: { className: 'LocalFlow', name: 'local-flow' },
      EXTERNAL: { className: 'ExternalFlow', name: 'external-flow', scriptName: 'flow-owner' }
    },
    outboundService: () => new Response('Outbound forbidden', { status: 503 })
  } satisfies Parameters<typeof convertV4MiniflareOptions>[0]
  const before = JSON.stringify(original)
  factory(original, 'disposable-topology-secret-01234567890123456789')
  expect(captured).toHaveLength(1)
  const options = captured[0]!
  assert('workers' in options && options.workers)
  return { original, before, workers: options.workers }
}

it('preserves the original HTTP/assets worker identity and source bytes while adding only a private queue sibling', async () => {
  const { original, before, workers } = await capturedTopology()
  expect(workers).toHaveLength(3)
  expect(workers[0]).toBe(original)
  expect(JSON.stringify(original)).toBe(before)
  const sibling = workers[1]!
  expect(sibling.name).toBe('topology-shop-audit-queue')
  expect(sibling.script).toBe(original.script)
  for (const field of ['assets', 'routes', 'queueConsumers', 'unsafeDirectSockets'] as const) {
    expect(sibling[field]).toBeUndefined()
  }
  expect(workers[2]?.serviceBindings).toEqual({ SHOP: sibling.name })
})

it('shares explicit data/producer bindings, flags and outbound policy with the private queue sibling', async () => {
  const { original, workers } = await capturedTopology()
  const sibling = workers[1]!
  for (const field of [
    'd1Databases',
    'kvNamespaces',
    'r2Buckets',
    'queueProducers',
    'bindings',
    'compatibilityFlags',
    'outboundService'
  ] as const) {
    expect(sibling[field]).toBe(original[field])
  }
  expect(sibling.compatibilityDate).toBe(original.compatibilityDate)
  expect(sibling.modules).toBe(original.modules)
})

it('targets original local DO/workflow identities while preserving explicit external owners in the options contract', async () => {
  const { original, workers } = await capturedTopology()
  const sibling = workers[1]!
  expect(sibling.durableObjects).toEqual({
    STRING_LOCAL: { className: 'StringLocal', scriptName: original.name },
    SQLITE_LOCAL: { className: 'SqliteLocal', scriptName: original.name, useSQLite: true },
    EXTERNAL: original.durableObjects.EXTERNAL
  })
  expect(sibling.workflows).toEqual({
    LOCAL: { ...original.workflows.LOCAL, scriptName: original.name },
    EXTERNAL: original.workflows.EXTERNAL
  })
  // This inspects the actual factory's converter input; it does not claim
  // runtime execution or persistence of a Durable Object/Workflow instance.
})

it('delivers exact queue events inside workerd while rejecting unauthorised or malformed transport requests', async () => {
  const nativeShopRuntimeOptions = await actualTransportFactory()
  const secret = 'disposable-queue-transport-proof-01234567890123456789'
  const options = nativeShopRuntimeOptions(
    {
      name: 'neteco-shop-local-audit',
      modules: true,
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      kvNamespaces: { PROOF: 'neteco-queue-transport-test' },
      script: `export default {
      async fetch(request,env){return Response.json(JSON.parse(await env.PROOF.get('proof')||'null'))},
      async queue(batch,env){await env.PROOF.put('proof',JSON.stringify({queue:batch.queue,messages:batch.messages.map(message=>({id:message.id,body:message.body,attempts:message.attempts}))}));batch.ackAll()}
    }`
    },
    secret
  )
  const runtime = new Miniflare(options)
  const message = {
    type: 'admin.order-bulk.requested',
    groupId: '11111111-1111-4111-8111-111111111111',
    dispatchId: '22222222-2222-4222-8222-222222222222'
  }
  async function send(body: unknown, header = secret, path = '/consume', method = 'POST') {
    return runtime.dispatchFetch('https://bulk-transport.neteco.test' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-neteco-audit-transport': header },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
    })
  }
  async function proof() {
    const response = await runtime.dispatchFetch('https://shop-audit.neteco.test/proof')
    expect(response.status).toBe(200)
    return response.json()
  }
  try {
    for (const [body, header, path, method, status] of [
      [message, '', '/consume', 'POST', 401],
      [message, secret + '-wrong', '/consume', 'POST', 401],
      [message, secret, '/wrong', 'POST', 404],
      [null, secret, '/consume', 'GET', 405],
      [{ ...message, groupId: 'invalid' }, secret, '/consume', 'POST', 400],
      [{ ...message, extra: 'unapproved' }, secret, '/consume', 'POST', 400],
      [{ ...message, type: 'financial.execute' }, secret, '/consume', 'POST', 400],
      [{ ...message, extra: 'x'.repeat(4097) }, secret, '/consume', 'POST', 413]
    ] as const) {
      const response = await send(body, header, path, method)
      expect(response.status).toBe(status)
      expect(response.headers.get('cache-control')).toContain('no-store')
      await response.text()
      expect(await proof()).toBeNull()
    }
    const accepted = await send(message)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({ outcome: 'ok', ackAll: true })
    expect(await proof()).toEqual({
      queue: 'shop-audit-jobs',
      messages: [{ id: expect.any(String), body: message, attempts: 1 }]
    })
  } finally {
    await runtime.dispose()
  }
}, 30000)

it.each(['ack', 'retry', 'producer-ack'] as const)(
  'supports real per-message %s after an awaited workerd operation',
  async (mode) => {
    const nativeShopRuntimeOptions = await actualTransportFactory()
    const secret = 'disposable-per-message-queue-proof-01234567890123456789'
    const message = {
      type: 'admin.order-bulk.requested',
      groupId: '11111111-1111-4111-8111-111111111111',
      dispatchId: '22222222-2222-4222-8222-222222222222'
    }
    const runtime = new Miniflare(
      nativeShopRuntimeOptions(
        {
          name: 'neteco-shop-local-audit',
          modules: true,
          compatibilityDate: '2026-08-15',
          compatibilityFlags: ['nodejs_compat'],
          cf: false,
          telemetry: { enabled: false },
          log: new NoOpLog(),
          bindings: { MODE: mode },
          kvNamespaces: { PROOF: `neteco-per-message-${mode}` },
          // The real compiled shop has this producer, but does not configure a
          // Miniflare queue consumer. Keep that topology: no fake send/ack methods.
          queueProducers: { ASYNC_JOBS: 'shop-audit-jobs' },
          outboundService: () => new Response('Outbound forbidden', { status: 503 }),
          script: `export default {
        async fetch(request,env) {
          return Response.json(JSON.parse(await env.PROOF.get('proof') || 'null'));
        },
        async queue(batch,env) {
          for (const message of batch.messages) {
            await env.PROOF.put('before', JSON.stringify(message.body));
            if (env.MODE === 'producer-ack') {
              await env.ASYNC_JOBS.send(message.body);
            }
            if (env.MODE === 'retry') message.retry({delaySeconds:60});
            else message.ack();
            await env.PROOF.put('proof', JSON.stringify({
              mode:env.MODE, body:message.body, attempts:message.attempts,
              prior:JSON.parse(await env.PROOF.get('before')),
              decision:env.MODE === 'retry' ? 'retry' : 'ack'
            }));
          }
        }
      }`
        },
        secret
      )
    )
    try {
      const response = await runtime.dispatchFetch('https://bulk-transport.neteco.test/consume', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-neteco-audit-transport': secret },
        body: JSON.stringify(message)
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        outcome: 'ok',
        ackAll: false,
        retryBatch: false,
        retryMessages: mode === 'retry' ? 1 : 0,
        explicitAcks: mode === 'retry' ? 0 : 1
      })
      const proof = await runtime.dispatchFetch('https://shop-audit.neteco.test/proof')
      expect(proof.status).toBe(200)
      expect(await proof.json()).toEqual({
        mode,
        body: message,
        attempts: 1,
        prior: message,
        decision: mode === 'retry' ? 'retry' : 'ack'
      })
    } finally {
      await runtime.dispose()
    }
  },
  30000
)

it('delivers queue events to the actual user worker when the shop also has its real assets routing topology', async () => {
  const nativeShopRuntimeOptions = await actualTransportFactory()
  const directory = await mkdtemp(join(tmpdir(), 'neteco-queue-assets-proof-'))
  let runtime: Miniflare | undefined
  try {
    await writeFile(join(directory, 'index.txt'), 'asset-proof\n'.padEnd(256, '.'), { flag: 'wx', mode: 0o600 })
    const secret = 'disposable-assets-queue-proof-01234567890123456789'
    const message = {
      type: 'admin.order-bulk.requested',
      groupId: '11111111-1111-4111-8111-111111111111',
      dispatchId: '22222222-2222-4222-8222-222222222222'
    }
    runtime = new Miniflare(
      nativeShopRuntimeOptions(
        {
          name: 'neteco-shop-local-audit',
          modules: true,
          compatibilityDate: '2026-08-15',
          compatibilityFlags: ['nodejs_compat'],
          cf: false,
          telemetry: { enabled: false },
          log: new NoOpLog(),
          kvNamespaces: { PROOF: 'neteco-assets-queue-proof' },
          durableObjects: { SHARED_PROOF: { className: 'SharedQueueProof', useSQLite: true } },
          workflows: { PROOF_WORKFLOW: { className: 'TopologyWorkflow', name: 'neteco-queue-topology-proof' } },
          assets: {
            directory,
            binding: 'ASSETS',
            run_worker_first: true,
            routerConfig: { has_user_worker: true },
            assetConfig: { html_handling: 'none', not_found_handling: 'none' }
          },
          outboundService: () => new Response('Outbound forbidden', { status: 503 }),
          script: `import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';
      export class SharedQueueProof extends DurableObject {
        constructor(ctx,env) {
          super(ctx,env);
          this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL)');
          this.ctx.storage.sql.exec('INSERT OR IGNORE INTO counter(id,value) VALUES (1,0)');
        }
        async fetch(request) {
          if(request.method === 'POST') this.ctx.storage.sql.exec('UPDATE counter SET value=value+1 WHERE id=1');
          return Response.json(this.ctx.storage.sql.exec('SELECT value FROM counter WHERE id=1').one().value);
        }
      }
      export class TopologyWorkflow extends WorkflowEntrypoint {
        async run() { throw new Error('Workflow must not execute in this topology test'); }
      }
      export default {
        async fetch(request,env) {
          if(new URL(request.url).pathname === '/index.txt') return env.ASSETS.fetch(request);
          const counter=await env.SHARED_PROOF.get(env.SHARED_PROOF.idFromName('shared')).fetch('https://proof.invalid/read');
          return Response.json({proof:JSON.parse(await env.PROOF.get('proof') || 'null'),counter:await counter.json(),workflowBound:typeof env.PROOF_WORKFLOW.create === 'function'});
        },
        async queue(batch,env) {
          for(const message of batch.messages) {
            const increment=await env.SHARED_PROOF.get(env.SHARED_PROOF.idFromName('shared')).fetch('https://proof.invalid/increment',{method:'POST'});
            if(!increment.ok || await increment.json() !== 1) throw new Error('Unconfirmed shared SQLite increment');
            await env.PROOF.put('proof',JSON.stringify({body:message.body,attempts:message.attempts}));
            message.ack();
          }
        }
      }`
        },
        secret
      )
    )
    // Prove this is an assets-enabled deployment, not merely an unused option.
    const asset = await runtime.dispatchFetch('https://shop-audit.neteco.test/index.txt')
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('asset-proof\n'.padEnd(256, '.'))
    const initial = await runtime.dispatchFetch('https://shop-audit.neteco.test/proof')
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({ proof: null, counter: 0, workflowBound: true })
    const response = await runtime.dispatchFetch('https://bulk-transport.neteco.test/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-neteco-audit-transport': secret },
      body: JSON.stringify(message)
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      outcome: 'ok',
      ackAll: false,
      retryBatch: false,
      retryMessages: 0,
      explicitAcks: 1
    })
    const proof = await runtime.dispatchFetch('https://shop-audit.neteco.test/proof')
    expect(proof.status).toBe(200)
    expect(await proof.json()).toEqual({ proof: { body: message, attempts: 1 }, counter: 1, workflowBound: true })
  } finally {
    try {
      await runtime?.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}, 30000)
