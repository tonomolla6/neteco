<script setup lang="ts">
import { provinceForPostalCode } from '~~/shared/delivery-estimate'

/**
 * La fecha de entrega, escrita como en Amazon: «Entrega el miércoles, 18 de noviembre», en
 * una línea propia, y debajo cuánto queda para pedirlo y a qué código postal va. Con el código
 * postal recordado elige reparto propio o agencia; sin él, promete la agencia y ofrece afinar.
 *
 * `preparationDays`: días laborables antes de salir (0 en almacén; el plazo de reposición si
 * no lo está; `null` si no hay plazo conocido: entonces no se promete fecha).
 */
const props = withDefaults(
  defineProps<{
    preparationDays?: number | null
    compact?: boolean
    /** El envío sale gratis (umbral alcanzado): «Entrega GRATIS el…». */
    free?: boolean
    /** Fecha del primer envío de varios posibles (carrito): «Entrega a partir del…». */
    earliest?: boolean
  }>(),
  { preparationDays: 0, compact: false, free: false, earliest: false }
)

const { view, ready, destination, remember } = useDeliveryPromise({ preparationDays: () => props.preparationDays })
const editing = ref(false)
const postalCode = ref('')
const error = ref('')
const input = useTemplateRef<HTMLInputElement>('input')
const uid = useId()
const postalInputId = `${uid}-delivery-postal-code`
const postalErrorId = `${uid}-delivery-error`

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
  <div data-delivery-promise class="text-[15px] leading-snug">
    <!-- Mientras no hay reloj (SSR) se reserva el sitio para no mover la caja de compra. -->
    <div v-if="!view" :class="ready ? '' : 'min-h-[4.25rem]'">
      <p v-if="ready" class="text-[var(--text)]">Te confirmamos la fecha de entrega al tramitar el pedido.</p>
    </div>
    <template v-else>
      <p class="text-[var(--text)]" aria-live="polite">
        Entrega <strong v-if="free" class="font-semibold text-[var(--stock-ok)]">GRATIS</strong>
        {{ earliest ? 'a partir del' : 'el' }}
        <strong data-delivery-date class="font-semibold text-[var(--text-strong)]">{{ view.dateLabel }}</strong>
      </p>
      <p
        v-if="view.countdown && view.promise.cutoff && view.promise.cutoff.minutesLeft <= 360"
        class="mt-1 text-[13px] text-[var(--text)]"
      >
        Si lo pides en
        <strong class="font-semibold text-[var(--stock-ok)]">{{ view.countdown }}</strong>
      </p>
      <p v-else-if="view.cutoffTime" class="mt-1 text-[13px] text-[var(--text)]">
        Si lo pides hoy antes de las
        <strong class="font-semibold text-[var(--stock-ok)]">{{ view.cutoffTime }}</strong>
      </p>
      <p v-if="!editing" class="mt-1.5 flex items-start gap-1.5 text-[13px] text-[var(--text-muted)]">
        <UIcon name="i-lucide-map-pin" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span v-if="destination">
          Enviar a {{ destination.postalCode }} {{ destination.city }} ·
          <button
            type="button"
            data-delivery-change
            class="font-semibold text-[var(--link)] underline underline-offset-2"
            @click="edit"
          >
            Cambiar
          </button>
        </span>
        <button
          v-else
          type="button"
          data-delivery-change
          class="text-left font-semibold text-[var(--link)] underline underline-offset-2"
          @click="edit"
        >
          Indica tu código postal
        </button>
      </p>
    </template>

    <form v-if="editing" class="mt-2 flex flex-wrap items-center gap-2" @submit.prevent="save">
      <label class="sr-only" :for="postalInputId">Código postal</label>
      <input
        :id="postalInputId"
        ref="input"
        v-model="postalCode"
        inputmode="numeric"
        autocomplete="postal-code"
        maxlength="5"
        placeholder="Código postal"
        class="tabular h-10 w-32 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[15px]"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="error ? postalErrorId : undefined"
      />
      <button
        type="submit"
        class="h-10 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 text-[15px] font-semibold text-[var(--text-strong)] hover:border-[var(--action)]"
      >
        Aplicar
      </button>
      <button type="button" class="h-10 px-1 text-[13px] text-[var(--text-muted)] underline" @click="editing = false">
        Cancelar
      </button>
    </form>
    <p v-if="error" :id="postalErrorId" role="alert" class="mt-1 text-[13px] text-[var(--ui-error)]">
      {{ error }}
    </p>
  </div>
</template>
