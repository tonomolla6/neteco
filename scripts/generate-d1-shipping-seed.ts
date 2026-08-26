import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { renderD1ShippingSeed } from './lib/d1-shipping-seed'

const output = resolve('.wrangler/generated/d1-demo-shipping.sql')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, renderD1ShippingSeed(), 'utf8')
process.stdout.write(`${output}\n`)
