import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { renderD1CategorySeed } from './lib/d1-category-seed'

const output = resolve('.wrangler/generated/d1-demo-categories.sql')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, renderD1CategorySeed(), 'utf8')
process.stdout.write(`${output}\n`)
