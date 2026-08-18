import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import postgres from 'postgres'
import {
  assertOperationalUatInventoryEvidence,
  collectOperationalUatInventoryEvidence,
  validateOperationalUatInventoryContext
} from './lib/operational-uat-inventory'

const args = process.argv.slice(2)
const argument = (name: string) => args.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3)
const publicNumber = argument('order') ?? argument('order-number') ?? process.env.UAT_ORDER_NUMBER?.trim()
const caseId = argument('case') ?? process.env.UAT_INVENTORY_CASE?.trim()
const expectedCommit = argument('expected-commit') ?? process.env.UAT_EXPECTED_COMMIT?.trim()
const repositoryRoot = resolve('.')
const outputInput =
  argument('output') ??
  process.env.UAT_INVENTORY_EVIDENCE_OUTPUT ??
  (publicNumber ? `test-results/uat-inventory-${publicNumber}.json` : 'test-results/uat-inventory.json')
const output = resolve(outputInput)

if (!publicNumber || !expectedCommit || !caseId) {
  throw new Error(
    'Usage: npm run uat:inventory -- --order=<public-order-number> --case=<baseline|pickup|cancellation|return> --expected-commit=<40-character SHA> [--output=<path>]'
  )
}
const allowedOutputRoots = [resolve('test-results'), resolve('evidence/uat')]
if (
  !output.endsWith('.json') ||
  !allowedOutputRoots.some((allowedRoot) => output.startsWith(`${allowedRoot}/`)) ||
  !output.startsWith(`${repositoryRoot}/`)
) {
  throw new Error('Inventory evidence output must be a new JSON file below test-results/ or evidence/uat/')
}

const context = validateOperationalUatInventoryContext({
  publicNumber,
  expectedCommit,
  appEnv: process.env.APP_ENV ?? '',
  appVersion: process.env.APP_VERSION ?? '',
  caseId
})
const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')

const sql = postgres(connection, { max: 1, connect_timeout: 10 })
let failed = false
try {
  const evidence = await collectOperationalUatInventoryEvidence(sql, context)
  await mkdir(dirname(output), { recursive: true })
  const outputDirectory = await realpath(dirname(output))
  if (
    !allowedOutputRoots.some(
      (allowedRoot) => outputDirectory === allowedRoot || outputDirectory.startsWith(`${allowedRoot}/`)
    )
  ) {
    throw new Error('Inventory evidence output directory escapes its allowed repository location')
  }
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  process.stdout.write(
    `uat-inventory-evidence=${evidence.status.toUpperCase()} order=${evidence.orderNumber} checks=${evidence.checks.filter((check) => check.pass).length}/${evidence.checks.length} output=${output}\n`
  )
  if (evidence.status !== 'pass') {
    failed = true
    try {
      assertOperationalUatInventoryEvidence(evidence)
    } catch (failure) {
      process.stderr.write(`${failure instanceof Error ? failure.message : 'Inventory evidence is incoherent'}\n`)
    }
  }
} finally {
  await sql.end({ timeout: 5 })
}
if (failed) process.exitCode = 2
