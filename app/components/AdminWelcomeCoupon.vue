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
    errorMessage.value = failureText(err, 'No se ha podido cargar el cupón de bienvenida. Vuelve a intentarlo.')
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
      successMessage.value = 'Cambios guardados. Los cupones nuevos ya usan estas condiciones.'
    }
  } catch (err: unknown) {
    errorMessage.value = failureText(
      err,
      'No se han podido guardar los cambios. Revisa los valores y vuelve a intentarlo.'
    )
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadData()
})

/** Mensaje legible: si otra persona guardó antes, se dice; nunca se enseña el error técnico. */
function failureText(err: unknown, fallback: string) {
  const failure = err as { statusCode?: number; status?: number; response?: { status?: number } }
  return (failure?.statusCode ?? failure?.status ?? failure?.response?.status) === 409
    ? 'Otra persona ha cambiado el cupón mientras lo editabas. Pulsa «Recargar» y vuelve a aplicar tus cambios.'
    : fallback
}
/** Importes en céntimos y margen en centésimas de punto: en pantalla se editan en euros y en %. */
function hundredths(key: 'maxDiscountCents' | 'minOrderCents' | 'marginFloorBasisPoints') {
  return computed<number | ''>({
    get: () => (Number.isFinite(policy.value[key]) ? policy.value[key] / 100 : ''),
    set: (entered) => {
      const value = Number(entered)
      policy.value[key] = (entered as unknown) === '' || !Number.isFinite(value) ? Number.NaN : Math.round(value * 100)
    }
  })
}
const maxDiscountEuros = hundredths('maxDiscountCents')
const minOrderEuros = hundredths('minOrderCents')
const marginFloorPercent = hundredths('marginFloorBasisPoints')
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton icon="i-lucide-rotate-cw" :loading="loading" @click="loadData">Recargar</AdminButton>
    </AdminPageActions>

    <p v-if="loading" role="status" class="adm-help">Cargando el cupón de bienvenida…</p>
    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="errorMessage"
    />
    <UAlert
      v-if="successMessage"
      role="status"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="successMessage"
    />

    <div class="adm-grid">
      <AdminStat
        label="Estado"
        :value="policy.status === 'active' ? 'Activo' : 'En pausa'"
        :hint="policy.status === 'active' ? 'Se entrega a cada cliente nuevo' : 'No se entregan cupones nuevos'"
      />
      <AdminStat
        label="Descuento"
        :value="`${policy.discountPercent} %`"
        :hint="`Hasta ${adminMoney(policy.maxDiscountCents)} por pedido`"
      />
      <AdminStat label="Pedido mínimo" :value="adminMoney(policy.minOrderCents)" />
      <AdminStat label="Caduca a los" :value="`${policy.validityDays} días`" hint="Desde el alta del cliente" />
    </div>

    <AdminCard title="Descuento" description="Lo que recibe cada cliente nuevo, una sola vez.">
      <div class="adm-form-grid">
        <AdminFormField v-slot="{ id }" label="Estado" help="En pausa no se entregan cupones nuevos.">
          <select :id="id" v-model="policy.status" class="w-full" data-testid="welcome-coupon-status">
            <option value="active">Activo</option>
            <option value="paused">En pausa</option>
          </select>
        </AdminFormField>
        <AdminFormField
          v-slot="{ id }"
          label="Comienzo del código"
          help="Cada cupón empieza así y termina con una parte única."
        >
          <input
            :id="id"
            v-model="policy.codePrefix"
            type="text"
            maxlength="16"
            class="w-full uppercase"
            data-testid="welcome-coupon-prefix"
          />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Descuento (%)" help="Entre 1 y 50.">
          <input
            :id="id"
            v-model.number="policy.discountPercent"
            type="number"
            min="1"
            max="50"
            class="w-full"
            data-testid="welcome-coupon-percent"
          />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Descuento máximo por pedido (€)" help="Entre 1 € y 500 €.">
          <input
            :id="id"
            v-model="maxDiscountEuros"
            type="number"
            min="1"
            max="500"
            step="0.01"
            class="w-full"
            data-testid="welcome-coupon-max-cents"
          />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Pedido mínimo (€)" help="0 si no exiges importe mínimo.">
          <input
            :id="id"
            v-model="minOrderEuros"
            type="number"
            min="0"
            max="1000"
            step="0.01"
            class="w-full"
            data-testid="welcome-coupon-min-cents"
          />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Días de validez" help="Desde el alta del cliente. Entre 1 y 90.">
          <input
            :id="id"
            v-model.number="policy.validityDays"
            type="number"
            min="1"
            max="90"
            class="w-full"
            data-testid="welcome-coupon-validity-days"
          />
        </AdminFormField>
      </div>
    </AdminCard>

    <AdminCard title="Protección del margen" description="Dónde no se aplica el cupón para no vender sin beneficio.">
      <div class="adm-stack">
        <div class="adm-form-grid">
          <AdminFormField
            v-slot="{ id }"
            label="Margen mínimo (%)"
            help="El cupón no rebaja un producto por debajo de este margen. Entre 10 y 50."
          >
            <input
              :id="id"
              v-model="marginFloorPercent"
              type="number"
              min="10"
              max="50"
              step="0.01"
              class="w-full"
              data-testid="welcome-coupon-margin-floor"
            />
          </AdminFormField>
          <div class="adm-field justify-center">
            <label class="adm-check">
              <input
                v-model="policy.excludeAlreadyDiscounted"
                type="checkbox"
                data-testid="welcome-coupon-exclude-discounted"
              />
              No aplicar a productos con descuento por volumen
            </label>
          </div>
        </div>
        <AdminFormField
          v-slot="{ id }"
          label="Categorías excluidas"
          help="Identificadores de categoría separados por comas. Vacío: ninguna."
        >
          <input
            :id="id"
            v-model="excludedCategoryText"
            type="text"
            class="w-full"
            data-testid="welcome-coupon-excluded-cats"
          />
        </AdminFormField>
        <AdminFormField
          v-slot="{ id }"
          label="Productos excluidos"
          help="Identificadores de producto separados por comas. Vacío: ninguno."
        >
          <input
            :id="id"
            v-model="excludedProductText"
            type="text"
            class="w-full"
            data-testid="welcome-coupon-excluded-prods"
          />
        </AdminFormField>
      </div>
      <template #footer>
        <AdminButton :disabled="loading || saving" @click="loadData">Descartar cambios</AdminButton>
        <button
          type="button"
          class="adm-btn adm-btn--primary"
          :disabled="saving"
          data-testid="save-welcome-coupon-button"
          @click="savePolicy"
        >
          {{ saving ? 'Guardando…' : 'Guardar cambios' }}
        </button>
      </template>
    </AdminCard>

    <AdminCard
      title="Cómo se evita el abuso"
      description="Estas comprobaciones se aplican siempre; no hay que configurarlas."
    >
      <ul class="list-disc space-y-1 pl-5 text-[var(--text-muted)]">
        <li>Un solo cupón por persona: se detectan las variantes de un mismo correo (alias y puntos).</li>
        <li>También se comparan el teléfono y el NIF o CIF con los cupones ya entregados y usados.</li>
        <li>
          El descuento se calcula sobre el precio más bajo de los últimos 30 días, como exige la normativa de rebajas.
        </li>
        <li>Un único uso: el cupón queda bloqueado tras la primera compra.</li>
      </ul>
    </AdminCard>
  </div>
</template>
