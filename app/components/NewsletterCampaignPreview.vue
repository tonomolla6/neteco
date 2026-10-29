<script setup lang="ts">
import { newsletterPreviewSchema } from '~~/shared/newsletter-editorial'
const props = defineProps<{ value: unknown }>()
const preview = computed(() => {
  const result = newsletterPreviewSchema.safeParse(props.value)
  return result.success ? result.data : null
})
const device = ref<'desktop' | 'mobile' | 'text'>('desktop')
const inertHtml = computed(() =>
  preview.value
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">${preview.value.html}`
    : ''
)
</script>
<template>
  <section v-if="preview" aria-label="Vista previa sintética" class="space-y-3 rounded-lg border p-4">
    <p class="text-sm">
      Datos sintéticos. Los enlaces, las preferencias y la baja no realizan acciones. No acredita entrega real.
    </p>
    <label
      >Dispositivo
      <select v-model="device" aria-label="Dispositivo de preview">
        <option value="desktop">Escritorio</option>
        <option value="mobile">Móvil</option>
        <option value="text">Texto plano</option>
      </select></label
    >
    <p>Asunto: {{ preview.subject }} · Bloques editoriales: {{ preview.editorialPercent.toFixed(1) }} %</p>
    <pre v-if="device === 'text'" class="whitespace-pre-wrap">{{ preview.text }}</pre>
    <iframe
      v-else
      :srcdoc="inertHtml"
      sandbox=""
      referrerpolicy="no-referrer"
      title="Email sintético sin acciones"
      :style="{ width: device === 'mobile' ? '375px' : '100%', maxWidth: '100%', height: '480px' }"
      class="border bg-white"
    />
  </section>
</template>
