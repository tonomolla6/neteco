import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { experimental_readRawConfig } from 'wrangler'
import { createSafePlatformConfig, createSafeVariables } from './lib/cloudflare-config-safety'

interface Resource {
  name?: string
  title?: string
  queue_name?: string
  id?: string
  uuid?: string
}

/** Pure projection: only exact isolated resources supplied by the resolver can
 * enter the config. Importing this module never reads credentials or calls APIs. */
export function createPreprodConfig(
  source: Record<string, unknown>,
  projectRoot: string,
  account: string,
  resources: ReadonlyMap<string, Resource>
): Record<string, unknown> {
  if (typeof account !== 'string' || !/^[0-9a-f]{32}$/.test(account)) throw new Error('invalid_preprod_account')
  for (const [kind, name] of [
    ['d1', 'neteco-preprod'],
    ['kv', 'neteco-preprod-cache'],
    ['r2', 'neteco-preprod-media'],
    ['queue', 'neteco-preprod-jobs'],
    ['dlq', 'neteco-preprod-jobs-dlq']
  ]) {
    const resource = resources.get(kind!)
    if (!resource || (resource.name ?? resource.title ?? resource.queue_name) !== name)
      throw new Error('invalid_preprod_resource_contract')
  }
  const databaseId = resources.get('d1')!.uuid
  const namespaceId = resources.get('kv')!.id
  if (
    typeof databaseId !== 'string' ||
    typeof namespaceId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(databaseId) ||
    !/^[0-9a-f]{32}$/.test(namespaceId) ||
    databaseId === '00000000-0000-0000-0000-000000000000' ||
    namespaceId === '00000000000000000000000000000000'
  )
    throw new Error('invalid_resource_identifier')
  const config = createSafePlatformConfig(source)
  const outputDirectory = resolve(projectRoot, '.wrangler/preprod')
  return {
    ...config,
    name: 'neteco-shop-preprod',
    account_id: account,
    main: relative(outputDirectory, resolve(projectRoot, 'workers/canary.ts')),
    vars: createSafeVariables(source, 'preprod'),
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'neteco-preprod',
        database_id: databaseId,
        migrations_dir: relative(outputDirectory, resolve(projectRoot, 'db/d1/migrations')),
        remote: false
      }
    ],
    kv_namespaces: [{ binding: 'CACHE', id: namespaceId, remote: false }],
    r2_buckets: [{ binding: 'MEDIA', bucket_name: 'neteco-preprod-media', jurisdiction: 'eu', remote: false }],
    queues: {
      producers: [{ binding: 'ASYNC_JOBS', queue: 'neteco-preprod-jobs', remote: false }],
      consumers: [
        {
          queue: 'neteco-preprod-jobs',
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 3,
          dead_letter_queue: 'neteco-preprod-jobs-dlq'
        }
      ]
    },
    workflows: [
      { name: 'neteco-preprod-catalog', binding: 'CATALOG_WORKFLOW', class_name: 'CanaryWorkflow' }
    ],
    // Native rate-limit namespaces are account-unique: stable isolated project IDs.
    ratelimits: config.ratelimits.map((binding, index) => ({
      ...binding,
      namespace_id: String(9_706_001 + index)
    }))
  }
}

/** Idempotent bootstrap for Neteco's isolated preproduction resources.
 * Default is read-only. --apply creates missing resources, never deletes or deploys.
 * Resource identifiers only enter the ignored generated Wrangler configuration.
 */
async function runPreprodCli() {
  const apply = process.argv.includes('--apply')
  const generate = apply || process.argv.includes('--generate')
  const credentialsArgument = process.argv.indexOf('--credentials-file')
  let account = process.env.CLOUDFLARE_ACCOUNT_ID ?? ''
  let token = process.env.CLOUDFLARE_API_TOKEN ?? ''
  if (credentialsArgument !== -1) {
    const path = process.argv[credentialsArgument + 1]
    if (!path) throw new Error('credentials_file_required')
    const content = await readFile(path, 'utf8')
    const values = Object.fromEntries(
      content
        .split(/\r?\n/)
        .filter((line) => line.includes('='))
        .map((line) => {
          const separator = line.indexOf('=')
          return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
        })
    )
    account = values['IDCUENTA_mail@tonomolla.es'] ?? ''
    token = values['TOKEN_mail@tonomolla.es'] ?? ''
  }
  if (!/^[0-9a-f]{32}$/.test(account) || !token) throw new Error('cloudflare_credentials_required')

  async function api(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
    const payload = (await response.json()) as {
      success: boolean
      result: unknown
      result_info?: { total_pages?: number }
      errors?: { code: number }[]
    }
    if (!response.ok || !payload.success)
      throw new Error(
        `cloudflare_api_failed:${response.status}:${payload.errors?.map((error) => error.code).join(',') ?? 'unknown'}`
      )
    return payload
  }

  const zone = await api(`/zones?name=neteco.es&account.id=${account}`)
  if (
    !Array.isArray(zone.result) ||
    zone.result.length !== 1 ||
    zone.result[0].name !== 'neteco.es' ||
    zone.result[0].account.id !== account
  )
    throw new Error('neteco_account_not_confirmed')

  const accountPath = `/accounts/${account}`
  async function list(path: string, headers?: Record<string, string>): Promise<Resource[]> {
    const rows: Resource[] = []
    for (let page = 1; ; page++) {
      const payload = await api(
        `${accountPath}${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        'GET',
        undefined,
        headers
      )
      const result = payload.result as Resource[] | { buckets?: Resource[]; queues?: Resource[] }
      rows.push(...(Array.isArray(result) ? result : (result.buckets ?? result.queues ?? [])))
      if (page >= (payload.result_info?.total_pages ?? 1)) return rows
    }
  }

  const specifications = [
    { kind: 'd1', name: 'neteco-preprod', path: '/d1/database', body: { name: 'neteco-preprod', jurisdiction: 'eu' } },
    {
      kind: 'kv',
      name: 'neteco-preprod-cache',
      path: '/storage/kv/namespaces',
      body: { title: 'neteco-preprod-cache' }
    },
    {
      kind: 'r2',
      name: 'neteco-preprod-media',
      path: '/r2/buckets',
      body: { name: 'neteco-preprod-media' },
      headers: { 'cf-r2-jurisdiction': 'eu' }
    },
    { kind: 'queue', name: 'neteco-preprod-jobs', path: '/queues', body: { queue_name: 'neteco-preprod-jobs' } },
    { kind: 'dlq', name: 'neteco-preprod-jobs-dlq', path: '/queues', body: { queue_name: 'neteco-preprod-jobs-dlq' } }
  ] as const
  const resources = new Map<string, Resource>()
  for (const specification of specifications) {
    const headers = 'headers' in specification ? specification.headers : undefined
    const matches = (await list(specification.path, headers)).filter(
      (row) => (row.name ?? row.title ?? row.queue_name) === specification.name
    )
    if (matches.length > 1) throw new Error(`ambiguous_resource:${specification.kind}`)
    let resource = matches[0]
    let state = resource ? 'existing' : 'missing'
    if (!resource && apply) {
      resource = (await api(`${accountPath}${specification.path}`, 'POST', specification.body, headers))
        .result as Resource
      state = 'created'
    }
    if (resource) resources.set(specification.kind, resource)
    console.log(JSON.stringify({ resource: specification.name, state }))
  }

  if (resources.size === specifications.length) {
    const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.canary.jsonc' }) as {
      rawConfig: Record<string, unknown>
    }
    const output = resolve('.wrangler/preprod/wrangler.json')
    const outputDirectory = resolve('.wrangler/preprod')
    const config = createPreprodConfig(rawConfig, process.cwd(), account, resources)
    if (generate) {
      await mkdir(outputDirectory, { recursive: true })
      await writeFile(output, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
      console.log(JSON.stringify({ configuration: '.wrangler/preprod/wrangler.json', deployed: false }))
    } else console.log(JSON.stringify({ configurationReady: true, generateRequired: true }))
  } else if (generate) {
    throw new Error('preprod_resources_missing')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await runPreprodCli()
