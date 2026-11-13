import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { connectRemoteTestBrowser } from '../../scripts/lib/remote-test-browser'

interface Workflow {
  env?: Record<string, string>
  jobs: Record<
    string,
    { env?: Record<string, string>; steps: Array<{ run?: string; shell?: string; env?: Record<string, string> }> }
  >
}

describe('Oracle browser checks admit only the private remote browser transport', () => {
  it.each(['ci', 'cloudflare-compat'])(
    '%s reuses the dedicated browser toolchain instead of downloading local browsers',
    async (file) => {
      const workflow = parse(await readFile(`.github/workflows/${file}.yml`, 'utf8')) as Workflow
      const localInstalls = Object.values(workflow.jobs)
        .flatMap((job) => job.steps)
        .filter((step) => /\bplaywright\s+install\b/.test(step.run ?? ''))
      expect(localInstalls).toEqual([])
    }
  )
  it.each(['scripts/run-performance.ts', 'scripts/lib/oracle-shop-audit.ts'])(
    '%s cannot launch a browser on the shared Oracle host',
    async (file) => {
      const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const localLaunches: string[] = []
      function visit(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['launch', 'launchPersistentContext', 'launchServer'].includes(node.expression.name.text)
        ) {
          localLaunches.push(node.expression.getText(source))
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      expect(localLaunches).toEqual([])
    }
  )
  it.each([
    ['ci', 'quality', 'test:performance'],
    ['ci', 'quality', 'test:e2e'],
    ['ci', 'quality', 'test:a11y'],
    ['ci', 'quality', 'test:browser-matrix'],
    ['ci', 'quality', 'test:flake-browser'],
    ['ci', 'quality', 'test:visual'],
    ['cloudflare-compat', 'shop-runtime', 'audit:shop:ci']
  ])('%s/%s supplies a usable private browser and loopback exposure for %s', async (file, jobName, command) => {
    const workflow = parse(await readFile(`.github/workflows/${file}.yml`, 'utf8')) as Workflow
    const job = workflow.jobs[jobName]!
    const steps = job.steps.filter((step) => new RegExp(`^npm run ${command}(?:\\s|$)`).test(step.run ?? ''))
    expect(steps).toHaveLength(1)
    expect(steps[0]!.shell).toBe('/usr/local/libexec/neteco-ci/remote-browser-shell {0}')
    const environment = { ...workflow.env, ...job.env, ...steps[0]!.env }
    const browser = { close: vi.fn() }
    const connect = vi.fn().mockResolvedValue(browser)
    const remote = await connectRemoteTestBrowser({ connect }, { endpoint: environment.PW_TEST_CONNECT_WS_ENDPOINT })
    expect(connect).toHaveBeenCalledOnce()
    expect(environment.PW_TEST_CONNECT_EXPOSE_NETWORK).toBe('<loopback>')
    await remote.close()
    expect(browser.close).toHaveBeenCalledOnce()
  })
})
