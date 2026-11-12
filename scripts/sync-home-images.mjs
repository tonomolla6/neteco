#!/usr/bin/env node
/**
 * Copia las fotografías de portada generadas por el encargo de imágenes a `public/img/home/`
 * y vuelca su manifiesto a `app/assets/home-images.json`, que lee `app/utils/homeImages.ts`.
 *
 * Uso: node scripts/sync-home-images.mjs [directorio-de-origen]
 * Origen por defecto: /root/workspace/scripts/neteco-images/out (manifest.json con
 * filas {fichero, uso, alt, ancho, alto}). Solo se copian WebP declarados en el manifiesto.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.resolve(process.argv[2] ?? '/root/workspace/scripts/neteco-images/out')
const target = path.join(root, 'public/img/home')
const output = path.join(root, 'app/assets/home-images.json')

const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
const entries = Array.isArray(manifest) ? manifest : (manifest.images ?? manifest.imagenes ?? [])
await mkdir(target, { recursive: true })

const rows = []
for (const entry of entries) {
  const file = path.basename(String(entry.fichero ?? entry.file ?? ''))
  if (!/^[a-z0-9-]+\.webp$/.test(file)) {
    console.warn(`omitido: ${file || '(sin nombre)'}`)
    continue
  }
  const from = path.join(source, file)
  await stat(from)
  await copyFile(from, path.join(target, file))
  rows.push({
    file,
    alt: String(entry.alt ?? '').trim(),
    width: Number(entry.ancho ?? entry.width) || 0,
    height: Number(entry.alto ?? entry.height) || 0
  })
}
rows.sort((left, right) => left.file.localeCompare(right.file))
await writeFile(output, `${JSON.stringify(rows, null, 2)}\n`)
console.log(`${rows.length} imágenes copiadas a ${path.relative(root, target)}`)
