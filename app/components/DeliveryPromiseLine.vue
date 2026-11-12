<script setup lang="ts">
import { provinceForPostalCode } from '~~/shared/delivery-estimate'

/**
 * La fecha de entrega concreta, junto al botón de compra: «Te llega el martes 17 si lo pides
 * hoy antes de las 13:00». Con el código postal recordado elige reparto propio o agencia; sin
 * él, promete la agencia y ofrece afinar con un solo campo.
 *
 * `preparationDays`: días laborables antes de salir (0 en stock, el plazo si es bajo pedido,
 * `null` si es bajo pedido sin plazo: entonces no se promete fecha).
 */
const props = withDefaults(
  defineProps<{
    preparationDays?: number | null
    compact?: boolean
  }>(),
  { preparationDays: 0, compact: false }
)

const { view, destination, remember } = useDeliveryPromise({ preparationDays: () => props.preparationDays })
const { ownDelivery } = useCommercialTerms()
const editing = ref(false)
const postalCode = ref('')
const error = ref('')
const input = useTemplateRef<HTMLInputElement>('input')

function edit() {
  postalCode.value = destination.value?.postalCode ?? ''
  error.value = ''
  editing.value = true
  void nextTick(() => input.value?.focus())
}
function save() {
  const value = postalCode.value.trim()
  const province = provinceForPostalCode(value)
  if (!province) {
    error.value = 'Escribe un código postal de 5 cifras.'
    return
  }
  // Si ya conocíamos la población de ese mismo código postal, se conserva.
  const city = destination.value?.postalCode === value ? destination.value.city : province
  if (remember({ postalCode: value, city })) editing.value = false
}
</script>

<template>
  <div data-delivery-promise :class="compact ? 'text-[13px]' : 'text-[15px]'">
    <!-- Mientras no hay reloj (SSR) se reserva el sitio para no mover la caja de compra. -->
    <div v-if="!view" class="min-h-11">
      <p v-if="preparationDays === null" class="text-[var(--text)]">
        Bajo pedido. Te confirmamos la fecha de entrega al pedirlo.
      </p>
      <p v-else class="text-[var(--text-muted)]">{{ ownDelivery.text }}</p>
    </div>
    <template v-else>
      <p class="leading-snug" aria-live="polite">
        <UIcon
          :name="view.promise.method === 'own_delivery' ? 'i-lucide-truck' : 'i-lucide-package-check'"
          class="mr-1 inline size-4 -translate-y-px align-middle text-[var(--stock-ok)]"
          aria-hidden="true"
        />
        <strong data-delivery-date class="font-semibold text-[var(--stock-ok)]">{{ view.headline }}</strong>
        <span class="text-[var(--text)]"> {{ view.condition }}.</span>
      </p>
      <p class="mt-1 text-[13px] text-[var(--text-muted)]">
        {{ view.methodLabel }}
        <template v-if="destination && !editing">
          · Entrega en {{ destination.postalCode }} {{ destination.city }}
          <button
            type="button"
            data-delivery-change
            class="ml-0.5 min-h-6 font-semibold text-[var(--link)] underline underline-offset-2"
            @click="edit"
          >
            Cambiar
          </button>
        </template>
        <template v-else-if="!editing">
          ·
          <button
            type="button"
            data-delivery-change
            class="min-h-6 font-semibold text-[var(--link)] underline underline-offset-2"
            @click="edit"
          >
            Indica tu código postal
          </button>
          para afinar la fecha
        </template>
      </p>
    </template>

    <form v-if="editing" class="mt-2 flex items-start gap-2" @submit.prevent="save">
      <label class="sr-only" for="delivery-promise-postal-code">Código postal</label>
      <input
        id="delivery-promise-postal-code"
        ref="input"
        v-model="postalCode"
        inputmode="numeric"
        autocomplete="postal-code"
        maxlength="5"
        placeholder="Código postal"
        class="tabular h-11 w-32 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[15px]"
        :aria-invalid="error ? 'true' : undefined"
        aria-describedby="delivery-promise-error"
      />
      <button
        type="submit"
        class="h-11 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-4 font-semibold text-[var(--text-strong)] hover:border-[var(--action)]"
      >
        Aplicar
      </button>
      <button type="button" class="h-11 px-2 text-[13px] text-[var(--text-muted)] underline" @click="editing = false">
        Cancelar
      </button>
    </form>
    <p v-if="error" id="delivery-promise-error" role="alert" class="mt-1 text-[13px] text-[var(--ui-error)]">
      {{ error }}
    </p>
    <p v-if="view && !compact" class="mt-1 text-[13px] text-[var(--text-muted)]">
      Fecha estimada en días laborables; te la confirmamos al pagar.
    </p>
  </div>
</template>
