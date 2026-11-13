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
    error.value = 'Escribe un código de país de dos letras en mayúsculas, por ejemplo ES.'
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
    error.value = 'No se ha podido cargar el mercado. Si aún no existe, crea un perfil.'
  } finally {
    loading.value = false
  }
}
function create() {
  const code = market.value.trim()
  if (!/^[A-Z]{2}$/.test(code)) {
    error.value = 'Escribe un código de país de dos letras en mayúsculas, por ejemplo ES.'
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
    error.value = 'No se ha podido confirmar el cambio. Revisa el perfil o vuelve a consultarlo.'
  } finally {
    loading.value = false
  }
}
</script>
<template>
  <section aria-label="Compra por mercado" class="adm-stack">
    <AdminPageActions>
      <button
        v-if="ready && target === market.trim()"
        type="submit"
        form="checkout-market-form"
        class="adm-btn adm-btn--primary"
        :disabled="loading"
      >
        Guardar perfil
      </button>
    </AdminPageActions>
    <AdminCard>
      <form data-test="load" class="adm-toolbar" @submit.prevent="load">
        <label for="market-code" class="adm-label">País del mercado</label>
        <input
          id="market-code"
          v-model="market"
          name="market"
          class="adm-input w-24 uppercase"
          :disabled="loading"
          placeholder="ES"
          maxlength="2"
          aria-describedby="market-code-help"
        />
        <button class="adm-btn adm-btn--secondary" :disabled="loading">Consultar</button>
        <button type="button" class="adm-btn adm-btn--secondary" :disabled="loading" @click="create">
          Crear perfil
        </button>
        <p v-if="loading" role="status" class="adm-help">Cargando…</p>
      </form>
      <p id="market-code-help" class="adm-help mt-2">
        Código de país de dos letras en mayúsculas (ES, FR, PT…). Consulta su perfil de compra o crea uno nuevo.
      </p>
    </AdminCard>
    <UAlert v-if="error" role="alert" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />
    <form
      v-if="ready && target === market.trim()"
      id="checkout-market-form"
      data-test="save"
      class="adm-stack"
      @submit.prevent="save"
    >
      <AdminCard
        :title="`Mercado ${target}`"
        :description="
          version
            ? `Perfil guardado ${version} ${version === 1 ? 'vez' : 'veces'}.`
            : 'Perfil nuevo, todavía sin guardar.'
        "
      >
        <div class="adm-form-grid">
          <AdminFormField
            v-slot="{ id }"
            label="Moneda"
            help="Código de tres letras, por ejemplo EUR."
            required
            for="market-currency"
          >
            <input :id="id" v-model="form.currency" name="currency" required maxlength="3" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Tipo de cambio: numerador" required for="exchange-num">
            <input :id="id" v-model.number="form.exchangeNumerator" type="number" min="1" max="1000000" required />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Tipo de cambio: denominador"
            help="El tipo de cambio es el numerador dividido entre el denominador."
            required
            for="exchange-den"
          >
            <input :id="id" v-model.number="form.exchangeDenominator" type="number" min="1" max="1000000" required />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Versión de las condiciones de venta" required for="terms">
            <input :id="id" v-model="form.termsVersion" required />
          </AdminFormField>
        </div>
      </AdminCard>
      <AdminCard title="Impuestos y envío">
        <div class="adm-form-grid">
          <AdminFormField
            v-slot="{ id }"
            label="Impuesto de los productos"
            help="En centésimas de punto: 2100 equivale al 21 %."
            required
            for="goods-tax"
          >
            <input :id="id" v-model.number="form.goodsTaxBps" type="number" min="0" max="10000" required />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Coste de envío sin impuestos"
            help="En céntimos de la moneda del mercado: 595 equivale a 5,95."
            required
            for="shipping-net"
          >
            <input :id="id" v-model.number="form.shippingNetMinor" type="number" min="0" max="100000000" required />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Impuesto del envío"
            help="En centésimas de punto: 2100 equivale al 21 %."
            required
            for="shipping-tax"
          >
            <input :id="id" v-model.number="form.shippingTaxBps" type="number" min="0" max="10000" required />
          </AdminFormField>
        </div>
      </AdminCard>
      <AdminCard title="Formas de pago">
        <fieldset class="adm-field">
          <legend class="sr-only">Formas de pago</legend>
          <div class="flex flex-wrap gap-x-5 gap-y-2">
            <label class="adm-check"
              ><input v-model="form.paymentMethods" type="checkbox" value="card" /> Tarjeta</label
            >
            <label class="adm-check"
              ><input v-model="form.paymentMethods" type="checkbox" value="bank_transfer" /> Transferencia</label
            >
            <label class="adm-check"
              ><input v-model="form.paymentMethods" type="checkbox" value="credit" /> Crédito de empresa</label
            >
          </div>
        </fieldset>
      </AdminCard>
    </form>
  </section>
</template>
