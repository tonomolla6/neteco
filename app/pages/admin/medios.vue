<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Medios · Admin' })

interface MediaAsset {
  id: string
  originalName: string
  mimeType: string
  bytes: number
  width: number | null
  height: number | null
  ownerName: string | null
  license: string | null
  authorizedAt: string | null
  rightsStatus: string
  quarantineStatus: string
  altText: string | null
  sourceUrl: string | null
  createdAt: string
}

const { data, refresh } = await useFetch<{ items: MediaAsset[] }>('/api/admin/media')
const form = reactive({ ownerName: '', license: '', authorizedAt: '', altText: '' })
const file = ref<File | null>(null)
const uploading = ref(false)
const toast = useToast()

function choose(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

async function upload() {
  if (!file.value) return
  const body = new FormData()
  body.append('file', file.value)
  body.append('ownerName', form.ownerName)
  body.append('license', form.license)
  body.append('authorizedAt', form.authorizedAt)
  body.append('altText', form.altText)
  uploading.value = true
  try {
    const result = await $fetch<{ quarantineStatus: string }>('/api/admin/media', { method: 'POST', body })
    toast.add({
      title:
        result.quarantineStatus === 'clean'
          ? 'Subido y escaneado; queda aprobar derechos'
          : 'Subido a cuarentena; aún no se puede publicar',
      color: result.quarantineStatus === 'clean' ? 'success' : 'warning'
    })
    file.value = null
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido subir'), color: 'error' })
  } finally {
    uploading.value = false
  }
}

async function decide(item: MediaAsset, decision: 'approve' | 'reject') {
  const reason = window
    .prompt(decision === 'approve' ? 'Evidencia revisada y motivo de aprobación:' : 'Motivo del bloqueo:')
    ?.trim()
  if (!reason) return
  try {
    await $fetch(`/api/admin/media/${item.id}`, { method: 'PUT', body: { decision, reason } })
    toast.add({ title: decision === 'approve' ? 'Asset aprobado' : 'Asset bloqueado', color: 'success' })
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido aplicar la decisión'), color: 'error' })
  }
}

async function copy(value: string) {
  await navigator.clipboard.writeText(value)
  toast.add({ title: 'Ruta copiada', color: 'success' })
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-slate-900">Biblioteca de medios</h1>
    <p class="mt-1 text-sm text-slate-500">
      MIME real, límites, nombre normalizado, metadatos retirados, antivirus, derechos y aprobación separada.
    </p>

    <form
      class="mt-5 grid gap-3 rounded-2xl border border-slate-200 bg-white p-5 md:grid-cols-2 xl:grid-cols-5"
      @submit.prevent="upload"
    >
      <UFormField label="Archivo JPEG, PNG o PDF" required
        ><input
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          required
          class="block w-full text-sm"
          @change="choose"
      /></UFormField>
      <UFormField label="Propietario / licenciante" required><UInput v-model="form.ownerName" required /></UFormField>
      <UFormField label="Licencia / autorización" required><UInput v-model="form.license" required /></UFormField>
      <UFormField label="Fecha autorizada" required
        ><input
          v-model="form.authorizedAt"
          type="date"
          required
          class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      /></UFormField>
      <UFormField label="Alt (obligatorio en imagen)"><UInput v-model="form.altText" /></UFormField>
      <UButton type="submit" icon="i-lucide-upload" :loading="uploading" class="md:col-span-2 xl:col-span-1"
        >Subir a cuarentena</UButton
      >
    </form>

    <div class="mt-5 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table class="w-full min-w-[1050px] text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
            <th class="px-4 py-3">Archivo</th>
            <th class="px-4 py-3">Técnico</th>
            <th class="px-4 py-3">Derechos</th>
            <th class="px-4 py-3">Estado</th>
            <th class="px-4 py-3">Ruta</th>
            <th class="px-4 py-3 text-right">Decisión</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in data?.items" :key="item.id" class="border-b border-slate-100 align-top">
            <td class="max-w-xs px-4 py-3">
              <p class="font-medium text-slate-800">{{ item.originalName }}</p>
              <p class="mt-1 text-xs text-slate-500">{{ item.altText || 'Sin alt (PDF)' }}</p>
            </td>
            <td class="px-4 py-3 text-xs text-slate-600">
              {{ item.mimeType }}<br />{{ Math.round(item.bytes / 1024) }} KiB<span v-if="item.width">
                · {{ item.width }}×{{ item.height }}</span
              >
            </td>
            <td class="max-w-xs px-4 py-3">
              <p>{{ item.ownerName }}</p>
              <p class="text-xs text-slate-500">
                {{ item.license }} ·
                {{ item.authorizedAt ? new Date(item.authorizedAt).toLocaleDateString('es-ES') : 'sin fecha' }}
              </p>
            </td>
            <td class="px-4 py-3">
              <UBadge variant="subtle">AV: {{ item.quarantineStatus }}</UBadge
              ><br /><UBadge class="mt-1" variant="subtle">Derechos: {{ item.rightsStatus }}</UBadge>
            </td>
            <td class="px-4 py-3">
              <button
                v-if="item.sourceUrl"
                class="font-mono text-xs text-neteco-700 underline"
                @click="copy(item.sourceUrl)"
              >
                {{ item.sourceUrl }}</button
              ><span v-else class="text-slate-400">No publicable</span>
            </td>
            <td class="px-4 py-3 text-right">
              <div v-if="item.rightsStatus === 'pending'" class="flex justify-end gap-1">
                <UButton
                  size="xs"
                  color="success"
                  variant="soft"
                  :disabled="item.quarantineStatus !== 'clean'"
                  @click="decide(item, 'approve')"
                  >Aprobar</UButton
                ><UButton size="xs" color="error" variant="ghost" @click="decide(item, 'reject')">Bloquear</UButton>
              </div>
            </td>
          </tr>
          <tr v-if="!data?.items.length">
            <td colspan="6" class="px-4 py-10 text-center text-slate-500">Aún no hay assets.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
