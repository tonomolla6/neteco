<script setup lang="ts">
/**
 * Campo de contraseña con requisitos visibles y botón de mostrar.
 *
 * El registro exige 12 caracteres con letra y número, pero el formulario solo lo decía en
 * una pista de 12 px y ocultaba lo escrito. Escribir a ciegas una contraseña larga y que
 * el error aparezca al enviar es una de las causas más caras de abandono en un alta.
 *
 * Los requisitos se muestran solo cuando el campo tiene contenido: en blanco serían un
 * muro de exigencias antes de haber escrito nada.
 */
const props = withDefaults(
  defineProps<{
    label?: string
    autocomplete?: string
    required?: boolean
    /** Muestra la lista de requisitos y su cumplimiento en vivo. */
    showRules?: boolean
    /** Para el campo de repetición: valor con el que debe coincidir. */
    matches?: string
  }>(),
  { label: 'Contraseña', autocomplete: 'new-password', required: false, showRules: false, matches: undefined }
)

const model = defineModel<string>({ default: '' })
const visible = ref(false)
const inputId = `password-${useId()}`
// Existing/repeated passwords keep their exact value and their existing policy.
const showNewPasswordRules = computed(
  () => props.showRules && props.matches === undefined && !/(?:^|\s)current-password(?:\s|$)/.test(props.autocomplete)
)

const rules = computed(() => [
  { label: 'Al menos 12 caracteres', ok: model.value.length >= 12 },
  { label: 'Como máximo 128 caracteres', ok: model.value.length <= 128 },
  { label: 'Alguna letra', ok: /[a-záéíóúñ]/i.test(model.value) },
  { label: 'Algún número', ok: /\d/.test(model.value) }
])
const allOk = computed(() => rules.value.every((rule) => rule.ok))
const mismatch = computed(() => props.matches !== undefined && model.value.length > 0 && model.value !== props.matches)
</script>

<template>
  <UFormField
    :label="label"
    :required="required"
    :error="mismatch ? 'Las dos contraseñas no coinciden.' : undefined"
    :help="showNewPasswordRules ? 'De 12 a 128 caracteres, con alguna letra y algún número.' : undefined"
  >
    <UInput
      :id="inputId"
      v-model="model"
      :type="visible ? 'text' : 'password'"
      :autocomplete="autocomplete"
      :required="required"
      :minlength="showNewPasswordRules ? 12 : undefined"
      :maxlength="showNewPasswordRules ? 128 : undefined"
      class="w-full"
      icon="i-lucide-lock"
    >
      <template #trailing>
        <UButton
          type="button"
          color="neutral"
          variant="ghost"
          size="xs"
          :icon="visible ? 'i-lucide-eye-off' : 'i-lucide-eye'"
          :aria-label="`${visible ? 'Ocultar' : 'Mostrar'} la contraseña (${label})`"
          :aria-pressed="visible"
          :aria-controls="inputId"
          @click="visible = !visible"
        />
      </template>
    </UInput>

    <template v-if="showNewPasswordRules" #help>
      <ul v-if="model.length" class="space-y-1" aria-live="polite">
        <li
          v-for="rule in rules"
          :key="rule.label"
          class="flex items-center gap-1.5 text-xs"
          :class="rule.ok ? 'text-emerald-700' : 'text-[var(--text-muted)]'"
        >
          <UIcon :name="rule.ok ? 'i-lucide-check' : 'i-lucide-dot'" class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="sr-only">{{ rule.ok ? 'Cumplido:' : 'Pendiente:' }}</span>
          {{ rule.label }}
        </li>
      </ul>
      <p v-else class="text-xs text-[var(--text-muted)]">De 12 a 128 caracteres, con alguna letra y algún número.</p>
      <p v-if="model.length && allOk" class="sr-only">La contraseña cumple los requisitos.</p>
    </template>
  </UFormField>
</template>
