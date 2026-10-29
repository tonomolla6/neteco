import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import {
  classifyGitleaksProbeResult,
  GITLEAKS_POLICY_CASES,
  probeGitleaksPolicy
} from '../../scripts/lib/gitleaks-policy-probe.mjs'

describe('Gitleaks policy probe result contract (not scanner acceptance)', () => {
  const control = GITLEAKS_POLICY_CASES[0]

  it('requires a matching private-key detection, not merely an arbitrary scanner finding', () => {
    expect(classifyGitleaksProbeResult(control, 0, []).passed).toBe(false)
    expect(
      classifyGitleaksProbeResult(control, 23, [{ Secret: 'REDACTED', RuleID: 'other', File: control.path }]).passed
    ).toBe(false)
    expect(
      classifyGitleaksProbeResult(control, 23, [{ Secret: 'REDACTED', RuleID: 'private-key', File: control.path }])
        .passed
    ).toBe(true)
  })

  it('fails closed for process errors, missing reports and inconsistent exits', () => {
    for (const [exit, report] of [
      [1, []],
      [null, []],
      [0, null],
      [23, []]
    ] as const) {
      expect(classifyGitleaksProbeResult(control, exit, report).passed).toBe(false)
    }
  })

  it('rejects unredacted evidence and never returns scanner metadata', () => {
    const unsafe = {
      Secret: 'synthetic-sensitive-value',
      Match: 'do not expose',
      Author: 'private',
      RuleID: 'private-key',
      File: control.path
    }
    const result = classifyGitleaksProbeResult(control, 23, [unsafe])
    expect(result).toEqual({ case: 'control', passed: false, outcome: 'unsafe_report', findings: null })
    const safe = classifyGitleaksProbeResult(control, 23, [{ ...unsafe, Secret: 'REDACTED' }])
    expect(Object.keys(safe).sort()).toEqual(['case', 'findings', 'outcome', 'passed'])
    expect(JSON.stringify(safe)).not.toContain('private')
    expect(JSON.stringify(safe)).not.toContain('do not expose')
  })

  it('accepts placeholders only when the scanner reports a successful clean scan', () => {
    const placeholders = GITLEAKS_POLICY_CASES.find((item) => item.id === 'placeholders')
    expect(classifyGitleaksProbeResult(placeholders, 0, []).passed).toBe(true)
    expect(classifyGitleaksProbeResult(placeholders, 1, []).passed).toBe(false)
  })
})

describe('Gitleaks blocking integration (fault injection, not scanner acceptance)', () => {
  async function withFixture(run: (directory: string, policy: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), 'neteco-gitleaks-probe-test-'))
    try {
      const policy = join(directory, 'policy.toml')
      await writeFile(policy, '[extend]\nuseDefault = true\n')
      await run(directory, policy)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  it('does not skip a missing real scanner and removes its owned scratch directory', async () => {
    await withFixture(async (directory, configPath) => {
      await expect(
        probeGitleaksPolicy({ configPath, scratchRoot: directory, binary: join(directory, 'absent-gitleaks') })
      ).rejects.toThrow()
      expect(await readdir(directory)).toEqual(['policy.toml'])
    })
  })

  it('does not treat successful process exit without reports as a clean scan', async () => {
    await withFixture(async (directory, configPath) => {
      // A deliberately broken process double, NOT a substitute Gitleaks scan.
      const binary = join(directory, 'reportless-scanner')
      await writeFile(binary, '#!/bin/sh\nif [ "$1" = version ]; then printf "8.24.3\\n"; fi\nexit 0\n', {
        mode: 0o700
      })
      const result = await probeGitleaksPolicy({ configPath, scratchRoot: directory, binary })
      expect(result.passed).toBe(false)
      expect(result.cases).toHaveLength(6)
      expect(result.cases.every((item) => !item.passed && item.outcome === 'scanner_failure')).toBe(true)
      expect((await readdir(directory)).sort()).toEqual(['policy.toml', 'reportless-scanner'])
    })
  })

  it('runs the real policy probe after pinned provisioning with both checks mandatory', async () => {
    type Step = {
      uses?: string
      name?: string
      run?: string
      if?: string
      env?: Record<string, string>
      'continue-on-error'?: boolean
    }
    const workflow = parse(await readFile(resolve('.github/workflows/ci.yml'), 'utf8')) as {
      jobs: Record<string, { steps: Step[]; 'continue-on-error'?: boolean }>
    }
    const job = workflow.jobs['secret-scan']
    expect(job['continue-on-error']).not.toBe(true)
    const provisionIndex = job.steps.findIndex((step) => step.uses?.startsWith('gitleaks/gitleaks-action@'))
    const provision = job.steps[provisionIndex]
    expect(provision.env?.GITLEAKS_VERSION).toBe('8.24.3')
    const probeIndex = job.steps.findIndex((step) => step.name === 'Verify real Gitleaks policy behavior')
    expect(probeIndex).toBeGreaterThan(provisionIndex)
    const probe = job.steps[probeIndex]
    for (const step of [provision, probe]) {
      expect(step.if).toBeUndefined()
      expect(step['continue-on-error']).not.toBe(true)
    }
    expect(probe.run).toContain('node scripts/lib/gitleaks-policy-probe.mjs --go')
    expect(probe.run).toContain('"$GITHUB_WORKSPACE/.gitleaks.toml"')
    expect(probe.run).toContain('"$RUNNER_TEMP"')
    expect(probe.run).not.toMatch(/\|\||set\s+\+e/)
  })
})
