import { spawn } from 'node:child_process'
import integrationGlobalSetup from '../tests/support/integration-global-setup'
import { isolatedPostgresDatabase } from '../tests/fixtures/postgres'

function runPlaywright(databaseUrl: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn('node_modules/.bin/playwright', ['test', ...process.argv.slice(2)], {
      cwd: process.cwd(),
      env: { ...process.env, APP_ENV: 'test', DATABASE_URL: databaseUrl },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Playwright terminated by ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

const teardownTemplate = await integrationGlobalSetup()
try {
  const database = await isolatedPostgresDatabase('e2e-suite')
  try {
    process.exitCode = await runPlaywright(database.connection)
  } finally {
    await database.dispose()
  }
} finally {
  await teardownTemplate()
}
