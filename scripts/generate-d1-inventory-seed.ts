import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { renderD1InventorySeed } from './lib/d1-inventory-seed'

const output = resolve('.wrangler/generated/d1-demo-inventory.sql')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, renderD1InventorySeed(), 'utf8')
process.stdout.write(`${output}\n`)
