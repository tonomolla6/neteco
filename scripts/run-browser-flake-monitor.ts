import { spawn } from 'node:child_process'

function run(arguments_: string[]) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', arguments_, { stdio: 'inherit', env: process.env })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${arguments_[0]} terminated by ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

const playwrightStatus = await run([
  'scripts/run-e2e.ts',
  '--config=playwright.flake.config.ts',
  ...process.argv.slice(2)
])
const reportStatus = await run(['scripts/audit-playwright-flake-report.ts'])
if (playwrightStatus !== 0 || reportStatus !== 0) process.exitCode = 1
