<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { WelcomeCouponPolicy } from '~~/shared/welcome-coupon'

const requestFetch = useRequestFetch()

const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

const policy = ref<WelcomeCouponPolicy>({
  id: 'global',
  version: 1,
  status: 'active',
  codePrefix: 'BIENVENIDA',
  discountPercent: 10,
  maxDiscountCents: 1500,
  minOrderCents: 5000,
  validityDays: 14,
  excludedCategoryIds: [],
  excludedProductIds: [],
  excludeAlreadyDiscounted: true,
  marginFloorBasisPoints: 2000,
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
})

const excludedCategoryText = ref('')
const excludedProductText = ref('')

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await requestFetch<{ policy?: WelcomeCouponPolicy }>('/api/admin/welcome-coupon/policy')
    if (res?.policy) {
      policy.value = { ...res.policy }
      excludedCategoryText.value = (res.policy.excludedCategoryIds ?? []).join(', ')
      excludedProductText.value = (res.policy.excludedProductIds ?? []).join(', ')
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al cargar la política de cupón de bienvenida'
  } finally {
    loading.value = false
  }
}

async function savePolicy() {
  saving.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const cats = excludedCategoryText.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const prods = excludedProductText.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const res = await requestFetch<{ policy?: WelcomeCouponPolicy }>('/api/admin/welcome-coupon/policy', {
      method: 'PUT',
      body: {
        expectedVersion: policy.value.version,
        status: policy.value.status,
        codePrefix: policy.value.codePrefix,
        discountPercent: Number(policy.value.discountPercent),
        maxDiscountCents: Number(policy.value.maxDiscountCents),
        minOrderCents: Number(policy.value.minOrderCents),
        validityDays: Number(policy.value.validityDays),
        excludedCategoryIds: cats,
        excludedProductIds: prods,
        excludeAlreadyDiscounted: policy.value.excludeAlreadyDiscounted,
        marginFloorBasisPoints: Number(policy.value.marginFloorBasisPoints)
      }
    })
    if (res?.policy) {
      policy.value = { ...res.policy }
      successMessage.value = 'Política de cupón de bienvenida guardada con éxito (v' + res.policy.version + ')'
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'Error al guardar la política'
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-lg font-bold text-neutral-900">Cupón de Bienvenida Administrable (MKT-016)</h2>
        <p class="text-xs text-neutral-500">
          Un único uso por identidad física/fiscal con reglas antifraude, caducidad estricta y exclusiones de margen.
        </p>
      </div>
      <button
        type="button"
        class="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-200"
        :disabled="loading"
        @click="loadData"
      >
        Recargar
      </button>
    </div>

    <!-- Messages -->
    <div v-if="loading" role="status" class="rounded-lg bg-neutral-100 p-4 text-sm text-neutral-600">
      Cargando configuración de cupón de bienvenida...
    </div>

    <div v-if="errorMessage" role="alert" class="rounded-lg bg-red-50 p-4 text-sm text-red-800">
      {{ errorMessage }}
    </div>

    <div v-if="successMessage" role="status" class="rounded-lg bg-green-50 p-4 text-sm text-green-800">
      {{ successMessage }}
    </div>

    <!-- Policy Form -->
    <div class="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm space-y-4">
      <h3 class="text-sm font-semibold text-neutral-900">Condiciones y Reglas Comerciales</h3>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">Estado de emisión</label>
          <select
            v-model="policy.status"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="welcome-coupon-status"
          >
            <option value="active">Activo</option>
            <option value="paused">Pausado</option>
          </select>
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">Prefijo de código</label>
          <input
            v-model="policy.codePrefix"
            type="text"
            maxlength="16"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm uppercase"
            data-testid="welcome-coupon-prefix"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">Porcentaje de Descuento (%)</label>
          <input
            v-model.number="policy.discountPercent"
            type="number"
            min="1"
            max="50"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="welcome-coupon-percent"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">Tope máximo de descuento (céntimos)</label>
          <input
            v-model.number="policy.maxDiscountCents"
            type="number"
            min="100"
            max="50000"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="welcome-coupon-max-cents"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">Pedido mínimo requerido (céntimos)</label>
          <input
            v-model.number="policy.minOrderCents"
            type="number"
            min="0"
            max="100000"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="welcome-coupon-min-cents"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">Caducidad de cupón (días tras alta)</label>
          <input
            v-model.number="policy.validityDays"
            type="number"
            min="1"
            max="90"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="welcome-coupon-validity-days"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1"
            >Suelo de margen bruto (bps, ej: 2000 = 20%)</label
          >
          <input
            v-model.number="policy.marginFloorBasisPoints"
            type="number"
            min="1000"
            max="5000"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            data-testid="welcome-coupon-margin-floor"
          />
        </div>

        <div class="flex items-center space-x-2 pt-6">
          <label class="flex items-center space-x-2">
            <input
              v-model="policy.excludeAlreadyDiscounted"
              type="checkbox"
              class="rounded border-neutral-300 text-blue-600"
              data-testid="welcome-coupon-exclude-discounted"
            />
            <span class="font-medium text-neutral-700">Excluir artículos con descuento por volumen</span>
          </label>
        </div>

        <div class="md:col-span-2">
          <label class="block text-xs font-medium text-neutral-600 mb-1">
            Categorías excluidas (IDs separados por coma)
          </label>
          <input
            v-model="excludedCategoryText"
            type="text"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            placeholder="cat-1, cat-2"
            data-testid="welcome-coupon-excluded-cats"
          />
        </div>

        <div class="md:col-span-2">
          <label class="block text-xs font-medium text-neutral-600 mb-1">
            Productos excluidos (IDs separados por coma)
          </label>
          <input
            v-model="excludedProductText"
            type="text"
            class="w-full rounded-md border border-neutral-300 px-3 py-1.5 text-sm"
            placeholder="prod-1, prod-2"
            data-testid="welcome-coupon-excluded-prods"
          />
        </div>

        <div class="md:col-span-2 flex justify-end">
          <button
            type="button"
            class="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="saving"
            data-testid="save-welcome-coupon-button"
            @click="savePolicy"
          >
            {{ saving ? 'Guardando...' : 'Guardar Política de Bienvenida' }}
          </button>
        </div>
      </div>

      <!-- Anti-fraud disclosure -->
      <div class="rounded-md bg-neutral-50 p-4 border border-neutral-200 text-xs text-neutral-600 space-y-1">
        <p class="font-semibold text-neutral-800">
          Mecanismos Antifraude y Cumplimiento Normativo (Directiva Ómnibus):
        </p>
        <ul class="list-disc pl-5 space-y-0.5">
          <li>
            Normalización de correo canónico con descarte de alias Gmail (+promo, puntos) para evitar registros
            duplicados.
          </li>
          <li>
            Comprobación cruzada de teléfono nacional/internacional y NIF/CIF fiscal en histórico de emisiones y canjes.
          </li>
          <li>
            Verificación frente a precio de referencia en 30 días para evitar descuentos sobre precios inflados
            artificialmente.
          </li>
          <li>
            Estricto único uso: el cupón queda bloqueado tras la primera compra y no se permite descuento perpetuo.
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
