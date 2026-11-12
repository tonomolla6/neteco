import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * G5: lo que ve un cliente no habla de cómo está montada la tienda. Sin «Cloudflare»,
 * «D1», «adaptador», «en este entorno» ni medidas como «KiB» en el texto visible de las
 * pantallas de cliente; los comentarios y el código no cuentan.
 */
const CUSTOMER_SCREENS = [
  'app/components/AccountPromoFraudAppeals.vue',
  'app/components/CustomerReturnSection.vue',
  'app/components/ResourceHubPanel.vue',
  'app/components/SalesQuotesPanel.vue',
  'app/components/QuickOrderPanel.vue',
  'app/pages/carrito-compartido.vue',
  'app/pages/cuenta/newsletter.vue',
  'app/pages/cuenta/soporte.vue',
  'app/pages/devoluciones.vue'
]
const JARGON = /Cloudflare|en este entorno|\bD1\b|adaptador|\bWorker\b|\bKiB\b|idempot/i

function visibleText(file: string) {
  const source = readFileSync(file, 'utf8')
  const template = /<template>([\s\S]*)<\/template>/.exec(source)?.[1] ?? ''
  return [...template.replace(/<!--[\s\S]*?-->/g, '').matchAll(/>([^<]+)</g)]
    .map((match) => match[1]!.replace(/\{\{[\s\S]*?\}\}/g, ' ').trim())
    .filter(Boolean)
}

describe('customer screens speak plainly', () => {
  it.each(CUSTOMER_SCREENS)('%s shows no infrastructure jargon', (file) => {
    expect(visibleText(file).filter((text) => JARGON.test(text))).toEqual([])
  })
})
