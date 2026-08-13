import { spawn } from 'node:child_process'
import Redis from 'ioredis'
import integrationGlobalSetup from '../tests/support/integration-global-setup'
import { isolatedPostgresDatabase } from '../tests/fixtures/postgres'

function runPlaywright(databaseUrl: string, redisUrl: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn('node_modules/.bin/playwright', ['test', ...process.argv.slice(2)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        APP_ENV: 'test',
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        AUTH_TOKEN_PEPPER: process.env.AUTH_TOKEN_PEPPER ?? 'local-only-token-pepper-change-me',
        AUTH_ENCRYPTION_KEY: process.env.AUTH_ENCRYPTION_KEY ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
      },
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
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:56379/0')
  redisUrl.pathname = `/${1 + (process.pid % 15)}`
  const redis = new Redis(redisUrl.toString(), { maxRetriesPerRequest: 1 })
  try {
    await redis.flushdb()
    process.exitCode = await runPlaywright(database.connection, redisUrl.toString())
  } finally {
    await redis.flushdb()
    redis.disconnect()
    await database.dispose()
  }
} finally {
  await teardownTemplate()
}
