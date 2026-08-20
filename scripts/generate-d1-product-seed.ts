import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { renderD1ProductSeed } from './lib/d1-product-seed'

const output = resolve('.wrangler/generated/d1-demo-products.sql')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, renderD1ProductSeed(), 'utf8')
process.stdout.write(`${output}\n`)
