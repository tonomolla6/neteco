import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { auditWorkerManifest, type WorkerBundleManifest } from './lib/worker-bundle-policy'
import { originalWorkerSources } from './lib/worker-source-map'

/** Wrangler sees the generated Nitro chunks as inputs. Inspect their original
 * source maps too, so Rollup cannot hide a forbidden legacy dependency. */
const directory = resolve('.output-cloudflare/server')
const manifest = JSON.parse(await readFile(resolve('.wrangler/shop-meta.json'), 'utf8')) as WorkerBundleManifest
const sources = new Set<string>()
async function scan(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (entry.isDirectory()) await scan(file)
    else if (entry.isFile() && entry.name.endsWith('.map')) {
      const map: unknown = JSON.parse(await readFile(file, 'utf8'))
      for (const source of originalWorkerSources(map)) sources.add(source)
    }
  }
}
await scan(directory)
if (!sources.size) throw new Error('nitro_source_map_evidence_missing')
// Validate the original esbuild evidence separately. Fabricating inputs from
// source maps must never make an empty or corrupt Wrangler manifest pass.
const result = auditWorkerManifest(manifest, sources)
const legacySources = [...sources].filter((source) =>
  /(?:^|\/)server\/(?:api|middleware|db|integrations|services)\//.test(source)
)
const violations = [...new Set([...result.violations, ...legacySources])]
if (violations.length) {
  console.error(`Full shop bundle contains forbidden legacy dependencies:\n${violations.join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Full shop bundle policy passed (${result.inspected} entries, ${sources.size} original Nitro sources)`)
}
