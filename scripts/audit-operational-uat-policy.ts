import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { operationalUatCriteriaDigest, validateOperationalUatPolicy } from './lib/operational-uat'

const path = resolve('docs/testing/operational-uat-policy.json')
const [policySource, workflow, packageSource] = await Promise.all([
  readFile(path, 'utf8'),
  readFile(resolve('.github/workflows/staging-uat.yml'), 'utf8'),
  readFile(resolve('package.json'), 'utf8')
])
const policy = validateOperationalUatPolicy(JSON.parse(policySource))
const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> }
const problems: string[] = []
for (const [script, target] of Object.entries({
  'audit:uat:policy': 'scripts/audit-operational-uat-policy.ts',
  'audit:uat': 'scripts/audit-operational-uat.ts',
  'uat:preflight': 'scripts/run-operational-uat-preflight.ts',
  'uat:inventory': 'scripts/operational-uat-inventory-evidence.ts'
})) {
  if (!packageJson.scripts[script]?.includes(target)) problems.push(`Package script ${script} is not governed`)
}
for (const token of [
  'workflow_dispatch:',
  'expected_commit:',
  'ref: ${{ inputs.expected_commit }}',
  'ref: ${{ github.sha }}',
  'UAT_EVIDENCE_REPOSITORY_ROOT: uat-evidence-source',
  'evidence_path:',
  'environment: staging',
  'UAT_STAGING_URL: ${{ vars.UAT_STAGING_URL }}',
  'UAT_PRODUCTION_URL: ${{ vars.UAT_PRODUCTION_URL }}',
  'npm run audit:uat:policy',
  'npm run uat:preflight',
  'npm run audit:uat --',
  'test-results/operational-uat-manifest.json',
  'test-results/operational-uat-evidence.json',
  'fetch-depth: 0',
  'if: always()',
  'retention-days: 30'
]) {
  if (!workflow.includes(token)) problems.push(`Staging UAT workflow is missing: ${token}`)
}
if (workflow.includes('continue-on-error')) problems.push('Staging UAT gate cannot continue on error')
if (problems.length) throw new Error(`Operational UAT governance is invalid:\n- ${problems.join('\n- ')}`)
process.stdout.write(
  `operational-uat-policy=PASS scripts=${policy.scripts.length} digest=${operationalUatCriteriaDigest(policy)}\n`
)
