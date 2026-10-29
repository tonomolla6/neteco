import assert from 'node:assert/strict'
import { auditCatalogFileScale } from './lib/catalog-file-scale'

// Explicit heavy local-only file proof. Run serially only with the operator's
// permission: npx tsx scripts/audit-catalog-file-scale.ts
assert.equal(process.argv.slice(2).length, 0, 'File scale audit accepts no flags or remote targets')
const started = performance.now()
try {
  const evidence = await auditCatalogFileScale(25_000, (phase, metrics) =>
    console.log(JSON.stringify({ phase, status: metrics ? 'completed' : 'started', ...metrics }))
  )
  console.log(JSON.stringify(evidence))
  if (!evidence.fullFilePassed) process.exitCode = 1
} catch (error) {
  console.error(
    JSON.stringify({
      fullFilePassed: false,
      error: error instanceof Error ? error.message : 'unknown_failure',
      elapsedMs: Math.round(performance.now() - started),
      peakRssKiB: process.resourceUsage().maxRSS
    })
  )
  process.exitCode = 1
}
