import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

describe('two complete, fresh Oracle observations precede quality promotion', () => {
  it('keeps both observations blocking within the existing time and worker budgets', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'))
    const observations = workflow.jobs['test-observations']
    expect(observations).toBeDefined()
    expect(observations.strategy).toEqual({ 'fail-fast': false, 'max-parallel': 1, matrix: { observation: [1, 2] } })
    expect(observations['timeout-minutes']).toBe(90)
    expect(observations['runs-on']).toContain('ARM64')
    expect(observations.env.NETECO_FLAKE_OBSERVATION).toBe('${{ matrix.observation }}')
    expect(
      observations.steps.filter((step: { run?: string }) => step.run === 'npm run test:flake-monitor')
    ).toHaveLength(1)
    expect(observations.env.NETECO_UI_STATE_CAPTURE_DIR).toBe(
      "${{ matrix.observation == 1 && 'test-results/ui013-components' || '' }}"
    )
    const css = observations.steps.find(
      (step: { name?: string }) => step.name === 'Compile current Cloudflare CSS for component evidence'
    )
    expect(css).toMatchObject({ if: 'matrix.observation == 1' })
    expect(css.run).toContain('npm run build:cloudflare-ui')
    const commands = observations.steps.map((step: { run?: string }) => step.run)
    for (const prerequisite of ['db:migrate', 'db:seed']) {
      expect(commands.indexOf(`npm run ${prerequisite}`)).toBeGreaterThan(-1)
      expect(commands.indexOf(`npm run ${prerequisite}`)).toBeLessThan(commands.indexOf('npm run test:flake-monitor'))
    }
    const upload = observations.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/upload-artifact@')
    )
    expect(upload.if).toBe("always() && steps.observation-artifacts.outcome == 'success'")
    expect(observations.steps.find((step: { id?: string }) => step.id === 'observation-artifacts')).toMatchObject({
      if: 'always()',
      run: 'npm run ci:artifacts -- --publish'
    })
    expect(upload.with.name).toBe('flake-observation-${{ matrix.observation }}-${{ github.run_attempt }}')
    expect(upload.with['if-no-files-found']).toBe('error')
    const quality = workflow.jobs.quality
    expect(quality.needs).toContain('test-observations')
    const downloads = quality.steps.filter((step: { uses?: string }) =>
      step.uses?.startsWith('actions/download-artifact@')
    )
    expect(downloads.map((step: { with: { name: string } }) => step.with.name)).toEqual([
      'flake-observation-1-${{ github.run_attempt }}',
      'flake-observation-2-${{ github.run_attempt }}'
    ])
    const aggregate = quality.steps.find((step: { run?: string }) => step.run === 'npm run test:flake-monitor')
    expect(aggregate.env.NETECO_FLAKE_ARTIFACTS).toBe('${{ runner.temp }}/flake-observations')
    expect(aggregate['continue-on-error']).toBeUndefined()
  })
})
