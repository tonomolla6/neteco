import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

function runCleanup(builderName: string, artifactDir: string, exitCode = 0, standaloneAvailable = true) {
  const owned = mkdtempSync(join(tmpdir(), 'neteco-builder-cleanup-test-'))
  try {
    const capture = join(owned, 'capture')
    const captureCommand = 'printf "%s\\n" "$@" > "$CAPTURE"\n'
    writeFileSync(join(owned, 'docker'), '#!/bin/sh\nexit 126\n', { mode: 0o700 })
    if (standaloneAvailable)
      writeFileSync(
        join(owned, 'buildx'),
        '#!/bin/sh\n[ "$DOCKER_HOST" = "unix:///run/neteco-container/docker.sock" ] || exit 125\n' +
          captureCommand +
          'exit "$FAKE_EXIT"\n',
        { mode: 0o700 }
      )
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
    args: ['rm', 'neteco-ci-12345-2-Ab12Cd34']
  })
})

it('fails closed when the action standalone client is unavailable', () => {
  expect(runCleanup('neteco-ci-12345-2-Ab12Cd34', '/tmp/neteco-container.Ab12Cd34', 0, false)).toEqual({
    status: 127,
    args: []
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
