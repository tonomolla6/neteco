import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { validateManualAccessibilityEvidence } from './lib/manual-accessibility-evidence'

const args = process.argv.slice(2)
const evidencePath = args.find((argument) => !argument.startsWith('--'))
const commitArgument = args.find((argument) => argument.startsWith('--expected-commit='))
if (!evidencePath) {
  throw new Error(
    'Usage: npm run audit:a11y:manual -- <manual-accessibility.json> [--expected-commit=<40-character SHA>]'
  )
}

const expectedCommit = commitArgument?.slice('--expected-commit='.length) ?? process.env.GITHUB_SHA
const absolutePath = resolve(evidencePath)
const value: unknown = JSON.parse(await readFile(absolutePath, 'utf8'))
const evidence = validateManualAccessibilityEvidence(value, expectedCommit)
process.stdout.write(
  `manual-accessibility=PASS release=${evidence.release.id} commit=${evidence.release.commitSha} checks=${evidence.checks.length} artifacts=${evidence.artifacts.length}\n`
)
