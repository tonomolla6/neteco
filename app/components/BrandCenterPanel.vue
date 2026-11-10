<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { BrandCenterView, OfficialCertification } from '~~/shared/brand-certifications'

const request = useRequestFetch()

const loading = ref(true)
const unavailable = ref(false)
const error = ref<string | null>(null)
const data = ref<BrandCenterView | null>(null)

// Live verification tool
const verifyInput = ref('')
const verifyLoading = ref(false)
const verifyResult = ref<OfficialCertification | null>(null)
const verifyError = ref<string | null>(null)

async function loadBrandCenter() {
  loading.value = true
  error.value = null
  unavailable.value = false
  try {
    const res = await request<BrandCenterView>('/api/brand-center', { method: 'GET' })
    data.value = res
  } catch (cause: unknown) {
    const err = cause as {
      statusCode?: number
      status?: number
      response?: { status?: number }
      data?: { error?: { code?: string } }
    } | null
    const status = err?.statusCode ?? err?.status ?? err?.response?.status
    const code = err?.data?.error?.code
    if (status === 404 || status === 503 || code === 'feature_disabled') {
      unavailable.value = true
    } else {
      error.value = 'No se pudo cargar la información del centro de marca y certificaciones.'
    }
  } finally {
    loading.value = false
  }
}

async function verifyCertificate() {
  const query = verifyInput.value.trim()
  if (!query) return
  verifyLoading.value = true
  verifyResult.value = null
  verifyError.value = null
  try {
    const cert = await request<OfficialCertification>(`/api/brand-center/verify/${encodeURIComponent(query)}`, {
      method: 'GET'
    })
    verifyResult.value = cert
  } catch {
    verifyError.value = `No se encontró ningún certificado oficial activo con el número "${query}".`
  } finally {
    verifyLoading.value = false
  }
}

onMounted(() => {
  loadBrandCenter()
})
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-8" data-testid="brand-center-panel">
    <!-- Header -->
    <header class="mb-8 border-b border-slate-200 pb-6">
      <h1 class="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
        Centro de marca y certificaciones oficiales
      </h1>
      <p class="mt-2 text-base text-slate-600 sm:text-lg">
        Acceso a los activos autorizados de nuestra marca, normativas de uso e inventario auditado de certificaciones de
        calidad, gestión ambiental y seguridad química.
      </p>
    </header>

    <!-- Anti-greenwashing guarantee banner -->
    <div
      class="mb-8 rounded-xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm"
      data-testid="anti-greenwashing-banner"
    >
      <div class="flex items-start gap-4">
        <div>
          <h2 class="text-base font-bold text-emerald-900">
            Política de tolerancia cero con sellos vagos y greenwashing
          </h2>
          <p class="mt-1 text-sm text-emerald-800 leading-relaxed">
            En Neteco rechazamos el uso de sellos ecológicos auto-creados, etiquetas vagas sin sustento técnico o
            logotipos comerciales sin acreditación externa. Todas las certificaciones mostradas en este portal cuentan
            con un número de registro oficial expedido por organismos de control acreditados por ENAC o la Comisión
            Europea, con alcance y fecha de caducidad públicamente verificables.
          </p>
        </div>
      </div>
    </div>

    <!-- Verification tool -->
    <div class="mb-10 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" data-testid="cert-verification-tool">
      <h2 class="text-lg font-bold text-slate-900">Verificador instantáneo de certificados</h2>
      <p class="mt-1 text-xs text-slate-600">
        Introduzca el número de certificado oficial para comprobar en tiempo real su vigencia, alcance auditado y
        entidad certificadora.
      </p>

      <form class="mt-4 flex flex-col sm:flex-row gap-3" @submit.prevent="verifyCertificate">
        <input
          v-model="verifyInput"
          type="text"
          placeholder="Ej. ER-0428/2021, ES-MD/020/001..."
          class="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm text-slate-900 focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600"
        />
        <button
          type="submit"
          :disabled="verifyLoading || !verifyInput.trim()"
          class="rounded-lg bg-emerald-700 px-6 py-2.5 text-sm font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {{ verifyLoading ? 'Verificando...' : 'Verificar Certificado' }}
        </button>
      </form>

      <!-- Verification result card -->
      <div
        v-if="verifyResult"
        class="mt-4 rounded-xl border border-emerald-300 bg-emerald-50/70 p-4"
        data-testid="verification-success"
      >
        <div class="flex items-center justify-between">
          <span class="rounded bg-emerald-700 px-2.5 py-0.5 text-xs font-bold text-white uppercase">
            {{ verifyResult.standardCode }} — CERTIFICADO VIGENTE
          </span>
          <span class="text-xs text-slate-500">Nº {{ verifyResult.certificateNumber }}</span>
        </div>
        <h3 class="mt-2 text-base font-bold text-slate-900">{{ verifyResult.title }}</h3>
        <p class="mt-1 text-xs text-slate-700"><strong>Alcance:</strong> {{ verifyResult.scope }}</p>
        <p class="mt-1 text-xs text-slate-600">
          <strong>Emisor:</strong> {{ verifyResult.issuer }} | <strong>Auditor:</strong> {{ verifyResult.auditedBy }} |
          <strong>Vigencia:</strong> {{ verifyResult.validFrom.slice(0, 10) }} al
          {{ verifyResult.validUntil.slice(0, 10) }}
        </p>
        <div class="mt-3 flex gap-4 text-xs">
          <a
            :href="verifyResult.verificationUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="font-bold text-emerald-800 hover:underline"
          >
            ↗ Enlace de verificación en sede del emisor
          </a>
        </div>
      </div>

      <div
        v-else-if="verifyError"
        class="mt-4 rounded-lg bg-red-50 p-4 text-xs font-semibold text-red-700"
        data-testid="verification-failure"
      >
        {{ verifyError }}
      </div>
    </div>

    <!-- Main Content Loading / Error -->
    <div v-if="loading" class="py-12 text-center" aria-busy="true">
      <div
        class="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-emerald-600 border-r-transparent align-[-0.125em]"
      />
      <p class="mt-3 text-sm text-slate-500">Cargando directorio de certificados y marca...</p>
    </div>

    <div
      v-else-if="unavailable"
      class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500"
    >
      Esta sección estará disponible próximamente.
    </div>

    <div v-else-if="error" class="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-red-800" role="alert">
      <p class="text-sm font-semibold">{{ error }}</p>
      <button
        type="button"
        class="mt-3 rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700"
        @click="loadBrandCenter"
      >
        Reintentar
      </button>
    </div>

    <div v-else-if="data" class="space-y-12">
      <!-- Section 1: Official Certifications -->
      <section data-testid="official-certifications-section">
        <div class="border-b border-slate-200 pb-4">
          <h2 class="text-2xl font-bold text-slate-900">Certificaciones vigentes y auditadas</h2>
          <p class="mt-1 text-sm text-slate-600">
            Acreditaciones bajo normas ISO, EU Ecolabel y registros oficiales sanitarios/ADR.
          </p>
        </div>

        <div class="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div
            v-for="cert in data.certifications"
            :key="cert.id"
            class="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 shadow-sm hover:shadow"
            data-testid="cert-card"
          >
            <div>
              <div class="flex items-center justify-between">
                <span class="rounded bg-slate-900 px-2.5 py-0.5 text-xs font-bold text-white">
                  {{ cert.standardCode }}
                </span>
                <span class="text-xs text-slate-500 font-mono">Nº {{ cert.certificateNumber }}</span>
              </div>

              <h3 class="mt-3 text-lg font-bold text-slate-900">
                {{ cert.title }}
              </h3>

              <div class="mt-3 space-y-1.5 text-xs text-slate-600">
                <p><strong>Organismo Emisor:</strong> {{ cert.issuer }}</p>
                <p><strong>Auditor Acreditado:</strong> {{ cert.auditedBy }}</p>
                <p>
                  <strong>Periodo de Vigencia:</strong> {{ cert.validFrom.slice(0, 10) }} —
                  {{ cert.validUntil.slice(0, 10) }}
                </p>
              </div>

              <div class="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-700 leading-relaxed">
                <strong>Alcance Oficial:</strong> {{ cert.scope }}
              </div>
            </div>

            <div class="mt-6 flex items-center justify-between border-t border-slate-100 pt-4 text-xs font-bold">
              <a
                :href="cert.verificationUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="text-emerald-700 hover:text-emerald-900"
              >
                ↗ Verificar en entidad oficial
              </a>
              <a
                :href="cert.documentUrl"
                target="_blank"
                class="rounded bg-slate-100 px-3 py-1.5 text-slate-800 hover:bg-slate-200"
              >
                Ver documento
              </a>
            </div>
          </div>
        </div>
      </section>

      <!-- Section 2: Authorized Brand Assets & Guidelines -->
      <section data-testid="brand-assets-section">
        <div class="border-b border-slate-200 pb-4">
          <h2 class="text-2xl font-bold text-slate-900">Activos de marca autorizados</h2>
          <p class="mt-1 text-sm text-slate-600">
            Logotipos y especificaciones gráficas de Neteco Professional Cleaning.
          </p>
        </div>

        <div class="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="asset in data.brandAssets"
            :key="asset.id"
            class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
            data-testid="brand-asset-card"
          >
            <div class="flex items-center justify-between text-xs text-slate-500">
              <span class="rounded bg-blue-50 px-2 py-0.5 font-bold uppercase text-blue-700">{{ asset.format }}</span>
              <span>Área mín: {{ asset.minClearspacePx }}px</span>
            </div>

            <div class="my-6 flex h-24 items-center justify-center rounded-lg bg-slate-50 border border-slate-100 p-4">
              <span class="text-xl font-extrabold tracking-wider text-slate-800 uppercase">
                NETECO <span class="text-blue-600">PRO</span>
              </span>
            </div>

            <h3 class="text-sm font-bold text-slate-900">{{ asset.name }}</h3>

            <div class="mt-3 border-t border-slate-100 pt-3">
              <p class="text-xs font-semibold text-slate-700">Usos estrictamente prohibidos:</p>
              <ul class="mt-1 list-disc pl-4 text-xs text-slate-500 space-y-1">
                <li v-for="(proh, idx) in asset.prohibitedUses" :key="idx">{{ proh }}</li>
              </ul>
            </div>

            <div class="mt-4">
              <a
                :href="asset.url"
                download
                class="block w-full rounded-lg bg-slate-900 py-2 text-center text-xs font-bold text-white hover:bg-slate-800"
              >
                Descargar {{ asset.format.toUpperCase() }} Oficial
              </a>
            </div>
          </div>
        </div>

        <!-- Guidelines note -->
        <div class="mt-6 rounded-xl bg-slate-50 p-6 text-xs text-slate-600 border border-slate-200">
          <h3 class="font-bold text-slate-900 text-sm">Normativa de uso de la marca</h3>
          <ul class="mt-2 list-disc pl-5 space-y-1">
            <li v-for="(rule, idx) in data.usageGuidelines.generalRules" :key="idx">{{ rule }}</li>
          </ul>
          <p class="mt-3">
            <strong>Fórmula de área de reserva:</strong> {{ data.usageGuidelines.minimumClearspaceFormula }}
          </p>
        </div>
      </section>

      <!-- Section 3: Authorized Partners & Official Distributors -->
      <section data-testid="brand-authorizations-section">
        <div class="border-b border-slate-200 pb-4">
          <h2 class="text-2xl font-bold text-slate-900">Directorio de partners autorizados</h2>
          <p class="mt-1 text-sm text-slate-600">
            Entidades formalmente autorizadas para el uso de la marca Neteco en sus canales.
          </p>
        </div>

        <div class="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table class="min-w-full divide-y divide-slate-200 text-left text-xs">
            <thead class="bg-slate-50 font-semibold text-slate-700">
              <tr>
                <th class="px-4 py-3">Razón Social / Partner</th>
                <th class="px-4 py-3">Dominio Autorizado</th>
                <th class="px-4 py-3">Alcance de Autorización</th>
                <th class="px-4 py-3">Estado</th>
                <th class="px-4 py-3">Validez</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 text-slate-600">
              <tr v-for="auth in data.authorizations" :key="auth.id">
                <td class="px-4 py-3 font-bold text-slate-900">{{ auth.partnerName }}</td>
                <td class="px-4 py-3 font-mono text-blue-600">{{ auth.authorizedDomain }}</td>
                <td class="px-4 py-3 capitalize">{{ auth.scope.replace(/_/g, ' ') }}</td>
                <td class="px-4 py-3">
                  <span
                    class="rounded px-2 py-0.5 text-xs font-semibold"
                    :class="auth.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'"
                  >
                    {{ auth.status }}
                  </span>
                </td>
                <td class="px-4 py-3">
                  {{ auth.validFrom.slice(0, 10) }} al
                  {{ auth.validUntil ? auth.validUntil.slice(0, 10) : 'Indefinida' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>
