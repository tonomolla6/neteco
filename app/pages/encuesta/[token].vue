<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type {
  DeliverySurveyDetails,
  SubmitSurveyResult,
  ContactReason
} from '../../../workers/fulfillment/delivery-survey'
import { CONTACT_REASONS, CONTACT_REASON_LABELS } from '../../../workers/fulfillment/delivery-survey'

const route = useRoute()
const requestFetch = useRequestFetch()
const token = computed(() => String(route.params.token ?? ''))

useSeoMeta({
  title: 'Encuesta sobre tu entrega',
  robots: 'noindex, nofollow'
})

const loading = ref(true)
const surveyError = ref<string | null>(null)
const errorCode = ref<string | null>(null)
const details = ref<DeliverySurveyDetails | null>(null)

// Form state
const score = ref<number | null>(null)
const arrivedGood = ref<boolean | null>(null)
const contactReason = ref<ContactReason | ''>('')
const comment = ref('')
const optOutFuture = ref(false)
const submitting = ref(false)
const submitSuccess = ref(false)
const submitResult = ref<SubmitSurveyResult | null>(null)
const optOutConfirmed = ref(false)

const scoreLabels: Record<number, string> = {
  1: 'Muy insatisfecho',
  2: 'Insatisfecho',
  3: 'Aceptable',
  4: 'Satisfecho',
  5: 'Muy satisfecho'
}

const canSubmit = computed(() => {
  return score.value !== null && arrivedGood.value !== null && !submitting.value
})

async function loadSurvey() {
  if (!token.value) {
    surveyError.value = 'El enlace de la encuesta no es válido.'
    errorCode.value = 'invalid_token'
    loading.value = false
    return
  }

  loading.value = true
  surveyError.value = null

  try {
    const data = await requestFetch<DeliverySurveyDetails>(
      `/api/fulfillment/delivery-survey?token=${encodeURIComponent(token.value)}`
    )
    details.value = data
  } catch (err: unknown) {
    const errCode = (err as { data?: { error?: { code?: string } } })?.data?.error?.code
    errorCode.value = errCode ?? 'error'

    if (errCode === 'token_used') {
      surveyError.value = 'Esta encuesta ya ha sido completada. Muchas gracias por tu tiempo.'
    } else if (errCode === 'token_expired') {
      surveyError.value = 'Este enlace de encuesta ha caducado. El plazo de evaluación voluntaria ha finalizado.'
    } else {
      surveyError.value = 'No hemos encontrado la encuesta correspondiente a este enlace.'
    }
  } finally {
    loading.value = false
  }
}

async function handleSubmit() {
  if (!canSubmit.value || !score.value || arrivedGood.value === null) return
  submitting.value = true

  try {
    const res = await requestFetch<SubmitSurveyResult>('/api/fulfillment/delivery-survey/submit', {
      method: 'POST',
      body: {
        token: token.value,
        score: score.value,
        arrivedGood: arrivedGood.value,
        contactReason: contactReason.value ? contactReason.value : undefined,
        comment: comment.value.trim() ? comment.value.trim() : undefined
      }
    })

    submitResult.value = res
    submitSuccess.value = true

    if (optOutFuture.value) {
      try {
        await requestFetch('/api/fulfillment/delivery-survey/opt-out', {
          method: 'POST',
          body: { token: token.value }
        })
        optOutConfirmed.value = true
      } catch {
        // Non-blocking opt-out failure
      }
    }
  } catch (err: unknown) {
    const code = (err as { data?: { error?: { code?: string } } })?.data?.error?.code
    if (code === 'token_used') {
      surveyError.value = 'Esta encuesta ya había sido enviada.'
    } else if (code === 'token_expired') {
      surveyError.value = 'El enlace ha caducado antes de completar el envío.'
    } else {
      surveyError.value = 'Ha ocurrido un error al enviar la valoración. Inténtalo de nuevo más tarde.'
    }
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  void loadSurvey()
})
</script>

<template>
  <main class="min-h-screen bg-[var(--surface-sunken)] py-12 px-4 sm:px-6 lg:px-8">
    <div class="mx-auto max-w-xl">
      <!-- Brand Card Header -->
      <div class="text-center mb-8">
        <NuxtLink to="/" class="inline-block">
          <span class="text-2xl font-black tracking-tight text-neteco-700">NETECO</span>
        </NuxtLink>
        <p class="mt-2 text-sm text-[var(--text-muted)]">Encuesta postentrega</p>
      </div>

      <!-- Loading State -->
      <div
        v-if="loading"
        class="flex flex-col items-center justify-center rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-12 text-center shadow-sm"
      >
        <UIcon name="i-lucide-loader-2" class="size-8 animate-spin text-neteco-600 mb-4" />
        <p class="text-sm text-[var(--text-muted)]">Cargando la encuesta de tu pedido…</p>
      </div>

      <!-- Error State -->
      <div
        v-else-if="surveyError && !submitSuccess"
        role="alert"
        class="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-8 shadow-sm"
      >
        <div class="flex items-start gap-4">
          <UIcon
            :name="errorCode === 'token_used' ? 'i-lucide-check-circle-2' : 'i-lucide-info'"
            class="size-6 shrink-0"
            :class="errorCode === 'token_used' ? 'text-emerald-600' : 'text-amber-600'"
          />
          <div>
            <h1 class="text-lg font-semibold text-[var(--text-strong)]">
              {{ errorCode === 'token_used' ? 'Encuesta ya respondida' : 'Aviso sobre el enlace' }}
            </h1>
            <p class="mt-2 text-sm text-[var(--text-muted)] leading-relaxed">
              {{ surveyError }}
            </p>
            <div class="mt-6 border-t border-[var(--border-subtle)] pt-4">
              <p class="text-xs text-[var(--text-muted)]">
                Recuerda que esta valoración es totalmente voluntaria y no condiciona en ningún momento tus garantías,
                reembolsos o solicitudes de devolución.
              </p>
              <div class="mt-4">
                <NuxtLink
                  to="/"
                  class="inline-flex items-center text-sm font-medium text-neteco-600 hover:text-neteco-500"
                >
                  Volver a la tienda
                  <UIcon name="i-lucide-arrow-right" class="ml-1 size-4" />
                </NuxtLink>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Success State -->
      <div
        v-else-if="submitSuccess"
        role="status"
        class="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-8 shadow-sm"
      >
        <div class="text-center">
          <div class="mx-auto flex size-12 items-center justify-center rounded-full bg-emerald-100">
            <UIcon name="i-lucide-check" class="size-6 text-emerald-600" />
          </div>
          <h1 class="mt-4 text-xl font-bold text-[var(--text-strong)]">¡Muchas gracias por tu valoración!</h1>
          <p class="mt-2 text-sm text-[var(--text-muted)]">
            Tus comentarios nos ayudan a mejorar la preparación y entrega de nuestros pedidos de limpieza y químicos.
          </p>

          <!-- Problem / Ticket notification -->
          <div
            v-if="submitResult?.hasProblem && submitResult?.supportTicket"
            class="mt-6 rounded-xl border border-blue-200 bg-blue-50 p-4 text-left text-sm text-blue-900"
          >
            <div class="flex items-start gap-3">
              <UIcon name="i-lucide-life-buoy" class="size-5 shrink-0 text-blue-600 mt-0.5" />
              <div>
                <p class="font-semibold">Incidencia registrada automáticamente</p>
                <p class="mt-1 text-xs text-blue-800 leading-relaxed">
                  Hemos generado la referencia de seguimiento
                  <strong class="font-mono text-blue-950">{{ submitResult.supportTicket.publicRef }}</strong
                  >. Nuestro equipo de atención revisará tu caso de inmediato sin que tengas que realizar ninguna
                  gestión adicional.
                </p>
              </div>
            </div>
          </div>

          <!-- Opt out confirmation -->
          <p v-if="optOutConfirmed" class="mt-4 text-xs text-[var(--text-muted)]">
            Hemos registrado tu preferencia: no volverás a recibir encuestas postentrega en esta dirección.
          </p>

          <div class="mt-8">
            <NuxtLink
              to="/"
              class="inline-flex items-center rounded-xl bg-neteco-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-neteco-500"
            >
              Volver a la tienda
            </NuxtLink>
          </div>
        </div>
      </div>

      <!-- Survey Form -->
      <div
        v-else-if="details"
        class="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-6 sm:p-8 shadow-sm"
      >
        <!-- Non-blocking Banner -->
        <div
          class="rounded-lg bg-emerald-50 border border-emerald-200 p-3 mb-6 text-xs text-emerald-800 flex items-center gap-2"
        >
          <UIcon name="i-lucide-shield-check" class="size-4 shrink-0 text-emerald-600" />
          <span>Esta encuesta es voluntaria y nunca condiciona tu derecho a reclamación, garantía o devolución.</span>
        </div>

        <header class="border-b border-[var(--border-subtle)] pb-4 mb-6">
          <h1 class="text-xl font-bold text-[var(--text-strong)]">¿Qué tal ha ido la entrega?</h1>
          <p class="mt-1 text-sm text-[var(--text-muted)]">
            Pedido <span class="font-mono font-medium text-[var(--text-strong)]">{{ details.orderNumber }}</span>
            <span v-if="details.recipientName"> · {{ details.recipientName }}</span>
          </p>
        </header>

        <form class="space-y-6" @submit.prevent="handleSubmit">
          <!-- 1. Star / Score Rating -->
          <fieldset class="space-y-2">
            <legend class="text-sm font-semibold text-[var(--text-strong)]">
              1. Valoración general de la entrega <span class="text-red-500">*</span>
            </legend>
            <p class="text-xs text-[var(--text-muted)]">Puntúa del 1 (muy insatisfecho) al 5 (muy satisfecho)</p>

            <div class="mt-3 grid grid-cols-5 gap-2">
              <button
                v-for="val in [1, 2, 3, 4, 5]"
                :key="val"
                type="button"
                :data-score="val"
                class="flex flex-col items-center justify-center rounded-xl border py-3 px-2 text-sm font-bold transition-all focus:outline-none"
                :class="
                  score === val
                    ? 'border-neteco-600 bg-neteco-50 text-neteco-700 ring-2 ring-neteco-600'
                    : 'border-[var(--border-subtle)] bg-[var(--surface-base)] text-[var(--text-strong)] hover:bg-[var(--surface-hover)]'
                "
                :aria-label="`${val} estrellas: ${scoreLabels[val]}`"
                :aria-pressed="score === val"
                @click="score = val"
              >
                <span class="text-lg">{{ val }}</span>
                <span class="text-xs text-amber-500">★</span>
              </button>
            </div>
            <p v-if="score" class="text-xs text-center font-medium text-neteco-700 mt-1">
              {{ scoreLabels[score] }}
            </p>
          </fieldset>

          <!-- 2. Arrived Good Question -->
          <fieldset class="space-y-2">
            <legend class="text-sm font-semibold text-[var(--text-strong)]">
              2. ¿Llegó todo en buen estado? <span class="text-red-500">*</span>
            </legend>

            <div class="mt-3 grid grid-cols-2 gap-3">
              <button
                type="button"
                data-arrived-good="true"
                class="flex items-center justify-center gap-2 rounded-xl border py-3 px-4 text-sm font-medium transition-all focus:outline-none"
                :class="
                  arrivedGood === true
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-800 ring-2 ring-emerald-600'
                    : 'border-[var(--border-subtle)] bg-[var(--surface-base)] text-[var(--text-strong)] hover:bg-[var(--surface-hover)]'
                "
                :aria-pressed="arrivedGood === true"
                @click="arrivedGood = true"
              >
                <UIcon name="i-lucide-check-circle" class="size-4 text-emerald-600" />
                Sí, todo correcto
              </button>

              <button
                type="button"
                data-arrived-good="false"
                class="flex items-center justify-center gap-2 rounded-xl border py-3 px-4 text-sm font-medium transition-all focus:outline-none"
                :class="
                  arrivedGood === false
                    ? 'border-red-600 bg-red-50 text-red-800 ring-2 ring-red-600'
                    : 'border-[var(--border-subtle)] bg-[var(--surface-base)] text-[var(--text-strong)] hover:bg-[var(--surface-hover)]'
                "
                :aria-pressed="arrivedGood === false"
                @click="arrivedGood = false"
              >
                <UIcon name="i-lucide-x-circle" class="size-4 text-red-600" />
                No, hubo problemas
              </button>
            </div>
          </fieldset>

          <!-- 3. Contact Reason (Optional) -->
          <div class="space-y-2">
            <label for="contact-reason-select" class="block text-sm font-semibold text-[var(--text-strong)]">
              3. Motivo de contacto (opcional)
            </label>
            <p class="text-xs text-[var(--text-muted)]">
              Si quieres especificar un aspecto concreto de la entrega o el producto
            </p>

            <select
              id="contact-reason-select"
              v-model="contactReason"
              class="mt-1 block w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-3 text-sm text-[var(--text-strong)] focus:border-neteco-600 focus:outline-none"
            >
              <option value="">Seleccionar motivo (opcional)</option>
              <option v-for="r in CONTACT_REASONS" :key="r" :value="r">
                {{ CONTACT_REASON_LABELS[r] }}
              </option>
            </select>
          </div>

          <!-- 4. Comments (Optional) -->
          <div class="space-y-2">
            <label for="survey-comment" class="block text-sm font-semibold text-[var(--text-strong)]">
              4. Comentarios adicionales (opcional)
            </label>
            <textarea
              id="survey-comment"
              v-model="comment"
              rows="3"
              maxlength="1000"
              class="mt-1 block w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-base)] p-3 text-sm text-[var(--text-strong)] focus:border-neteco-600 focus:outline-none"
              placeholder="Cuéntanos cualquier detalle relevante sobre el repartidor, embalaje o producto…"
            />
            <p class="text-xs text-right text-[var(--text-muted)]">{{ comment.length }} / 1000 caracteres</p>
          </div>

          <!-- 5. Opt Out Checkbox -->
          <div class="flex items-start gap-2 pt-2">
            <input
              id="opt-out-checkbox"
              v-model="optOutFuture"
              type="checkbox"
              class="mt-1 size-4 rounded border-[var(--border-subtle)] text-neteco-600 focus:ring-neteco-500"
            />
            <label for="opt-out-checkbox" class="text-xs text-[var(--text-muted)]">
              No quiero recibir más invitaciones a encuestas postentrega en futuras compras.
            </label>
          </div>

          <!-- Submit Button -->
          <div class="pt-4">
            <button
              type="submit"
              data-action="submit-survey"
              :disabled="!canSubmit"
              class="w-full flex items-center justify-center rounded-xl bg-neteco-600 py-3 px-4 text-sm font-semibold text-white shadow-sm hover:bg-neteco-500 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none"
            >
              <UIcon v-if="submitting" name="i-lucide-loader-2" class="size-4 animate-spin mr-2" />
              Enviar valoración
            </button>
          </div>
        </form>
      </div>
    </div>
  </main>
</template>
