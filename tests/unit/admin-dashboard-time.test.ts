import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { baseParse, NodeTypes, type TemplateChildNode } from '@vue/compiler-dom'
import { parse } from '@vue/compiler-sfc'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { describe, expect, it } from 'vitest'

// Execute the actual dashboard interpolation, rather than a duplicate formatter.
// Each child has its own timezone: no mutation of the Vitest/SSR process clock.
const template = parse(readFileSync(new URL('../../app/pages/admin/index.vue', import.meta.url), 'utf8')).descriptor
  .template!.content
const expressions: string[] = []
function findClock(nodes: TemplateChildNode[]) {
  for (const node of nodes) {
    if (
      node.type === NodeTypes.INTERPOLATION &&
      node.content.type === NodeTypes.SIMPLE_EXPRESSION &&
      node.content.content.includes('ops!.generatedAt') &&
      node.content.content.includes('toLocaleTimeString')
    )
      expressions.push(node.content.content)
    if (node.type === NodeTypes.ELEMENT) findClock(node.children)
  }
}
findClock(baseParse(template).children)

const fixtures = [
  ['2026-01-15T12:34:00Z', '13:34'],
  ['2026-07-15T12:34:00Z', '14:34'],
  ['2026-03-29T00:59:00Z', '01:59'],
  ['2026-03-29T01:00:00Z', '03:00'],
  ['2026-10-25T00:59:00Z', '02:59'],
  ['2026-10-25T01:00:00Z', '02:00'],
  ['2026-01-15T23:30:00Z', '00:30']
] as const

describe('dashboard SSR/client operational clock', () => {
  it('locates exactly one operational-clock expression in the real template', () => {
    expect(expressions).toHaveLength(1)
  })

  it.each(['UTC', 'Europe/Madrid', 'America/New_York'])(
    'uses Madrid business time regardless of SSR/client default timezone %s, including DST boundaries',
    (timezone) => {
      expect(expressions).toHaveLength(1)
      const code = transpileModule(
        `const timestamps = ${JSON.stringify(fixtures.map(([instant]) => instant))};
         const results = timestamps.map(generatedAt => {
           const ops = { generatedAt };
           return (${expressions[0]});
         });
         process.stdout.write(JSON.stringify(results));`,
        { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext } }
      ).outputText
      const result: unknown = JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '-e', code], {
          cwd: process.cwd(),
          env: { PATH: '/usr/bin:/bin', TZ: timezone },
          timeout: 3000,
          encoding: 'utf8'
        })
      )
      expect(result).toEqual(fixtures.map(([, clock]) => clock))
    }
  )
})
