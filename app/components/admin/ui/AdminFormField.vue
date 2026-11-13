<script setup lang="ts">
/** Campo de formulario: etiqueta arriba, ayuda debajo y error en su sitio. */
const props = defineProps<{ label: string; help?: string; error?: string; required?: boolean; for?: string }>()
const generated = useId()
const id = computed(() => props.for ?? generated)
</script>

<template>
  <div class="adm-field">
    <label :for="id" class="adm-label">
      {{ label }}<span v-if="required" class="text-red-700" aria-hidden="true"> *</span>
    </label>
    <slot :id="id" :described-by="help || error ? `${id}-help` : undefined" />
    <p v-if="error" :id="`${id}-help`" class="adm-field__error" role="alert">{{ error }}</p>
    <p v-else-if="help" :id="`${id}-help`" class="adm-help">{{ help }}</p>
  </div>
</template>
