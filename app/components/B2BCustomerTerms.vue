<script setup lang="ts">
import { z } from 'zod'
const props = defineProps<{ enabled: boolean; scopeKey: string }>()
const request = useRequestFetch()
const cents = z.number().int().safe().nonnegative()
const schema = z
  .object({
    terms: z
      .object({
        companyId: z.string(),
        companyStatus: z.string(),
        paymentDays: z.number().int().nullable(),
        creditLimitCents: cents.nullable(),
        blocked: z.boolean(),
        version: z.number().int().nullable(),
        priceListId: z.string().nullable(),
        priceListName: z.string().nullable(),
        exposureCents: cents,
        availableCents: cents
      })
      .strict()
      .nullable()
  })
  .strict()
type Terms = NonNullable<z.infer<typeof schema>['terms']>
const terms = ref<Terms | null>(null),
  error = ref(false),
  loading = ref(false)
let generation = 0
watch(
  () => [props.enabled, props.scopeKey],
  async () => {
    const current = ++generation
    terms.value = null
    error.value = false
    loading.value = false
    if (!props.enabled) return
    loading.value = true
    try {
      const data = schema.parse(await request('/api/account/b2b', { method: 'GET', retry: 0, cache: 'no-store' }))
      if (current === generation && props.enabled) terms.value = data.terms
    } catch {
      if (current === generation) error.value = true
    } finally {
      if (current === generation) loading.value = false
    }
  },
  { immediate: true }
)
const euro = (value: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value / 100)
</script>
<template>
  <section v-if="enabled && (terms || error || loading)" class="rounded-xl border border-slate-200 p-5">
    <h2 class="font-semibold">Condiciones profesionales</h2>
    <p v-if="loading" role="status">Consultando condiciones…</p>
    <p v-else-if="error" role="alert">No se han podido consultar tus condiciones comerciales.</p>
    <template v-else-if="terms">
      <p>Tarifa: {{ terms.priceListName || 'Tarifa pública' }}</p>
      <p>Pago: {{ terms.paymentDays ? `transferencia a ${terms.paymentDays} días` : 'inmediato' }}</p>
      <p>Crédito disponible: {{ euro(terms.availableCents) }}</p>
      <p v-if="terms.blocked || terms.companyStatus !== 'approved'">El crédito no está disponible actualmente.</p>
    </template>
  </section>
</template>
