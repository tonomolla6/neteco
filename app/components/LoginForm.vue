<script setup lang="ts">
defineProps<{
  email: string
  password: string
  mfaChallenge?: string
  mfaCode?: string
  loading?: boolean
  error?: string
}>()
const emit = defineEmits<{
  'update:email': [value: string]
  'update:password': [value: string]
  'update:mfaCode': [value: string]
  submit: []
}>()
</script>

<template>
  <form class="mt-6 space-y-4" @submit.prevent="emit('submit')">
    <UFormField v-if="!mfaChallenge" label="Email">
      <UInput
        :model-value="email"
        type="email"
        autocomplete="email"
        class="w-full"
        icon="i-lucide-mail"
        @update:model-value="emit('update:email', $event)"
      />
    </UFormField>
    <UFormField v-if="!mfaChallenge" label="Contraseña">
      <UInput
        :model-value="password"
        type="password"
        autocomplete="current-password"
        class="w-full"
        icon="i-lucide-lock"
        @update:model-value="emit('update:password', $event)"
      />
    </UFormField>
    <UFormField v-else label="Código de autenticación" hint="6 dígitos o un código de recuperación">
      <UInput
        :model-value="mfaCode"
        autocomplete="one-time-code"
        inputmode="numeric"
        class="w-full"
        icon="i-lucide-shield-check"
        autofocus
        @update:model-value="emit('update:mfaCode', $event)"
      />
    </UFormField>
    <UAlert v-if="error" role="alert" color="error" variant="subtle" icon="i-lucide-alert-circle" :title="error" />
    <UButton type="submit" block size="lg" :loading="loading">
      {{ mfaChallenge ? 'Confirmar código' : 'Iniciar sesión' }}
    </UButton>
  </form>
</template>
