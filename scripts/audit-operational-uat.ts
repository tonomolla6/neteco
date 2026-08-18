import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { redactArtifactText } from './lib/ci-artifacts'
import {
  validateOperationalUatEvidence,
  validateOperationalUatPreflight,
  verifyOperationalUatRepositoryArtifacts
} from './lib/operational-uat'

const execFileAsync = promisify(execFile)
const args = process.argv.slice(2)
const evidencePath = args.find((argument) => !argument.startsWith('--'))
const commitArgument = args.find((argument) => argument.startsWith('--expected-commit='))
const urlArgument = args.find((argument) => argument.startsWith('--expected-url='))
const productionUrlArgument = args.find((argument) => argument.startsWith('--production-url='))
const currentPreflightArgument = args.find((argument) => argument.startsWith('--current-preflight='))
const evidenceRepositoryArgument = args.find((argument) => argument.startsWith('--evidence-repository-root='))
const historical = args.includes('--historical')

const expectedCommit = commitArgument?.slice('--expected-commit='.length) ?? process.env.UAT_EXPECTED_COMMIT?.trim()
const expectedUrl = urlArgument?.slice('--expected-url='.length) ?? process.env.UAT_STAGING_URL?.trim()
const productionUrl = productionUrlArgument?.slice('--production-url='.length) ?? process.env.UAT_PRODUCTION_URL?.trim()
const currentPreflightPath =
  currentPreflightArgument?.slice('--current-preflight='.length) ??
  process.env.UAT_CURRENT_PREFLIGHT?.trim() ??
  'test-results/operational-uat-preflight.json'
const evidenceRepositoryPath =
  evidenceRepositoryArgument?.slice('--evidence-repository-root='.length) ??
  process.env.UAT_EVIDENCE_REPOSITORY_ROOT?.trim() ??
  '.'
if (!evidencePath || !expectedCommit || !expectedUrl || !productionUrl) {
  throw new Error(
    'Usage: npm run audit:uat -- <uat-evidence.json> --expected-commit=<40-character SHA> --expected-url=<staging HTTPS URL> --production-url=<production HTTPS URL> [--current-preflight=<path>] [--evidence-repository-root=<path>] [--historical]'
  )
}

const repositoryRoot = resolve('.')
const realEvidenceRepositoryRoot = await realpath(resolve(evidenceRepositoryPath))
if (realEvidenceRepositoryRoot !== repositoryRoot && !realEvidenceRepositoryRoot.startsWith(`${repositoryRoot}/`)) {
  throw new Error('Operational UAT evidence repository must remain inside the checkout')
}
async function repositoryFile(inputPath: string, label: string, allowedRoot = repositoryRoot) {
  const absolutePath = resolve(inputPath)
  if (!absolutePath.startsWith(`${allowedRoot}/`)) {
    throw new Error(`${label} path must remain inside its repository`)
  }
  const resolvedPath = await realpath(absolutePath)
  if (!resolvedPath.startsWith(`${allowedRoot}/`)) {
    throw new Error(`${label} symlink must remain inside its repository`)
  }
  return resolvedPath
}

const [realEvidencePath, realCurrentPreflightPath] = await Promise.all([
  repositoryFile(evidencePath, 'Operational UAT evidence', realEvidenceRepositoryRoot),
  repositoryFile(currentPreflightPath, 'Current operational UAT preflight')
])
const [policyValue, evidenceContents, currentPreflightContents] = await Promise.all([
  readFile(resolve('docs/testing/operational-uat-policy.json'), 'utf8').then(JSON.parse),
  readFile(realEvidencePath),
  readFile(realCurrentPreflightPath)
])
const { evidence, criteriaDigest, approvalPayloadDigest } = validateOperationalUatEvidence(
  JSON.parse(evidenceContents.toString('utf8')),
  policyValue,
  expectedCommit,
  expectedUrl,
  productionUrl
)
const verifiedRepositoryArtifacts = await verifyOperationalUatRepositoryArtifacts(evidence, realEvidenceRepositoryRoot)
const currentPreflight = validateOperationalUatPreflight(
  JSON.parse(currentPreflightContents.toString('utf8')),
  evidence.release.commitSha,
  evidence.release.environmentUrl
)

const now = Date.now()
const currentPreflightAge = now - Date.parse(currentPreflight.generatedAt)
if (currentPreflightAge < 0 || currentPreflightAge > 15 * 60_000) {
  throw new Error('Current operational UAT preflight must have completed within the last 15 minutes')
}
if (Date.parse(currentPreflight.generatedAt) < Date.parse(evidence.trafficDecision.approvedAt)) {
  throw new Error('Current operational UAT preflight must run after the signed traffic decision')
}
if (Date.parse(evidence.trafficDecision.approvedAt) > now) {
  throw new Error(`Operational UAT traffic approval is dated in the future: ${evidence.trafficDecision.approvedAt}`)
}
if (!historical && now > Date.parse(evidence.trafficDecision.validUntil)) {
  throw new Error(`Operational UAT traffic approval expired at ${evidence.trafficDecision.validUntil}`)
}

await execFileAsync('git', ['cat-file', '-e', `${evidence.release.commitSha}^{commit}`])
await execFileAsync('git', ['merge-base', '--is-ancestor', evidence.release.commitSha, 'HEAD'])
await execFileAsync('git', [
  '-C',
  realEvidenceRepositoryRoot,
  'cat-file',
  '-e',
  `${evidence.release.commitSha}^{commit}`
])
await execFileAsync('git', [
  '-C',
  realEvidenceRepositoryRoot,
  'merge-base',
  '--is-ancestor',
  evidence.release.commitSha,
  'HEAD'
])
const governedPaths = [
  'docs/testing/operational-uat-policy.json',
  'scripts/lib/operational-uat.ts',
  'scripts/audit-operational-uat.ts',
  'scripts/audit-operational-uat-policy.ts',
  'scripts/run-operational-uat-preflight.ts',
  'scripts/lib/operational-uat-inventory.ts',
  'scripts/lib/ci-artifacts.ts',
  'scripts/operational-uat-inventory-evidence.ts',
  'server/api/health/live.get.ts',
  '.github/workflows/staging-uat.yml',
  'package.json',
  'package-lock.json',
  '.node-version'
]
const { stdout: changedGovernance } = await execFileAsync('git', [
  'diff',
  '--name-only',
  evidence.release.commitSha,
  'HEAD',
  '--',
  ...governedPaths
])
const [{ stdout: unstagedGovernance }, { stdout: stagedGovernance }, { stdout: untrackedGovernance }] =
  await Promise.all([
    execFileAsync('git', ['diff', '--name-only', '--', ...governedPaths]),
    execFileAsync('git', ['diff', '--cached', '--name-only', '--', ...governedPaths]),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '--', ...governedPaths])
  ])
const governanceChanges = [
  ...new Set([changedGovernance, unstagedGovernance, stagedGovernance, untrackedGovernance].join('\n').split('\n'))
]
  .filter(Boolean)
  .sort()
if (governanceChanges.length) {
  throw new Error(`Operational UAT governance differs from the tested commit:\n${governanceChanges.join('\n')}`)
}

const publishedManifest = redactArtifactText(`${JSON.stringify(evidence, null, 2)}\n`)
await mkdir(resolve('test-results'), { recursive: true })
await writeFile(resolve('test-results/operational-uat-manifest.json'), publishedManifest.text, 'utf8')
const evidenceIndex = {
  schemaVersion: 1,
  requirementId: 'TST-040',
  status: 'evidence-valid',
  generatedAt: new Date(now).toISOString(),
  release: {
    id: evidence.release.id,
    commitSha: evidence.release.commitSha,
    environmentOrigin: new URL(evidence.release.environmentUrl).origin
  },
  criteriaDigest,
  approvalPayloadDigest,
  approvedManifest: {
    path: relative(repositoryRoot, realEvidencePath),
    sha256: createHash('sha256').update(evidenceContents).digest('hex')
  },
  sessionPreflight: (() => {
    const artifact = evidence.artifacts.find((candidate) => candidate.kind === 'staging-preflight')!
    return { artifactId: artifact.id, path: artifact.uri, sha256: artifact.sha256, recordedAt: artifact.recordedAt }
  })(),
  currentPreflight: {
    path: relative(repositoryRoot, realCurrentPreflightPath),
    sha256: createHash('sha256').update(currentPreflightContents).digest('hex'),
    generatedAt: currentPreflight.generatedAt
  },
  repositoryArtifactsVerified: verifiedRepositoryArtifacts,
  trafficDecision: evidence.trafficDecision
}
await writeFile(
  resolve('test-results/operational-uat-evidence.json'),
  `${JSON.stringify(evidenceIndex, null, 2)}\n`,
  'utf8'
)

process.stdout.write(
  `operational-uat=AUDIT_PASS release=${evidence.release.id} commit=${evidence.release.commitSha} scripts=${evidence.results.length} defects=${evidence.defects.length} repositoryArtifacts=${verifiedRepositoryArtifacts} redactions=${publishedManifest.redactions} traffic=${evidence.trafficDecision.currentPercent}->${evidence.trafficDecision.targetPercent} criteria=${criteriaDigest} approvalPayload=${approvalPayloadDigest}\n`
)
