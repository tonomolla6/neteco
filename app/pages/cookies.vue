<script setup lang="ts">
import { parseChatWidget } from '~~/shared/chat-widget'

const runtime = useRuntimeConfig()
const { terms } = useCommercialTerms()
const chat = computed(() => parseChatWidget(runtime.public.commercial))
const chatHost = computed(() => (chat.value ? new URL(chat.value.origin).host : ''))

interface CookieRow {
  name: string
  purpose: string
  duration: string
}

/** Las mismas cookies que leen y escriben `useConsent`, el carrito, la sesión y la medición. */
const necessary: CookieRow[] = [
  {
    name: 'neteco-session',
    purpose: 'Mantener tu sesión iniciada de forma segura.',
    duration: 'Mientras dure la sesión'
  },
  { name: 'neteco-cart, neteco-cart-v2', purpose: 'Recordar los productos de tu carrito.', duration: 'Hasta 90 días' },
  {
    name: 'neteco-order-access',
    purpose: 'Dejarte consultar y pagar un pedido hecho sin cuenta desde este navegador.',
    duration: '24 horas'
  },
  { name: 'neteco-consent-v1', purpose: 'Guardar tu decisión sobre las cookies opcionales.', duration: '180 días' },
  { name: 'price_display', purpose: 'Recordar si prefieres ver los precios con o sin IVA.', duration: '1 año' },
  { name: 'catalog_view', purpose: 'Recordar si ves el catálogo en rejilla o en lista.', duration: '1 año' }
]

const measurement: CookieRow[] = [
  {
    name: 'neteco-analytics-id',
    purpose:
      'Identificador aleatorio para contar visitas y detectar errores en la tienda. Los datos se quedan en nuestros sistemas y no se usan para publicidad.',
    duration: 'Hasta 180 días'
  }
]

function openConsent() {
  window.dispatchEvent(new Event('neteco-open-consent'))
}

const sections = [
  { id: 'que-son', title: 'Qué son las cookies' },
  { id: 'quien', title: 'Quién las usa' },
  { id: 'necesarias', title: 'Necesarias' },
  { id: 'medicion', title: 'Medición' },
  { id: 'marketing', title: 'Marketing' },
  { id: 'gestionar', title: 'Cómo cambiar tu decisión' }
]
</script>

<template>
  <LegalDocument path="/cookies" :sections="sections">
    <template #intro>
      <p>
        Qué cookies usa la tienda, para qué y cuánto duran, según el artículo 22.2 de la LSSI-CE y la guía de la Agencia
        Española de Protección de Datos. Las opcionales están apagadas hasta que las aceptas.
      </p>
    </template>

    <section id="que-son">
      <h2>Qué son las cookies</h2>
      <p>
        Son pequeños archivos que el sitio guarda en tu navegador para recordar información entre una página y otra,
        como tu carrito o tu sesión. En esta política llamamos cookies también a tecnologías parecidas, como el
        almacenamiento local del navegador.
      </p>
    </section>

    <section id="quien">
      <h2>Quién las usa</h2>
      <p>
        Todas las cookies de esta página son propias, es decir, las gestiona
        <LegalDatum :value="terms.companyLegalName" label="razón social">el titular de la tienda</LegalDatum>, salvo las
        del chat de atención si está activo, que son del proveedor del chat. Los datos que se obtienen con ellas se
        tratan como explica la <NuxtLink to="/privacidad">política de privacidad</NuxtLink>.
      </p>
    </section>

    <section id="necesarias">
      <h2>Necesarias</h2>
      <p>
        Hacen que la tienda funcione: sin ellas no se puede iniciar sesión, mantener el carrito ni pagar. Están exentas
        de consentimiento y no se pueden desactivar desde el gestor, aunque sí borrar desde tu navegador.
      </p>
      <div class="legal-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Cookie</th>
              <th scope="col">Para qué sirve</th>
              <th scope="col">Duración</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in necessary" :key="row.name">
              <td>
                <code>{{ row.name }}</code>
              </td>
              <td>{{ row.purpose }}</td>
              <td>{{ row.duration }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section id="medicion">
      <h2>Medición</h2>
      <p>
        Solo se activan si aceptas la categoría <strong>Medición</strong> en el gestor de cookies. Si después la
        retiras, borramos el identificador de inmediato.
      </p>
      <div class="legal-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Cookie</th>
              <th scope="col">Para qué sirve</th>
              <th scope="col">Duración</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in measurement" :key="row.name">
              <td>
                <code>{{ row.name }}</code>
              </td>
              <td>{{ row.purpose }}</td>
              <td>{{ row.duration }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section id="marketing">
      <h2>Marketing</h2>
      <p>Solo se activan si aceptas la categoría <strong>Marketing</strong> en el gestor de cookies.</p>
      <p v-if="chat?.requiresConsent">
        Ahora mismo esta categoría incluye el chat de atención, que carga un servicio externo desde
        <code>{{ chatHost }}</code> y puede guardar sus propias cookies para recordar tu conversación. Si no aceptas
        esta categoría, el chat no se carga y puedes escribirnos desde <NuxtLink to="/contacto">Contacto</NuxtLink>.
      </p>
      <p v-else>
        Ahora mismo no usamos ninguna cookie de marketing. Si activamos un proveedor de este tipo, lo añadiremos aquí
        antes de usarlo y solo funcionará con tu consentimiento.
      </p>
      <p v-if="chat && !chat.requiresConsent">
        El chat de atención carga un servicio externo desde <code>{{ chatHost }}</code
        >. Su proveedor no guarda cookies en tu navegador, por eso se carga sin pedirte consentimiento.
      </p>
    </section>

    <section id="gestionar">
      <h2>Cómo cambiar tu decisión</h2>
      <p>
        Puedes aceptar, rechazar o elegir por categorías cuando quieras, también desde el enlace «Configurar cookies»
        del pie de cada página. Tu decisión se recuerda 180 días; pasado ese plazo te lo volvemos a preguntar.
      </p>
      <p>
        <UButton data-open-consent color="neutral" variant="outline" @click="openConsent">Configurar cookies</UButton>
      </p>
      <p>
        También puedes borrar o bloquear las cookies desde la configuración de tu navegador. Si bloqueas las necesarias,
        no podrás iniciar sesión ni comprar.
      </p>
    </section>
  </LegalDocument>
</template>
