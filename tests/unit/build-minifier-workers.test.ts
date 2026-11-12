import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

const probe = `
const os = require('node:os')
const threads = require('node:worker_threads')
const nativeWorker = threads.Worker
const workers = []
threads.Worker = class extends nativeWorker {
  constructor(...args) {
    if (workers.length >= 2) throw new Error('build_worker_budget_exceeded')
    super(...args)
    workers.push(this)
  }
}
const cpu = os.cpus()[0]
os.cpus = () => Array.from({ length: Number(process.argv[2]) }, () => cpu)
require(process.argv[1])
const factory = require('@rollup/plugin-terser')
const input = process.argv[3] === 'default' ? undefined : { maxWorkers: Number(process.argv[3]) }
const plugin = factory(input)
const keepAlive = setInterval(() => {}, 1000)
;(async () => {
  try {
    if (factory.default !== factory) throw new Error('terser_default_export_changed')
    const results = await Promise.all(Array.from({ length: 3 }, (_, i) =>
      plugin.renderChunk('export const value' + i + ' = 1 + 1;', {}, { format: 'es', sourcemap: false })))
    if (!results.every((code) => typeof code === 'string' && code.includes('export')))
      throw new Error('minification_did_not_finish')
    console.log(JSON.stringify({ workers: workers.length, chunks: results.length }))
  } finally {
    clearInterval(keepAlive)
    await Promise.all(workers.map((worker) => worker.terminate()))
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1 })
`

it.each([
  [0, 'default', 1],
  [8, 'default', 2],
  [8, '64', 2],
  [8, '1', 1]
] as const)('minifies real Nitro chunks with %i visible CPUs and worker setting %s', (cpus, setting, workers) => {
  const result = spawnSync(
    process.execPath,
    ['-e', probe, resolve('scripts/limit-build-workers.cjs'), String(cpus), setting],
    {
      encoding: 'utf8',
      timeout: 3000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME }
    }
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ workers, chunks: 3 })
})

it('preloads the worker budget only in the Docker build stage', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8')
  const build = dockerfile.split('AS build')[1]!.split(/^FROM/m)[0]!
  const runtime = dockerfile.split('AS runtime')[1]!
  expect(build).toContain('--require=/app/scripts/limit-build-workers.cjs')
  expect(build.indexOf('ENV NODE_OPTIONS=')).toBeLessThan(build.indexOf('RUN npm run postinstall'))
  expect(runtime).not.toContain('NODE_OPTIONS')
})
