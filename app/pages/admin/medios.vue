<script setup lang="ts">
import type { Column } from '~/components/ui/DataTable.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Medios · Admin' })

/**
 * Biblioteca de medios.
 *
 * Antes: un formulario de subida de seis campos permanentemente desplegado por encima de
 * la tabla, aunque no fueras a subir nada, y una tabla de 1.050 px de ancho mínimo cuyos
 * estados se mostraban crudos («AV: clean», «Derechos: pending»). Aprobar o bloquear un
 * asset pedía el motivo con `window.prompt()`, siendo una decisión de derechos de imagen
 * que queda registrada.
 *
 * Análisis y revisión de derechos son independientes: publicar exige ambos
 * vigentes, además de una asociación explícita al producto.
 */
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
  canApprove?: boolean
  rightsVersion?: number
  canPublish?: boolean
  publications?: Array<{
    id: string
    title: string
    role: string
    version: string
    status: 'active' | 'withdrawn'
    publicationVersion: number
  }>
}

const {
  data,
  refresh,
  status: fetchStatus
} = await useFetch<{
  items: MediaAsset[]
  capabilities?: { canUpload?: boolean; canApprove?: boolean; canPublish?: boolean }
}>('/api/admin/media')
const toast = useToast()
const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
const publicationAsset = ref<MediaAsset | null>(null)
const canDecide = computed(() => !cloudflare || data.value?.capabilities?.canApprove === true)
const canWithdraw = computed(() => cloudflare && data.value?.capabilities?.canPublish === true)

const QUARANTINE: Record<string, { label: string; color: 'success' | 'warning' | 'error' | 'neutral' }> = {
  clean: { label: 'Analizado', color: 'success' },
  pending: { label: 'En cuarentena', color: 'warning' },
  scanning: { label: 'Analizando', color: 'warning' },
  infected: { label: 'Infectado', color: 'error' },
  failed: { label: 'Análisis fallido', color: 'error' }
}
const RIGHTS: Record<string, { label: string; color: 'success' | 'warning' | 'error' | 'neutral' }> = {
  pending: { label: 'Derechos por revisar', color: 'warning' },
  approved: { label: 'Derechos aprobados', color: 'success' },
  blocked: { label: 'Bloqueado', color: 'error' },
  rejected: { label: 'Bloqueado', color: 'error' }
}

const query = ref('')
const rows = computed(() => {
  const term = query.value.toLowerCase()
  return (data.value?.items ?? []).filter(
    (item) =>
      !term ||
      item.originalName.toLowerCase().includes(term) ||
      (item.ownerName ?? '').toLowerCase().includes(term) ||
      (item.altText ?? '').toLowerCase().includes(term)
  )
})
const awaitingReview = computed(
  () => (data.value?.items ?? []).filter((item) => item.rightsStatus === 'pending' && item.canApprove !== false).length
)

const columns: Column<MediaAsset>[] = [
  { key: 'originalName', label: 'Archivo' },
  { key: 'ownerName', label: 'Derechos' },
  { key: 'quarantineStatus', label: 'Estado' },
  { key: 'sourceUrl', label: cloudflare ? 'Asociaciones' : 'Ruta pública', hideOnMobile: !cloudflare }
]

/* --- Subida --- */
const uploading = ref(false)
const uploadOpen = ref(false)
const form = reactive({ ownerName: '', license: '', authorizedAt: '', altText: '', source: '' })
const file = ref<File | null>(null)

function choose(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

async function upload() {
  if (!file.value || uploading.value || (cloudflare && data.value?.capabilities?.canUpload !== true)) return
  const body = new FormData()
  body.append('file', file.value)
  body.append('ownerName', form.ownerName)
  body.append('license', form.license)
  body.append('authorizedAt', form.authorizedAt)
  body.append('altText', form.altText)
  if (form.source.trim()) body.append('source', form.source.trim())
  uploading.value = true
  try {
    const result = await $fetch<{ quarantineStatus: string }>('/api/admin/media', { method: 'POST', body })
    toast.add({
      title:
        result.quarantineStatus === 'clean'
          ? 'Subido y analizado. Queda aprobar los derechos para poder publicarlo.'
          : 'Subido a cuarentena. No se puede publicar hasta que pase el análisis.',
      color: result.quarantineStatus === 'clean' ? 'success' : 'warning'
    })
    file.value = null
    Object.assign(form, { ownerName: '', license: '', authorizedAt: '', altText: '', source: '' })
    uploadOpen.value = false
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido subir'), color: 'error' })
  } finally {
    uploading.value = false
  }
}

/* --- Decisión de derechos --- */
const deciding = ref<{ item: MediaAsset; decision: 'approve' | 'reject' } | null>(null)
const reason = ref('')
const saving = ref(false)
const decisionCommand = ref<{ payload: string; key: string } | null>(null)

async function confirmDecision() {
  const target = deciding.value
  if (
    !target ||
    saving.value ||
    !canDecide.value ||
    reason.value.trim().length < 3 ||
    (cloudflare && target.decision === 'approve' && target.item.canApprove !== true)
  )
    return
  const payload = JSON.stringify([target.item.id, target.decision, reason.value.trim(), target.item.rightsVersion])
  if (decisionCommand.value?.payload !== payload) decisionCommand.value = { payload, key: crypto.randomUUID() }
  saving.value = true
  try {
    await $fetch(`/api/admin/media/${target.item.id}`, {
      method: 'PUT',
      body: { decision: target.decision, reason: reason.value.trim() },
      headers: {
        'Idempotency-Key': decisionCommand.value.key,
        ...(target.item.rightsVersion !== undefined ? { 'If-Match': String(target.item.rightsVersion) } : {})
      }
    })
    toast.add({
      title: target.decision === 'approve' ? 'Derechos aprobados; la publicación es independiente' : 'Asset bloqueado',
      color: 'success',
      icon: 'i-lucide-check'
    })
    deciding.value = null
    reason.value = ''
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido aplicar la decisión'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function copy(value: string) {
  await navigator.clipboard.writeText(value)
  toast.add({ title: 'Ruta copiada', color: 'success', icon: 'i-lucide-clipboard-check' })
}

const withdrawal = ref<{ asset: MediaAsset; publication: NonNullable<MediaAsset['publications']>[number] } | null>(null)
const withdrawalReason = ref('')
const withdrawing = ref(false)
const withdrawalCommand = ref<{ payload: string; key: string } | null>(null)

async function withdraw() {
  const target = withdrawal.value
  if (!target || !canWithdraw.value || withdrawing.value || withdrawalReason.value.trim().length < 3) return
  const reason = withdrawalReason.value.trim()
  const payload = JSON.stringify([target.publication.id, reason, target.publication.publicationVersion])
  if (withdrawalCommand.value?.payload !== payload) withdrawalCommand.value = { payload, key: crypto.randomUUID() }
  withdrawing.value = true
  try {
    // This explicit publication route is implemented by the Cloudflare ingress.
    const endpoint: string = `/api/admin/media/publications/${target.publication.id}`
    await $fetch(endpoint, {
      method: 'DELETE',
      body: { reason },
      headers: {
        'Idempotency-Key': withdrawalCommand.value.key,
        'If-Match': String(target.publication.publicationVersion)
      }
    })
    withdrawal.value = null
    withdrawalReason.value = ''
    toast.add({ title: 'Asociación retirada; se conserva su historial', color: 'success' })
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido retirar la asociación'), color: 'error' })
  } finally {
    withdrawing.value = false
  }
}

async function publicationCreated() {
  toast.add({
    title: 'Asociación creada; la entrega sigue sujeta a las comprobaciones de publicación',
    color: 'success'
  })
  await refresh()
}

function kib(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`
}
</script>

<template>
  <div>
    <UiPageHeader
      title="Biblioteca de medios"
      :count="rows.length"
      :count-label="rows.length === 1 ? 'archivo' : 'archivos'"
      description="Publicar exige análisis de seguridad y derechos aprobados, además de asociar el archivo explícitamente a un producto."
    >
      <template #actions>
        <UButton
          icon="i-lucide-upload"
          :disabled="cloudflare && data?.capabilities?.canUpload !== true"
          @click="uploadOpen = true"
          >Subir archivo</UButton
        >
      </template>
    </UiPageHeader>

    <UAlert
      v-if="awaitingReview"
      class="mb-4"
      color="warning"
      variant="subtle"
      icon="i-lucide-shield-question"
      :title="`${awaitingReview} ${awaitingReview === 1 ? 'archivo espera' : 'archivos esperan'} la aprobación de derechos`"
      description="Revisa la autorización. Aprobar los derechos no sustituye al análisis de seguridad ni publica el archivo automáticamente."
    />

    <UiDataTable
      :rows="rows"
      :columns="columns"
      :row-key="(row) => row.id"
      :status="fetchStatus === 'pending' ? 'pending' : fetchStatus === 'error' ? 'error' : 'idle'"
      :total="rows.length"
      :per-page="rows.length || 1"
      search-placeholder="Buscar por nombre, propietario o alt"
      empty-title="La biblioteca está vacía"
      empty-description="Sube las fotos de producto y las fichas de seguridad. Cada archivo necesita propietario, licencia y fecha de autorización antes de poder publicarse."
      error-message="No hemos podido cargar la biblioteca."
      @search="(value) => (query = value)"
      @retry="refresh()"
    >
      <template #empty-action>
        <UButton
          icon="i-lucide-upload"
          :disabled="cloudflare && data?.capabilities?.canUpload !== true"
          @click="uploadOpen = true"
          >Subir el primer archivo</UButton
        >
      </template>

      <template #cell-originalName="{ row }">
        <p class="max-w-xs truncate font-medium text-[var(--text-strong)]">{{ row.originalName }}</p>
        <p class="text-xs text-[var(--text-muted)]">
          {{ row.mimeType.replace('image/', '').replace('application/', '').toUpperCase() }} · {{ kib(row.bytes) }}
          <template v-if="row.width"> · {{ row.width }}×{{ row.height }}</template>
        </p>
        <p class="max-w-xs truncate text-xs text-[var(--text-muted)]">
          {{ row.altText || 'Sin texto alternativo' }}
        </p>
      </template>

      <template #cell-ownerName="{ row }">
        <p class="text-[var(--text)]">{{ row.ownerName || '—' }}</p>
        <p class="text-xs text-[var(--text-muted)]">
          {{ row.license || 'Sin licencia' }} ·
          {{ row.authorizedAt ? new Date(row.authorizedAt).toLocaleDateString('es-ES') : 'sin fecha' }}
        </p>
      </template>

      <template #cell-quarantineStatus="{ row }">
        <div class="flex flex-col items-start gap-1">
          <UBadge :color="(QUARANTINE[row.quarantineStatus] ?? { color: 'neutral' }).color" variant="subtle">
            {{ (QUARANTINE[row.quarantineStatus] ?? { label: row.quarantineStatus }).label }}
          </UBadge>
          <UBadge :color="(RIGHTS[row.rightsStatus] ?? { color: 'neutral' }).color" variant="subtle">
            {{ (RIGHTS[row.rightsStatus] ?? { label: row.rightsStatus }).label }}
          </UBadge>
        </div>
      </template>

      <template #cell-sourceUrl="{ row }">
        <ul v-if="cloudflare && row.publications?.length" class="space-y-2 text-xs">
          <li v-for="publication in row.publications" :key="publication.id">
            <p class="max-w-xs break-words">
              {{ publication.title }} · {{ publication.role }} · v{{ publication.version }}
            </p>
            <span class="text-[var(--text-muted)]">{{
              publication.status === 'withdrawn' ? 'Retirada' : 'Asociada (entrega condicionada)'
            }}</span>
            <UButton
              v-if="publication.status === 'active' && canWithdraw"
              size="xs"
              color="error"
              variant="ghost"
              @click="((withdrawal = { asset: row, publication }), (withdrawalReason = ''))"
              >Retirar</UButton
            >
          </li>
        </ul>
        <UButton
          v-else-if="!cloudflare && row.sourceUrl"
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-copy"
          class="font-mono"
          @click="copy(row.sourceUrl)"
        >
          {{ row.sourceUrl }}
        </UButton>
        <span v-else class="text-xs text-[var(--text-muted)]">Sin asociación pública</span>
      </template>

      <template #row-actions="{ row }">
        <div class="flex flex-wrap justify-end gap-1">
          <UButton
            v-if="cloudflare"
            size="xs"
            variant="outline"
            :disabled="!canWithdraw || row.canPublish !== true"
            @click="canWithdraw && row.canPublish === true && (publicationAsset = row)"
            >Asociar</UButton
          >
          <UButton
            v-if="row.rightsStatus !== 'approved' && canDecide"
            size="xs"
            variant="outline"
            :disabled="
              cloudflare
                ? row.canApprove !== true
                : row.canApprove === undefined
                  ? row.quarantineStatus !== 'clean'
                  : !row.canApprove
            "
            :title="
              row.canApprove === undefined && row.quarantineStatus !== 'clean'
                ? 'Tiene que pasar el antivirus primero'
                : undefined
            "
            @click="((deciding = { item: row, decision: 'approve' }), (reason = ''))"
          >
            Aprobar
          </UButton>
          <UButton
            v-if="canDecide && row.rightsStatus !== 'blocked' && row.rightsStatus !== 'rejected'"
            size="xs"
            color="error"
            variant="ghost"
            @click="((deciding = { item: row, decision: 'reject' }), (reason = ''))"
          >
            Bloquear
          </UButton>
        </div>
      </template>
    </UiDataTable>

    <MediaPublicationDialog
      v-if="publicationAsset && canWithdraw"
      :asset="publicationAsset"
      @close="publicationAsset = null"
      @published="publicationCreated"
    />

    <UModal
      :open="Boolean(withdrawal)"
      title="Retirar asociación"
      @update:open="(open) => !open && !withdrawing && (withdrawal = null)"
    >
      <template #body>
        <p class="mb-4 text-sm">
          Retira «{{ withdrawal?.publication.title }}» sin borrar el archivo ni el historial. El resto de asociaciones
          no cambia.
        </p>
        <UFormField label="Motivo de retirada" required hint="Al menos 3 caracteres; queda registrado."
          ><UTextarea v-model="withdrawalReason" maxlength="500" class="w-full"
        /></UFormField>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" :disabled="withdrawing" @click="withdrawal = null">Cancelar</UButton>
          <UButton
            color="error"
            :disabled="!canWithdraw || withdrawalReason.trim().length < 3"
            :loading="withdrawing"
            @click="withdraw"
            >Retirar asociación</UButton
          >
        </div>
      </template>
    </UModal>

    <!-- Subida -->
    <UModal v-model:open="uploadOpen" title="Subir archivo">
      <template #body>
        <form id="media-form" class="space-y-4" @submit.prevent="upload">
          <UFormField label="Archivo" required hint="JPEG, PNG o PDF">
            <input
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              required
              class="block w-full text-sm file:mr-3 file:rounded-[var(--radius-control)] file:border-0 file:bg-[var(--surface-sunken)] file:px-3 file:py-1.5 file:text-sm"
              @change="choose"
            />
          </UFormField>
          <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <UFormField label="Propietario o licenciante" required hint="De quién es la imagen">
              <UInput v-model="form.ownerName" required class="w-full" />
            </UFormField>
            <UFormField label="Licencia o autorización" required>
              <UInput
                v-model="form.license"
                required
                class="w-full"
                placeholder="Cesión del proveedor, banco, propia…"
              />
            </UFormField>
            <UFormField label="Fecha de autorización" required>
              <UInput v-model="form.authorizedAt" type="date" required class="w-full" />
            </UFormField>
            <UFormField label="Texto alternativo" hint="Obligatorio en imágenes, para accesibilidad">
              <UInput v-model="form.altText" class="w-full" />
            </UFormField>
            <UFormField
              label="Referencia de autorización"
              :required="cloudflare"
              hint="Documento, URL o referencia verificable de la licencia. No es una ruta pública del archivo."
              class="sm:col-span-2"
            >
              <UInput v-model="form.source" :required="cloudflare" maxlength="1000" class="w-full" />
            </UFormField>
          </div>
          <p class="text-sm text-[var(--text-muted)]">
            El archivo entra en cuarentena. Publicarlo exige análisis de seguridad vigente, derechos aprobados y una
            asociación explícita al producto. Subirlo o aprobar sus derechos no lo publica automáticamente.
          </p>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="uploadOpen = false">Cancelar</UButton>
          <UButton type="submit" form="media-form" :loading="uploading" icon="i-lucide-upload">Subir</UButton>
        </div>
      </template>
    </UModal>

    <!-- Decisión de derechos -->
    <UModal
      :open="Boolean(deciding)"
      :title="deciding?.decision === 'approve' ? 'Aprobar los derechos' : 'Bloquear el archivo'"
      @update:open="(value) => !value && (deciding = null)"
    >
      <template #body>
        <div v-if="deciding" class="space-y-4">
          <p class="text-[var(--text)]">
            <strong>{{ deciding.item.originalName }}</strong>
            <template v-if="deciding.item.ownerName"> · {{ deciding.item.ownerName }}</template>
          </p>
          <p class="text-sm text-[var(--text-muted)]">
            <template v-if="deciding.decision === 'approve'">
              Aprobar los derechos no publica el archivo: siguen haciendo falta análisis vigente y asociación al
              producto. Confirma que has revisado la autorización.
            </template>
            <template v-else>Quedará bloqueado y no podrá usarse en ninguna parte.</template>
          </p>
          <UFormField
            label="Motivo"
            required
            hint="Queda en el registro de auditoría"
            :error="reason.trim().length && reason.trim().length < 3 ? 'Al menos 3 caracteres.' : ''"
          >
            <UTextarea
              v-model="reason"
              class="w-full"
              :rows="2"
              :placeholder="
                deciding.decision === 'approve'
                  ? 'Contrato de cesión verificado con el proveedor'
                  : 'Sin autorización del titular'
              "
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="deciding = null">Cancelar</UButton>
          <UButton
            :color="deciding?.decision === 'approve' ? 'primary' : 'error'"
            :disabled="reason.trim().length < 3"
            :loading="saving"
            @click="confirmDecision"
          >
            {{ deciding?.decision === 'approve' ? 'Aprobar' : 'Bloquear' }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
