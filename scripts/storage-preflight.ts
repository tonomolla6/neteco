import { tmpdir } from 'node:os'
import { storagePreflight } from './lib/storage-preflight.ts'

// Explicit arguments only; no environment/report-file dumps or automatic
// cleanup. Overrides must still pass absolute, canonical directory admission.
async function main() {
  let workspace = process.cwd()
  let temporary = tmpdir()
  const seen = new Set<string>()
  for (const argument of process.argv.slice(2)) {
    const match = /^--(workspace|temporary)=(.+)$/.exec(argument)
    if (!match || seen.has(match[1]!)) {
      process.stdout.write(`${JSON.stringify({ pass: false, code: 'invalid_arguments' })}\n`)
      process.exitCode = 1
      return
    }
    seen.add(match[1]!)
    if (match[1] === 'workspace') workspace = match[2]!
    else temporary = match[2]!
  }
  const report = await storagePreflight([
    { label: 'workspace', path: workspace },
    { label: 'temporary', path: temporary }
  ])
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.exitCode = report.pass ? 0 : 1
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ pass: false, code: 'preflight_unavailable' })}\n`)
  process.exitCode = 1
})
