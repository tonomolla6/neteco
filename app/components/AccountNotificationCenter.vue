<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import type {
  AccountNotificationItem,
  AccountNotificationSummary,
  NotificationCategory
} from '~~/shared/account-notifications'

const request = useRequestFetch()

const activeCategory = ref<'all' | NotificationCategory>('all')
const activeStatus = ref<'all' | 'unread' | 'read'>('all')
const notifications = ref<AccountNotificationItem[]>([])
const summary = ref<AccountNotificationSummary | null>(null)
const loading = ref(false)
const markingRead = ref(false)
const errorMessage = ref('')

const categories: Array<{ id: 'all' | NotificationCategory; label: string; icon: string }> = [
  { id: 'all', label: 'Todas', icon: 'i-lucide-inbox' },
  { id: 'pedido', label: 'Pedidos', icon: 'i-lucide-package' },
  { id: 'factura', label: 'Facturas', icon: 'i-lucide-file-text' },
  { id: 'stock', label: 'Stock', icon: 'i-lucide-boxes' },
  { id: 'soporte', label: 'Soporte', icon: 'i-lucide-life-buoy' }
]

function getUnreadCount(catId: 'all' | NotificationCategory): number {
  if (!summary.value) return 0
  if (catId === 'all') return summary.value.unread
  return summary.value.byCategory[catId]?.unread ?? 0
}

async function loadSummary() {
  try {
    const res = await request<AccountNotificationSummary>('/api/account/notifications/summary')
    summary.value = res
  } catch {
    // Graceful degradation
  }
}

async function loadNotifications() {
  loading.value = true
  errorMessage.value = ''
  try {
    const params = new URLSearchParams()
    if (activeCategory.value !== 'all') params.set('category', activeCategory.value)
    if (activeStatus.value !== 'all') params.set('status', activeStatus.value)
    params.set('limit', '50')

    const res = await request<{ total: number; items: AccountNotificationItem[] }>(
      `/api/account/notifications?${params.toString()}`
    )
    notifications.value = res.items
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar notificaciones'
  } finally {
    loading.value = false
  }
}

async function markSingleAsRead(id: string) {
  try {
    markingRead.value = true
    await $fetch('/api/account/notifications/mark-read', {
      method: 'POST',
      body: { notificationIds: [id] }
    })
    const item = notifications.value.find((n) => n.id === id)
    if (item) {
      item.read = true
      item.readAt = new Date().toISOString()
    }
    await loadSummary()
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al marcar como leída'
  } finally {
    markingRead.value = false
  }
}

async function markAllAsRead() {
  try {
    markingRead.value = true
    await $fetch('/api/account/notifications/mark-read', {
      method: 'POST',
      body: { all: true }
    })
    for (const item of notifications.value) {
      item.read = true
      item.readAt = new Date().toISOString()
    }
    await loadSummary()
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al marcar todas como leídas'
  } finally {
    markingRead.value = false
  }
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return iso
  }
}

const hasUnread = computed(() => {
  if (summary.value && summary.value.unread > 0) return true
  return notifications.value.some((n) => !n.read)
})

onMounted(async () => {
  await loadSummary()
  await loadNotifications()
})

watch([activeCategory, activeStatus], () => {
  loadNotifications()
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header with title and Mark All as Read action -->
    <div class="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border)] pb-4">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-[var(--text-strong)]">Centro de notificaciones</h1>
        <p class="mt-1 text-sm text-[var(--text-muted)]">
          Consulta y gestiona las comunicaciones operativas de tus pedidos, facturas, alertas de stock y soporte.
        </p>
      </div>
      <div v-if="hasUnread" class="flex items-center gap-2">
        <button
          type="button"
          data-test="btn-mark-all-read"
          :disabled="markingRead"
          class="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-1.5 text-xs font-semibold text-[var(--text-strong)] transition hover:bg-[var(--surface-raised)] disabled:opacity-50"
          @click="markAllAsRead"
        >
          <span class="size-2 rounded-full bg-neteco-600"></span>
          Marcar todas como leídas
        </button>
      </div>
    </div>

    <!-- Mandatory communication alert notice -->
    <div
      role="note"
      class="flex items-start gap-3 rounded-[var(--radius-control)] border border-blue-200 bg-blue-50/70 p-3.5 text-xs text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-200"
    >
      <span class="mt-0.5 inline-block shrink-0 text-blue-600 dark:text-blue-400">ℹ️</span>
      <div>
        <span class="font-semibold">Aviso legal:</span> Las notificaciones obligatorias no sustituyen los envíos legales
        por email ni documentos fiscales oficiales vinculantes.
      </div>
    </div>

    <!-- Category filter tabs -->
    <div
      class="flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-2"
      role="tablist"
      aria-label="Categorías de notificación"
    >
      <button
        v-for="cat in categories"
        :key="cat.id"
        type="button"
        role="tab"
        :aria-selected="activeCategory === cat.id"
        :data-test="`category-tab-${cat.id}`"
        class="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-3 py-1.5 text-xs font-medium transition-colors"
        :class="
          activeCategory === cat.id
            ? 'bg-neteco-600 text-white shadow-xs'
            : 'text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text-strong)]'
        "
        @click="activeCategory = cat.id"
      >
        <span>{{ cat.label }}</span>
        <span
          v-if="getUnreadCount(cat.id) > 0"
          class="inline-flex size-4 items-center justify-center rounded-full text-[10px] font-bold"
          :class="activeCategory === cat.id ? 'bg-white text-neteco-700' : 'bg-red-500 text-white'"
        >
          {{ getUnreadCount(cat.id) }}
        </span>
      </button>

      <!-- Status filter toggle (Todas vs No leídas) -->
      <div class="ml-auto flex items-center gap-1 pl-2 text-xs">
        <label for="filter-status" class="text-[var(--text-muted)]">Ver:</label>
        <select
          id="filter-status"
          v-model="activeStatus"
          class="rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-strong)]"
        >
          <option value="all">Todas</option>
          <option value="unread">Solo no leídas</option>
          <option value="read">Leídas</option>
        </select>
      </div>
    </div>

    <!-- Error message -->
    <div
      v-if="errorMessage"
      class="rounded-[var(--radius-control)] border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
    >
      {{ errorMessage }}
    </div>

    <!-- Loading skeleton -->
    <div v-if="loading" class="space-y-3">
      <div
        v-for="n in 3"
        :key="n"
        class="animate-pulse rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-sunken)] p-4"
      >
        <div class="h-4 w-1/4 rounded bg-slate-300 dark:bg-slate-700"></div>
        <div class="mt-2 h-3 w-3/4 rounded bg-slate-200 dark:bg-slate-800"></div>
      </div>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="notifications.length === 0"
      class="flex flex-col items-center justify-center rounded-[var(--radius-control)] border border-dashed border-[var(--border)] py-12 text-center"
    >
      <span class="text-3xl">📭</span>
      <h3 class="mt-2 text-sm font-semibold text-[var(--text-strong)]">No tienes notificaciones en esta sección</h3>
      <p class="mt-1 text-xs text-[var(--text-muted)]">
        Cuando se produzcan actualizaciones relevantes en tus pedidos, facturas o soporte, las verás aquí.
      </p>
    </div>

    <!-- Notifications list -->
    <div v-else class="space-y-3" role="feed" aria-label="Lista de notificaciones">
      <article
        v-for="item in notifications"
        :key="item.id"
        class="relative flex flex-col justify-between gap-3 rounded-[var(--radius-control)] border p-4 transition-all sm:flex-row sm:items-start"
        :class="[
          item.read
            ? 'border-[var(--border)] bg-[var(--surface)] opacity-85'
            : 'border-neteco-200 bg-neteco-50/20 shadow-xs dark:border-neteco-800/40 dark:bg-neteco-950/20'
        ]"
      >
        <div class="min-w-0 flex-1 space-y-1.5">
          <div class="flex flex-wrap items-center gap-2">
            <!-- Unread badge/dot -->
            <span
              v-if="!item.read"
              class="inline-block size-2 rounded-full bg-neteco-600"
              title="No leída"
              aria-label="No leída"
            ></span>

            <!-- Category badge -->
            <span
              class="inline-block rounded-[var(--radius-control)] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider"
              :class="{
                'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300': item.category === 'pedido',
                'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300':
                  item.category === 'factura',
                'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300': item.category === 'stock',
                'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300': item.category === 'soporte'
              }"
            >
              {{ item.category }}
            </span>

            <!-- Mandatory badge -->
            <span
              v-if="item.mandatory"
              class="inline-block rounded-[var(--radius-control)] bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-800 dark:bg-slate-700 dark:text-slate-200"
              title="Comunicación obligatoria no desactivable"
            >
              Obligatoria
            </span>

            <span class="text-xs text-[var(--text-muted)]">{{ formatDate(item.createdAt) }}</span>
          </div>

          <h2 class="text-base font-semibold text-[var(--text-strong)]">{{ item.title }}</h2>
          <p class="text-sm text-[var(--text-muted)] leading-relaxed">{{ item.body }}</p>

          <div v-if="item.link" class="pt-1">
            <NuxtLink
              :to="item.link"
              class="inline-flex items-center gap-1 text-xs font-semibold text-neteco-600 hover:underline dark:text-neteco-400"
            >
              Ver detalles →
            </NuxtLink>
          </div>
        </div>

        <!-- Single mark as read button -->
        <div v-if="!item.read" class="shrink-0 self-end sm:self-center">
          <button
            type="button"
            :disabled="markingRead"
            class="rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--text-strong)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
            @click="markSingleAsRead(item.id)"
          >
            Marcar leída
          </button>
        </div>
      </article>
    </div>
  </div>
</template>
