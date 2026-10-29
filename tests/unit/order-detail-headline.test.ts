import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { computed, ref, type ComputedRef } from 'vue'
import { describe, expect, it } from 'vitest'

// Evaluate only the existing real view computed, not the page's payment/session
// setup or a copied state-to-label implementation. This Node regression does
// not claim compiled-browser or full-component acceptance.
const source = await readFile(new URL('../../app/pages/pedido/[id].vue', import.meta.url), 'utf8')
const script = /<script setup lang="ts">([\s\S]*?)<\/script>/.exec(source)?.[1]
if (!script) throw new Error('missing_order_detail_script')
const ast = ts.createSourceFile('order-detail.ts', script, ts.ScriptTarget.ESNext, true)
let headlineDeclaration: ts.VariableDeclaration | undefined
function inspect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'headline') headlineDeclaration = node
  ts.forEachChild(node, inspect)
}
inspect(ast)
if (!headlineDeclaration) throw new Error('missing_order_detail_headline')
const compiled = ts.transpileModule(`const ${headlineDeclaration.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText
type View = {
  source?: 'cloudflare'
  accessMode?: 'view_only'
  status: string
  paymentStatus: string
  fulfillmentStatus: string
  shippingMethod: string
}
function render(patch: Partial<View> = {}, justPlaced = false, canRetry = false) {
  const order = ref<View>({
    source: 'cloudflare',
    status: 'pagado',
    paymentStatus: 'captured',
    fulfillmentStatus: 'untracked',
    shippingMethod: 'envio',
    ...patch
  })
  const headline = new Function(
    'computed',
    'isCloudflare',
    'order',
    'isPickup',
    'wasJustPlaced',
    'canRetryCloudflarePayment',
    'isViewOnly',
    compiled + '\nreturn headline'
  )(
    computed,
    computed(() => order.value.source === 'cloudflare'),
    order,
    computed(() => order.value.shippingMethod === 'recogida'),
    ref(justPlaced),
    ref(canRetry),
    computed(() => order.value.source === 'cloudflare' && order.value.accessMode === 'view_only')
  ) as ComputedRef<{ title: string; lead: string }>
  return { order, headline }
}

describe('real customer order headline fulfillment projection', () => {
  it.each([
    ['delivered', 'envio', 'Pedido entregado'],
    ['delivered', 'recogida', 'Pedido recogido'],
    ['ready_for_pickup', 'recogida', 'Listo para recoger'],
    ['in_transit', 'envio', 'Tu pedido va de camino'],
    ['picking', 'envio', 'Lo estamos preparando'],
    ['packed', 'envio', 'Lo estamos preparando']
  ])(
    'shows confirmed Cloudflare %s / %s instead of denying available preparation',
    (fulfillmentStatus, shippingMethod, title) => {
      const { headline } = render({ fulfillmentStatus, shippingMethod })
      expect(headline.value.title).toBe(title)
      expect(headline.value.lead).not.toContain('aún no está disponible')
      expect(headline.value.lead).not.toMatch(/email|mañana|minutos|horario|llegará/i)
    }
  )
  it('reacts to later confirmed fulfillment without another payment command', () => {
    const { headline, order } = render({ fulfillmentStatus: 'picking' })
    expect(headline.value.title).toBe('Lo estamos preparando')
    order.value.fulfillmentStatus = 'delivered'
    expect(headline.value.title).toBe('Pedido entregado')
  })
  it.each([
    [{ status: 'cancelado', fulfillmentStatus: 'delivered' }, 'Pedido cancelado'],
    [{ status: 'incidencia_stock', fulfillmentStatus: 'delivered' }, 'Incidencia con tu pedido'],
    [{ paymentStatus: 'authorized', fulfillmentStatus: 'delivered' }, 'Pago autorizado'],
    [{ paymentStatus: 'failed', fulfillmentStatus: 'delivered' }, 'Pago no confirmado'],
    [{ paymentStatus: 'cancelled', fulfillmentStatus: 'delivered' }, 'Pago no confirmado'],
    [{ status: 'procesando_pago', paymentStatus: 'processing', fulfillmentStatus: 'delivered' }, 'Comprobando el pago'],
    [{ paymentStatus: 'unknown', fulfillmentStatus: 'delivered' }, 'Pedido pendiente de pago'],
    [{ fulfillmentStatus: 'untracked' }, 'Pago confirmado'],
    [{ fulfillmentStatus: 'exception' }, 'Pago confirmado'],
    [{ fulfillmentStatus: 'unsupported' }, 'Pago confirmado']
  ] satisfies Array<[Partial<View>, string]>)(
    'preserves Cloudflare cancellation/incident/payment authority: %j',
    (patch, title) => {
      expect(render(patch).headline.value.title).toBe(title)
    }
  )
  it.each([
    [{ fulfillmentStatus: 'delivered' }, 'Pedido entregado'],
    [{ fulfillmentStatus: 'delivered', shippingMethod: 'recogida' }, 'Pedido recogido'],
    [{ fulfillmentStatus: 'ready_for_pickup' }, 'Listo para recoger'],
    [{ fulfillmentStatus: 'in_transit' }, 'Tu pedido va de camino'],
    [{ fulfillmentStatus: 'picking' }, 'Lo estamos preparando'],
    [{ fulfillmentStatus: 'packed' }, 'Lo estamos preparando'],
    [{ status: 'cancelado', fulfillmentStatus: 'delivered' }, 'Pedido cancelado'],
    [{ paymentStatus: 'failed', fulfillmentStatus: 'delivered' }, 'El pago no se completó'],
    [{ status: 'pendiente_transferencia', fulfillmentStatus: 'delivered' }, 'Pedido registrado, falta el ingreso'],
    [{ paymentStatus: 'awaiting_payment' }, 'Pedido pendiente de pago'],
    [{}, 'Pedido confirmado']
  ] satisfies Array<[Partial<View>, string]>)('keeps the existing Node headline unchanged: %j', (patch, title) => {
    expect(render({ ...patch, source: undefined }).headline.value.title).toBe(title)
  })
  it('keeps Node just-placed acknowledgement and Cloudflare failed-payment reservation wording', () => {
    expect(render({ source: undefined }, true).headline.value.title).toBe('¡Gracias por tu pedido!')
    expect(render({ paymentStatus: 'failed' }, false, true).headline.value.lead).toBe(
      'Puedes reintentarlo mientras la reserva siga vigente.'
    )
    expect(render({ paymentStatus: 'failed' }).headline.value.lead).toBe(
      'La reserva ya no está vigente; contacta con NETECO antes de volver a pagar.'
    )
  })
})
