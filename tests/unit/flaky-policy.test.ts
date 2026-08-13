import { describe, expect, it } from 'vitest'
import { forbiddenTestControls, repeatedRunReport, vitestExecutions } from '../../scripts/lib/flaky-policy'

const passed = [
  { file: 'tests/unit/example.test.ts', name: 'example works', status: 'passed' },
  { file: 'tests/unit/example.test.ts', name: 'example remains deterministic', status: 'passed' }
]

describe('flaky-test policy', () => {
  it('calculates a zero rate only when every repeated execution passes consistently', () => {
    expect(repeatedRunReport([passed, passed])).toEqual({
      schemaVersion: 1,
      repetitions: 2,
      distinctTests: 2,
      executions: 4,
      flakyTests: [],
      failingTests: [],
      flakyRate: 0,
      status: 'passed'
    })
  })

  it('reports pass-after-failure, stable failures and missing executions without forgiving them', () => {
    const first = [{ ...passed[0]!, status: 'failed' }, passed[1]!]
    const second = [passed[0]!]
    const identities = passed.map((test) => `${test.file}::${test.name}`).sort()
    expect(repeatedRunReport([first, second])).toMatchObject({
      flakyTests: identities,
      failingTests: identities,
      flakyRate: 1,
      status: 'failed'
    })
    expect(
      repeatedRunReport([[{ ...passed[0]!, status: 'failed' }], [{ ...passed[0]!, status: 'failed' }]])
    ).toMatchObject({
      flakyTests: [],
      failingTests: [`${passed[0]!.file}::${passed[0]!.name}`],
      status: 'failed'
    })
  })

  it('normalizes Vitest JSON into stable test identities', () => {
    expect(
      vitestExecutions(
        {
          testResults: [
            {
              name: '/repo/tests/unit/example.test.ts',
              assertionResults: [{ fullName: 'example works', status: 'passed' }]
            }
          ]
        },
        '/repo'
      )
    ).toEqual([{ file: 'tests/unit/example.test.ts', name: 'example works', status: 'passed' }])

    expect(
      vitestExecutions(
        {
          testResults: [
            {
              name: '/repo/tests/unit/table.test.ts',
              assertionResults: [
                { fullName: 'table accepts input', status: 'passed' },
                { fullName: 'table accepts input', status: 'passed' }
              ]
            }
          ]
        },
        '/repo'
      ).map((test) => test.name)
    ).toEqual(['table accepts input [case 1]', 'table accepts input [case 2]'])
  })

  it('detects silent quarantine and focused or expected-failure controls', () => {
    const source = ['test', 'it', 'describe', 'test', 'test']
      .map((name, index) => `${name}.${['skip', 'todo', 'only', 'fails', 'fixme'][index]}(`)
      .join('\n')
    expect(forbiddenTestControls(source)).toEqual([
      'skipped test',
      'todo test',
      'focused test',
      'expected failing test',
      'Playwright fixme'
    ])
  })
})
