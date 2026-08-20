import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { auditWorkerManifest, type WorkerBundleManifest } from './lib/worker-bundle-policy'

const manifestPath = resolve(process.argv[2] || '.wrangler/canary-meta.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as WorkerBundleManifest
const { inspected, violations } = auditWorkerManifest(manifest)

if (violations.length) {
  console.error(`Worker bundle contains forbidden runtime dependencies:\n${violations.join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Worker bundle policy passed (${inspected} manifest entries inspected)`)
}
