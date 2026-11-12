import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

function runCleanup(builderName: string, artifactDir: string, exitCode = 0) {
  const owned = mkdtempSync(join(tmpdir(), 'neteco-builder-cleanup-test-'))
  try {
    const capture = join(owned, 'capture')
    writeFileSync(join(owned, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\nexit "$FAKE_EXIT"\n', {
      mode: 0o700
    })
    const result = spawnSync('/bin/bash', [resolve('scripts/cleanup-ci-builder.sh')], {
      env: {
        PATH: owned + ':/usr/bin:/bin',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '2',
        BUILDER_NAME: builderName,
        ARTIFACT_DIR: artifactDir,
        CAPTURE: capture,
        FAKE_EXIT: String(exitCode)
      },
      encoding: 'utf8'
    })
    let args: string[] = []
    try {
      args = readFileSync(capture, 'utf8').trim().split('\n')
    } catch {
      // The command must not be invoked for an invalid builder.
    }
    return { status: result.status, args }
  } finally {
    rmSync(owned, { recursive: true, force: true })
  }
}

it('removes only the builder associated with this run and its private artifact directory', () => {
  expect(runCleanup('neteco-ci-12345-2-Ab12Cd34', '/tmp/neteco-container.Ab12Cd34')).toEqual({
    status: 0,
    args: ['buildx', 'rm', 'neteco-ci-12345-2-Ab12Cd34']
  })
})

it.each([
  ['neteco-ci-12345-2-Other123', '/tmp/neteco-container.Ab12Cd34'],
  ['neteco-ci-99999-2-Ab12Cd34', '/tmp/neteco-container.Ab12Cd34'],
  ['neteco-ci-12345-2-Ab12Cd34', '/tmp/neteco-container.Ab12Cd34/extra'],
  ['--all', '/tmp/neteco-container.Ab12Cd34']
])('rejects a builder that does not belong to this job: %s', (builder, artifactDir) => {
  const result = runCleanup(builder, artifactDir)
  expect(result.status).not.toBe(0)
  expect(result.args).toEqual([])
})

it('propagates a cleanup failure rather than reporting success', () => {
  expect(runCleanup('neteco-ci-12345-2-Ab12Cd34', '/tmp/neteco-container.Ab12Cd34', 23).status).toBe(23)
})
