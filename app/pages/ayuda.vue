<script setup lang="ts">
import { formatCommercialAmount } from '~~/shared/commercial-terms'

/**
 * Centro de ayuda: buscar, elegir tema, leer la respuesta y, si no basta, hablar con una
 * persona. Las respuestas se escriben con las preguntas del cliente y con los datos
 * comerciales configurados (días de reparto, hora de corte, umbral de portes): ninguna
 * cifra va escrita a mano. No hay asistente automático: aquí responde el equipo.
 */
useSeoMeta({
  title: 'Centro de ayuda',
  description: 'Ayuda para comprar, pagar, recibir, facturar y devolver pedidos NETECO.'
})

const runtime = useRuntimeConfig()
const { terms, phone, email, deferredPayment } = useCommercialTerms()
const bankTransfer = computed(() => runtime.public.bankTransferEnabled === true)

interface HelpLink {
  label: string
  to: string
}
interface HelpQuestion {
  id: string
  topic: string
  question: string
  answer: string
  link?: HelpLink
}

const topics = [
  { id: 'pedidos', label: 'Pedidos', icon: 'i-lucide-package', text: 'Hacer, seguir y repetir un pedido' },
  { id: 'envios', label: 'Envíos y entrega', icon: 'i-lucide-truck', text: 'Plazos, zonas y coste del envío' },
  { id: 'pagos', label: 'Pagos y facturas', icon: 'i-lucide-credit-card', text: 'Formas de pago y facturación' },
  { id: 'devoluciones', label: 'Devoluciones', icon: 'i-lucide-rotate-ccw', text: 'Devolver o cambiar un producto' },
  { id: 'cuenta', label: 'Tu cuenta', icon: 'i-lucide-user-round', text: 'Acceso, direcciones y empresa' }
] as const

const questions = computed<HelpQuestion[]>(() => {
  const t = terms.value
  const delivery = [
    t.ownDeliveryDays
      ? `En Ontinyent y la Vall d'Albaida repartimos nosotros: ${t.ownDeliveryDays}${
          t.orderCutoffTime ? `, con los pedidos hechos antes de las ${t.orderCutoffTime}` : ''
        }.`
      : "En Ontinyent y la Vall d'Albaida repartimos nosotros con nuestra propia furgoneta.",
    t.parcelLeadTime
      ? `Al resto de la península enviamos por agencia en ${t.parcelLeadTime}.`
      : 'Al resto de la península enviamos por agencia.',
    'En cada producto y en el carrito verás la fecha concreta de entrega para tu código postal.'
  ].join(' ')
  const shippingCost = [
    t.parcelFreeFromCents !== null
      ? `El envío por agencia es gratis a partir de ${formatCommercialAmount(t.parcelFreeFromCents)} en paquetería estándar.`
      : '',
    t.ownDeliveryCostCents === 0 ? 'El reparto propio no tiene coste.' : '',
    'El coste exacto aparece en el carrito al indicar tu código postal, siempre antes de pagar.'
  ]
    .filter(Boolean)
    .join(' ')
  const payment = [
    bankTransfer.value ? 'Con tarjeta, Bizum o transferencia bancaria.' : 'Con tarjeta o Bizum.',
    deferredPayment.value ? 'Las empresas con cuenta aprobada pueden además pagar a plazo.' : '',
    'El pedido se confirma en cuanto el banco nos avisa de que el pago ha salido bien.'
  ]
    .filter(Boolean)
    .join(' ')

  return [
    {
      id: 'como-pedir',
      topic: 'pedidos',
      question: '¿Cómo hago un pedido?',
      answer:
        'Busca el producto por nombre o referencia, entra en su ficha, elige formato y cantidad y añádelo al carrito. Si ya conoces las referencias, con el pedido rápido las escribes o pegas todas de una vez.',
      link: { label: 'Ir al pedido rápido', to: '/pedido-rapido' }
    },
    {
      id: 'estado-pedido',
      topic: 'pedidos',
      question: '¿Dónde veo cómo va mi pedido?',
      answer:
        'En «Mis pedidos», dentro de tu cuenta, tienes el estado de cada pedido y su seguimiento. También te avisamos por correo cuando sale de nuestro almacén.',
      link: { label: 'Ver mis pedidos', to: '/cuenta/pedidos' }
    },
    {
      id: 'repetir-pedido',
      topic: 'pedidos',
      question: '¿Puedo repetir un pedido anterior?',
      answer:
        'Sí. Desde «Mis pedidos» puedes volver a pedir lo mismo en un clic y cambiar cantidades antes de confirmarlo. Si compras siempre lo mismo, guárdalo en una lista y pídela cuando la necesites.',
      link: { label: 'Ver mis listas', to: '/cuenta/listas' }
    },
    {
      id: 'cambiar-pedido',
      topic: 'pedidos',
      question: 'Quiero cambiar o cancelar un pedido',
      answer:
        'Si el pedido todavía no ha salido, escríbenos o llámanos cuanto antes con el número de pedido y lo revisamos. Una vez enviado, se gestiona como una devolución.',
      link: { label: 'Contactar', to: '/contacto' }
    },
    {
      id: 'cuando-llega',
      topic: 'envios',
      question: '¿Cuándo me llega el pedido?',
      answer: delivery,
      link: { label: 'Envíos y reparto', to: '/envios' }
    },
    {
      id: 'coste-envio',
      topic: 'envios',
      question: '¿Cuánto cuesta el envío?',
      answer: shippingCost,
      link: { label: 'Ver costes de envío', to: '/envios' }
    },
    {
      id: 'zonas',
      topic: 'envios',
      question: '¿A qué zonas enviáis?',
      answer:
        "Con reparto propio en Ontinyent y la Vall d'Albaida, y por agencia a toda la península. Si tu entrega tiene alguna dificultad de acceso, indícalo en las instrucciones del pedido.",
      link: { label: 'Zonas y plazos', to: '/envios' }
    },
    {
      id: 'formas-de-pago',
      topic: 'pagos',
      question: '¿Cómo puedo pagar?',
      answer: payment,
      link: { label: 'Formas de pago', to: '/formas-de-pago' }
    },
    {
      id: 'pago-seguro',
      topic: 'pagos',
      question: '¿Es seguro pagar con tarjeta?',
      answer:
        'Sí. El pago se hace en la pasarela de tu banco, no en nuestra web: NETECO nunca ve ni guarda el número de tu tarjeta. Si cierras el navegador a mitad, el pedido espera la confirmación del banco y nunca se cobra dos veces.'
    },
    {
      id: 'factura',
      topic: 'pagos',
      question: '¿Dónde descargo mi factura?',
      answer:
        'Cada pedido lleva su factura con los datos fiscales que indiques al comprar. La tienes en el detalle del pedido, dentro de tu cuenta. Si falta alguna o hay un dato fiscal incorrecto, escríbenos y la corregimos.',
      link: { label: 'Ir a mis pedidos', to: '/cuenta/pedidos' }
    },
    {
      id: 'como-devolver',
      topic: 'devoluciones',
      question: '¿Cómo devuelvo un producto?',
      answer:
        'Abre el pedido desde tu cuenta y solicita la devolución indicando qué unidades y por qué. Te confirmamos los pasos y, en zona de reparto propio, lo recogemos nosotros.',
      link: { label: 'Devoluciones', to: '/devoluciones' }
    },
    {
      id: 'plazo-devolucion',
      topic: 'devoluciones',
      question: '¿Qué plazo tengo para devolver?',
      answer:
        'Si compras como consumidor tienes 14 días naturales desde la entrega para desistir de la compra. Las excepciones y el formulario están en las condiciones generales.',
      link: { label: 'Condiciones de desistimiento', to: '/condiciones-generales#desistimiento' }
    },
    {
      id: 'incidencia',
      topic: 'devoluciones',
      question: 'Me ha llegado algo roto o equivocado',
      answer:
        'Lo sentimos. Escríbenos con el número de pedido y, si puedes, una foto de cómo ha llegado. Lo revisamos y te damos una solución lo antes posible.',
      link: { label: 'Contactar', to: '/contacto' }
    },
    {
      id: 'clave',
      topic: 'cuenta',
      question: 'He olvidado mi contraseña',
      answer:
        'Indica tu correo y te enviamos un enlace para crear una contraseña nueva. Si no llega en unos minutos, revisa la carpeta de correo no deseado.',
      link: { label: 'Recuperar contraseña', to: '/recuperar-clave' }
    },
    {
      id: 'direcciones',
      topic: 'cuenta',
      question: '¿Cómo cambio mis direcciones de entrega?',
      answer:
        'En tu cuenta, en «Direcciones», puedes añadir, editar o quitar direcciones y elegir la que se usa por defecto. También puedes dar una dirección nueva al tramitar el pedido.',
      link: { label: 'Mis direcciones', to: '/cuenta/direcciones' }
    },
    {
      id: 'empresa',
      topic: 'cuenta',
      question: 'Compro para una empresa o un autónomo',
      answer: `Indica tus datos fiscales al comprar y la factura saldrá con ellos. Con el conmutador de la cabecera puedes ver todos los precios sin IVA.${
        deferredPayment.value ? ' Las empresas con cuenta aprobada pueden solicitar el pago a plazo.' : ''
      }`,
      link: { label: 'Solicitar condiciones de empresa', to: '/contacto' }
    }
  ]
})

const quickLinks = [
  { icon: 'i-lucide-package-search', title: 'Seguir un pedido', to: '/cuenta/pedidos' },
  { icon: 'i-lucide-truck', title: 'Plazos de entrega', to: '/envios' },
  { icon: 'i-lucide-rotate-ccw', title: 'Devolver un producto', to: '/devoluciones' },
  { icon: 'i-lucide-receipt-text', title: 'Descargar una factura', to: '/cuenta/pedidos' },
  { icon: 'i-lucide-credit-card', title: 'Formas de pago', to: '/formas-de-pago' },
  { icon: 'i-lucide-key-round', title: 'Recuperar contraseña', to: '/recuperar-clave' }
]

const query = ref('')
const topic = ref<string>('')

function fold(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}
const tokens = computed(() => fold(query.value).split(/\s+/).filter(Boolean))
const searching = computed(() => tokens.value.length > 0)

/** Con búsqueda se mira en todos los temas; sin ella, el tema elegido (o todos). */
const results = computed(() => {
  if (searching.value)
    return questions.value.filter((item) => {
      const text = fold(`${item.question} ${item.answer}`)
      return tokens.value.every((token) => text.includes(token))
    })
  return topic.value ? questions.value.filter((item) => item.topic === topic.value) : questions.value
})
const groups = computed(() =>
  topics
    .map((entry) => ({ ...entry, items: results.value.filter((item) => item.topic === entry.id) }))
    .filter((group) => group.items.length)
)
function pickTopic(id: string) {
  topic.value = id
  query.value = ''
}

const teamPhoto = homeImage('equipo-atencion-telefonica')
const whatsapp = computed(() => (terms.value.whatsappNumber ? `https://wa.me/${terms.value.whatsappNumber}` : ''))

useHead(() => ({
  script: [
    {
      key: 'faq-structured-data',
      type: 'application/ld+json',
      textContent: JSON.stringify(
        buildFaqPageJsonLd(questions.value.map((item) => ({ question: item.question, answer: item.answer })))
      ).replace(/</g, '\\u003c')
    }
  ]
}))
</script>

<template>
  <div data-help-centre>
    <!-- Cabecera: la pregunta y el buscador, lo primero -->
    <section class="bg-neteco-950 text-white">
      <div class="mx-auto max-w-[1600px] px-4 py-8 sm:px-6 sm:py-12">
        <div class="mx-auto max-w-3xl text-center">
          <h1 class="text-[28px] font-bold leading-tight text-white sm:text-4xl">¿En qué podemos ayudarte?</h1>
          <p class="mt-2 text-neteco-100">Busca tu duda o elige un tema. Si no la encuentras, te atendemos nosotros.</p>
          <form role="search" class="relative mt-6" @submit.prevent>
            <label for="help-search" class="sr-only">Buscar en la ayuda</label>
            <UIcon
              name="i-lucide-search"
              class="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-[var(--text-muted)]"
              aria-hidden="true"
            />
            <input
              id="help-search"
              v-model="query"
              type="search"
              autocomplete="off"
              maxlength="80"
              placeholder="Por ejemplo: factura, plazo de entrega, devolver…"
              class="h-14 w-full rounded-[var(--radius-panel)] border-0 bg-white pl-12 pr-4 text-base text-[var(--text-strong)] shadow-[var(--shadow-overlay)] placeholder:text-[var(--text-muted)]"
            />
          </form>
        </div>
      </div>
    </section>

    <div class="mx-auto max-w-[1600px] px-4 py-8 sm:px-6 sm:py-10">
      <!-- Gestiones más frecuentes -->
      <section aria-labelledby="help-quick">
        <h2 id="help-quick" class="text-xl font-bold text-[var(--text-strong)] sm:text-2xl">Lo más habitual</h2>
        <ul class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-6">
          <li v-for="item in quickLinks" :key="item.title" class="flex">
            <NuxtLink
              :to="item.to"
              class="group flex w-full flex-col items-start gap-3 rounded-[var(--radius-panel)] bg-[var(--surface)] p-4 transition-shadow hover:shadow-[var(--shadow-overlay)] sm:p-5"
            >
              <span class="grid size-11 place-items-center rounded-full bg-neteco-50 text-neteco-700">
                <UIcon :name="item.icon" class="size-5" aria-hidden="true" />
              </span>
              <span class="font-semibold leading-snug text-[var(--text-strong)] group-hover:text-[var(--link)]">
                {{ item.title }}
              </span>
            </NuxtLink>
          </li>
        </ul>
      </section>

      <div
        class="mt-10 grid items-start gap-8 lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[260px_minmax(0,1fr)_360px]"
      >
        <!-- Temas -->
        <nav aria-label="Temas de ayuda" class="lg:sticky lg:top-44">
          <h2 class="hidden text-sm font-semibold text-[var(--text-muted)] lg:block">Temas de ayuda</h2>
          <ul class="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 lg:mx-0 lg:mt-3 lg:flex-col lg:gap-1 lg:px-0">
            <li class="shrink-0">
              <button
                type="button"
                :aria-pressed="!topic && !searching"
                class="flex min-h-11 w-full items-center gap-3 whitespace-nowrap rounded-full border px-4 text-left text-[15px] font-medium transition-colors lg:rounded-[var(--radius-control)] lg:border-0 lg:px-3"
                :class="
                  !topic && !searching
                    ? 'border-[var(--action)] bg-neteco-50 text-neteco-800'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-sunken)] lg:bg-transparent'
                "
                @click="pickTopic('')"
              >
                <UIcon name="i-lucide-layout-grid" class="hidden size-5 lg:block" aria-hidden="true" />
                Todos los temas
              </button>
            </li>
            <li v-for="entry in topics" :key="entry.id" class="shrink-0">
              <button
                type="button"
                :aria-pressed="topic === entry.id && !searching"
                class="flex min-h-11 w-full items-center gap-3 whitespace-nowrap rounded-full border px-4 text-left text-[15px] font-medium transition-colors lg:rounded-[var(--radius-control)] lg:border-0 lg:px-3"
                :class="
                  topic === entry.id && !searching
                    ? 'border-[var(--action)] bg-neteco-50 text-neteco-800'
                    : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-sunken)] lg:bg-transparent'
                "
                @click="pickTopic(entry.id)"
              >
                <UIcon :name="entry.icon" class="hidden size-5 lg:block" aria-hidden="true" />
                {{ entry.label }}
              </button>
            </li>
          </ul>
        </nav>

        <!-- Preguntas frecuentes -->
        <section aria-labelledby="help-faq" class="min-w-0">
          <h2 id="help-faq" class="text-xl font-bold text-[var(--text-strong)] sm:text-2xl">
            {{ searching ? 'Resultados' : 'Preguntas frecuentes' }}
          </h2>
          <p aria-live="polite" class="mt-1 text-sm text-[var(--text-muted)]">
            <template v-if="searching"
              >{{ results.length }} respuesta{{ results.length === 1 ? '' : 's' }} para «{{ query.trim() }}»</template
            >
            <template v-else>Las dudas que más nos llegan, respondidas por el equipo.</template>
          </p>

          <div v-if="!results.length" class="mt-5 rounded-[var(--radius-panel)] bg-[var(--surface)] p-6 text-center">
            <UIcon name="i-lucide-search-x" class="mx-auto size-10 text-[var(--text-muted)]" aria-hidden="true" />
            <p class="mt-3 font-semibold text-[var(--text-strong)]">No hemos encontrado esa duda</p>
            <p class="mt-1 text-[var(--text)]">
              Prueba con otras palabras o <ContactAction link-class="font-semibold text-[var(--link)] underline" /> y te
              respondemos.
            </p>
            <button
              type="button"
              class="mt-4 inline-flex h-11 items-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-4 font-semibold text-[var(--text-strong)] hover:border-[var(--action)]"
              @click="query = ''"
            >
              Ver todas las preguntas
            </button>
          </div>

          <div v-for="group in groups" :key="group.id" class="mt-6">
            <h3
              class="flex items-center gap-2 font-sans text-base font-semibold tracking-normal text-[var(--text-strong)]"
            >
              <UIcon :name="group.icon" class="size-5 text-neteco-700" aria-hidden="true" />
              {{ group.label }}
            </h3>
            <div class="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius-panel)] bg-[var(--surface)]">
              <details
                v-for="item in group.items"
                :key="item.id"
                :open="searching"
                class="group/faq"
                data-help-question
              >
                <summary
                  class="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-[15px] font-semibold text-[var(--text-strong)] hover:text-[var(--link)] sm:px-5 sm:text-base [&::-webkit-details-marker]:hidden"
                >
                  {{ item.question }}
                  <UIcon
                    name="i-lucide-chevron-down"
                    class="size-5 shrink-0 text-[var(--text-muted)] transition-transform group-open/faq:rotate-180"
                    aria-hidden="true"
                  />
                </summary>
                <div class="px-4 pb-5 sm:px-5">
                  <p class="max-w-3xl text-[var(--text)]">{{ item.answer }}</p>
                  <NuxtLink
                    v-if="item.link"
                    :to="item.link.to"
                    class="mt-3 inline-flex items-center gap-1.5 font-semibold text-[var(--link)] underline-offset-4 hover:underline"
                  >
                    {{ item.link.label }} <UIcon name="i-lucide-arrow-right" class="size-4" aria-hidden="true" />
                  </NuxtLink>
                </div>
              </details>
            </div>
          </div>
        </section>

        <!-- Contacto: personas, no un asistente -->
        <aside
          aria-labelledby="help-contact"
          class="overflow-hidden rounded-[var(--radius-panel)] bg-[var(--surface)] lg:col-span-2 xl:sticky xl:top-44 xl:col-span-1"
        >
          <img
            v-if="teamPhoto"
            :src="teamPhoto.src"
            :alt="teamPhoto.alt"
            :width="teamPhoto.width"
            :height="teamPhoto.height"
            loading="lazy"
            class="h-40 w-full object-cover object-[50%_25%] sm:h-48 xl:h-44"
          />
          <div class="p-5">
            <h2 id="help-contact" class="text-xl font-bold text-[var(--text-strong)]">
              ¿Prefieres hablar con nosotros?
            </h2>
            <p class="mt-1 text-[var(--text)]">
              Te atiende el equipo de NETECO<template v-if="terms.supportHours">, {{ terms.supportHours }}</template
              >.
            </p>
            <ul class="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
              <li v-if="phone">
                <a
                  :href="phone.href"
                  class="flex min-h-14 items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border)] px-4 transition-colors hover:border-[var(--action)]"
                >
                  <UIcon name="i-lucide-phone" class="size-5 shrink-0 text-neteco-700" aria-hidden="true" />
                  <span class="min-w-0 leading-snug">
                    <span class="block text-[13px] text-[var(--text-muted)]">Llámanos</span>
                    <span class="tabular block font-semibold text-[var(--text-strong)]">{{ phone.display }}</span>
                  </span>
                </a>
              </li>
              <li v-if="whatsapp">
                <a
                  :href="whatsapp"
                  rel="noopener"
                  class="flex min-h-14 items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border)] px-4 transition-colors hover:border-[var(--action)]"
                >
                  <UIcon name="i-lucide-message-circle" class="size-5 shrink-0 text-neteco-700" aria-hidden="true" />
                  <span class="min-w-0 leading-snug">
                    <span class="block text-[13px] text-[var(--text-muted)]">WhatsApp</span>
                    <span class="block font-semibold text-[var(--text-strong)]">Escríbenos por WhatsApp</span>
                  </span>
                </a>
              </li>
              <li>
                <a
                  :href="`mailto:${email}`"
                  class="flex min-h-14 items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border)] px-4 transition-colors hover:border-[var(--action)]"
                >
                  <UIcon name="i-lucide-mail" class="size-5 shrink-0 text-neteco-700" aria-hidden="true" />
                  <span class="min-w-0 leading-snug">
                    <span class="block text-[13px] text-[var(--text-muted)]">Correo</span>
                    <span class="block truncate font-semibold text-[var(--text-strong)]">{{ email }}</span>
                  </span>
                </a>
              </li>
            </ul>
            <NuxtLink
              to="/contacto"
              class="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--action)] px-5 font-semibold text-white transition-colors hover:bg-[var(--action-hover)]"
            >
              Enviar una consulta <UIcon name="i-lucide-arrow-right" class="size-4" aria-hidden="true" />
            </NuxtLink>
            <p class="mt-3 text-[13px] text-[var(--text-muted)]">
              Si es sobre un pedido, ten a mano su número: lo encontrarás en el correo de confirmación.
            </p>
          </div>
        </aside>
        <section
          v-if="runtime.public.serverRuntime === 'cloudflare'"
          aria-labelledby="help-guides"
          class="min-w-0 lg:col-span-2 xl:col-span-3"
        >
          <h2 id="help-guides" class="mb-4 text-xl font-bold text-[var(--text-strong)]">Guías y documentación</h2>
          <SupportKnowledgePanel :runtime="runtime.public.serverRuntime" />
        </section>
      </div>
    </div>
  </div>
</template>
