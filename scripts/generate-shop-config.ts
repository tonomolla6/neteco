import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { experimental_readRawConfig } from 'wrangler'
import { createEnvironmentShopConfig, createLocalShopConfig } from './lib/cloudflare-environment-config'
export { createLocalShopConfig } from './lib/cloudflare-environment-config'

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argumentsList = process.argv.slice(2)
  if (argumentsList.length !== 0 && (argumentsList.length !== 2 || argumentsList[0] !== '--environment-file')) {
    throw new Error('usage_generate_shop_config_environment_file')
  }
  const { rawConfig } = experimental_readRawConfig({ config: 'wrangler.canary.jsonc' }) as {
    rawConfig: Record<string, unknown>
  }
  const inputPath = argumentsList[1]
  let environment: unknown = null
  if (inputPath) {
    const path = resolve(inputPath)
    if ((await stat(path)).size > 65536) throw new Error('invalid_cloudflare_environment_file')
    try {
      environment = JSON.parse(await readFile(path, 'utf8')) as unknown
    } catch {
      throw new Error('invalid_cloudflare_environment_file')
    }
  }
  const config = inputPath
    ? createEnvironmentShopConfig(rawConfig, process.cwd(), environment)
    : createLocalShopConfig(rawConfig, process.cwd())
  const directory = inputPath
    ? resolve('.wrangler/environments', String((config.vars as Record<string, string>).APP_ENV))
    : resolve('.wrangler/shop')
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  console.log(
    inputPath
      ? 'Explicit environment shop configuration generated offline; no remote calls or deployment performed.'
      : 'Local shop configuration generated; no remote calls or deployment performed.'
  )
}
