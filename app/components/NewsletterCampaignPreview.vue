<script setup lang="ts">
import { newsletterPreviewSchema } from '~~/shared/newsletter-editorial'
const props = defineProps<{ value: unknown }>()
const preview = computed(() => {
  const result = newsletterPreviewSchema.safeParse(props.value)
  return result.success ? result.data : null
})
const device = ref<string>('desktop')
const devices = [
  { value: 'desktop', label: 'Ordenador' },
  { value: 'mobile', label: 'Móvil' },
  { value: 'text', label: 'Solo texto' }
]
const inertHtml = computed(() =>
  preview.value
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">${preview.value.html}`
    : ''
)
</script>
<template>
  <AdminCard
    v-if="preview"
    title="Vista previa del correo"
    description="Es una muestra con datos de ejemplo: los enlaces y la baja no hacen nada y no se envía a nadie."
    aria-label="Vista previa sintética"
  >
    <template #actions>
      <AdminFilters v-model="device" :options="devices" label="Cómo verlo" />
    </template>
    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
      <dt class="text-[var(--text-muted)]">Asunto</dt>
      <dd class="break-words font-medium text-[var(--text-strong)]">{{ preview.subject }}</dd>
      <dt class="text-[var(--text-muted)]">Contenido informativo</dt>
      <dd class="whitespace-nowrap tabular-nums">
        {{ preview.editorialPercent.toLocaleString('es-ES', { maximumFractionDigits: 1 }) }} %
      </dd>
    </dl>
    <div
      class="mt-4 overflow-x-auto rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] p-3"
    >
      <pre
        v-if="device === 'text'"
        class="whitespace-pre-wrap break-words rounded-[var(--radius-control)] bg-[var(--surface)] p-4 text-[0.8125rem]"
        >{{ preview.text }}</pre>
      <iframe
        v-else
        :srcdoc="inertHtml"
        sandbox=""
        referrerpolicy="no-referrer"
        title="Correo de muestra, sin acciones"
        :style="{ width: device === 'mobile' ? '375px' : '100%', maxWidth: '100%', height: '480px' }"
        class="mx-auto block rounded-[var(--radius-control)] border border-[var(--border)] bg-white"
      />
    </div>
  </AdminCard>
</template>
