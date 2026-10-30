<script setup lang="ts">
import { reactive, ref } from 'vue'
const request = useRequestFetch()
type Method = 'card' | 'bank_transfer' | 'credit'
type Profile = {
  market: string
  currency: string
  version: number
  exchangeNumerator: number
  exchangeDenominator: number
  goodsTaxBps: number
  shippingNetMinor: number
  shippingTaxBps: number
  termsVersion: string
  paymentMethods: Method[]
}
const market = ref(''),
  loading = ref(false),
  error = ref(''),
  notice = ref(''),
  ready = ref(false),
  target = ref(''),
  version = ref(0)
const form = reactive({
  currency: '',
  exchangeNumerator: 0,
  exchangeDenominator: 0,
  goodsTaxBps: 0,
  shippingNetMinor: 0,
  shippingTaxBps: 0,
  termsVersion: '',
  paymentMethods: [] as Method[]
})
let pending: { signature: string; key: string } | null = null
async function load() {
  const code = market.value.trim()
  ready.value = false
  error.value = ''
  notice.value = ''
  if (!/^[A-Z]{2}$/.test(code)) {
    error.value = 'Indique un código de mercado válido.'
    return
  }
  loading.value = true
  try {
    const p = await request<Profile>(`/api/admin/checkout-markets/${code}`)
    if (market.value.trim() !== code) return
    target.value = code
    version.value = p.version
    Object.assign(form, {
      currency: p.currency,
      exchangeNumerator: p.exchangeNumerator,
      exchangeDenominator: p.exchangeDenominator,
      goodsTaxBps: p.goodsTaxBps,
      shippingNetMinor: p.shippingNetMinor,
      shippingTaxBps: p.shippingTaxBps,
      termsVersion: p.termsVersion,
      paymentMethods: [...p.paymentMethods]
    })
    ready.value = true
  } catch {
    error.value = 'No se ha podido cargar el mercado. Si aún no existe, cree un perfil.'
  } finally {
    loading.value = false
  }
}
function create() {
  const code = market.value.trim()
  if (!/^[A-Z]{2}$/.test(code)) {
    error.value = 'Indique un código de mercado válido.'
    return
  }
  target.value = code
  version.value = 0
  Object.assign(form, {
    currency: '',
    exchangeNumerator: 0,
    exchangeDenominator: 0,
    goodsTaxBps: 0,
    shippingNetMinor: 0,
    shippingTaxBps: 0,
    termsVersion: '',
    paymentMethods: []
  })
  ready.value = true
  error.value = ''
  notice.value = ''
}
async function save() {
  if (!ready.value || loading.value || market.value.trim() !== target.value) return
  const body = { ...form, paymentMethods: [...form.paymentMethods], expectedVersion: version.value },
    signature = JSON.stringify([target.value, body])
  if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() }
  loading.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await request<{ version: number }>(`/api/admin/checkout-markets/${target.value}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': pending.key },
      body
    })
    version.value = result.version
    pending = null
    notice.value = 'Perfil guardado.'
  } catch {
    error.value = 'No se ha podido confirmar el cambio. Revise el perfil o vuelva a cargar.'
  } finally {
    loading.value = false
  }
}
</script>
<template>
  <section aria-labelledby="market-title">
    <h1 id="market-title">Perfiles de checkout por mercado</h1>
    <p>Estos perfiles aún no se aplican al checkout activo.</p>
    <form data-test="load" @submit.prevent="load">
      <label for="market-code">Mercado</label
      ><input id="market-code" v-model="market" name="market" :disabled="loading" placeholder="ES" /><button
        :disabled="loading"
      >
        Consultar</button
      ><button type="button" :disabled="loading" @click="create">Crear perfil</button>
    </form>
    <p v-if="loading" role="status">Cargando…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <form v-if="ready && target === market.trim()" data-test="save" @submit.prevent="save">
      <p>Mercado {{ target }}, versión {{ version }}</p>
      <label for="market-currency">Moneda</label
      ><input id="market-currency" v-model="form.currency" name="currency" required maxlength="3" />
      <label for="exchange-num">Tipo de cambio: numerador</label
      ><input id="exchange-num" v-model.number="form.exchangeNumerator" type="number" min="1" max="1000000" required />
      <label for="exchange-den">Tipo de cambio: denominador</label
      ><input
        id="exchange-den"
        v-model.number="form.exchangeDenominator"
        type="number"
        min="1"
        max="1000000"
        required
      />
      <label for="goods-tax">Impuesto de productos (puntos básicos)</label
      ><input id="goods-tax" v-model.number="form.goodsTaxBps" type="number" min="0" max="10000" required />
      <label for="shipping-net">Transporte neto (unidad menor)</label
      ><input id="shipping-net" v-model.number="form.shippingNetMinor" type="number" min="0" max="100000000" required />
      <label for="shipping-tax">Impuesto de transporte (puntos básicos)</label
      ><input id="shipping-tax" v-model.number="form.shippingTaxBps" type="number" min="0" max="10000" required />
      <label for="terms">Versión de términos</label><input id="terms" v-model="form.termsVersion" required />
      <fieldset>
        <legend>Medios de pago</legend>
        <label><input v-model="form.paymentMethods" type="checkbox" value="card" /> Tarjeta</label
        ><label><input v-model="form.paymentMethods" type="checkbox" value="bank_transfer" /> Transferencia</label
        ><label><input v-model="form.paymentMethods" type="checkbox" value="credit" /> Crédito</label>
      </fieldset>
      <button type="submit" :disabled="loading">Guardar perfil</button>
    </form>
  </section>
</template>
