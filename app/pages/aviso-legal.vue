<script setup lang="ts">
const { terms } = useCommercialTerms()

const sections = [
  { id: 'titular', title: 'Titular del sitio' },
  { id: 'objeto', title: 'Objeto y ámbito' },
  { id: 'uso', title: 'Condiciones de uso' },
  { id: 'propiedad-intelectual', title: 'Propiedad intelectual e industrial' },
  { id: 'responsabilidad', title: 'Responsabilidad' },
  { id: 'enlaces', title: 'Enlaces a otros sitios' },
  { id: 'ley-aplicable', title: 'Ley aplicable' }
]
</script>

<template>
  <LegalDocument path="/aviso-legal" :sections="sections">
    <template #intro>
      <p>
        Información general sobre quién está detrás de esta tienda online y en qué condiciones puedes usarla, conforme
        al artículo 10 de la Ley 34/2002, de servicios de la sociedad de la información y de comercio electrónico
        (LSSI-CE).
      </p>
    </template>

    <section id="titular">
      <h2>Titular del sitio</h2>
      <p>
        Este sitio web y la tienda online NETECO pertenecen a
        <LegalDatum :value="terms.companyLegalName" label="razón social">su titular</LegalDatum>, con estos datos de
        identificación y contacto:
      </p>
      <LegalIdentity />
    </section>

    <section id="objeto">
      <h2>Objeto y ámbito</h2>
      <p>
        El sitio ofrece información y venta a distancia de productos de limpieza profesional, higiene, celulosa, menaje
        y equipamiento, tanto a consumidores como a empresas y profesionales. La compra se rige por las
        <NuxtLink to="/condiciones-generales">condiciones generales de venta</NuxtLink>; el tratamiento de datos, por la
        <NuxtLink to="/privacidad">política de privacidad</NuxtLink>; y el uso de cookies, por la
        <NuxtLink to="/cookies">política de cookies</NuxtLink>.
      </p>
      <p>
        Navegar por el sitio es gratuito y no exige registrarse. Algunas funciones, como el pago aplazado o los precios
        pactados para empresas, requieren una cuenta.
      </p>
    </section>

    <section id="uso">
      <h2>Condiciones de uso</h2>
      <p>Al usar el sitio te comprometes a:</p>
      <ul>
        <li>Dar datos veraces y mantenerlos al día en tu cuenta y en tus pedidos.</li>
        <li>Guardar tu contraseña y avisarnos si crees que alguien la conoce.</li>
        <li>
          No usar el sitio para fines ilícitos, no intentar acceder a zonas restringidas y no introducir programas o
          automatismos que alteren su funcionamiento o sobrecarguen el servicio.
        </li>
        <li>
          Leer la ficha técnica y la ficha de datos de seguridad de los productos químicos antes de usarlos, y seguir
          sus indicaciones de dosificación y almacenamiento.
        </li>
      </ul>
      <p>
        Podemos suspender una cuenta que incumpla estas condiciones, avisando antes al titular salvo que la urgencia o
        la seguridad del servicio lo impidan.
      </p>
    </section>

    <section id="propiedad-intelectual">
      <h2>Propiedad intelectual e industrial</h2>
      <p>
        Los textos, el diseño, el código y los elementos gráficos propios del sitio pertenecen a su titular o se usan
        con licencia. Las marcas, fotografías y fichas de los fabricantes pertenecen a sus respectivos titulares y se
        muestran para identificar sus productos.
      </p>
      <p>
        Puedes consultar, imprimir y descargar el contenido para tu uso personal o para gestionar las compras de tu
        empresa. Cualquier otra reproducción, distribución o transformación necesita autorización previa por escrito.
      </p>
    </section>

    <section id="responsabilidad">
      <h2>Responsabilidad</h2>
      <p>
        Revisamos la información del catálogo, pero puede contener errores de transcripción. Si detectas uno, avísanos y
        lo corregiremos. Ningún error de este tipo te obliga a comprar: antes de confirmar el pedido ves el precio
        final, los gastos de envío y los impuestos.
      </p>
      <p>
        Trabajamos para que el sitio esté disponible y sea seguro, pero no podemos garantizar que no haya interrupciones
        por mantenimiento, fallos técnicos o causas ajenas. Nada de lo anterior limita los derechos que la ley reconoce
        a los consumidores.
      </p>
    </section>

    <section id="enlaces">
      <h2>Enlaces a otros sitios</h2>
      <p>
        Algunas páginas enlazan a sitios de terceros, como fabricantes u organismos públicos. No controlamos su
        contenido y no respondemos de él; si nos comunicas que un enlace lleva a contenido ilícito, lo retiraremos con
        diligencia, como prevé el artículo 17 de la LSSI-CE.
      </p>
    </section>

    <section id="ley-aplicable">
      <h2>Ley aplicable</h2>
      <p>
        Este aviso legal se rige por la ley española. Para las compras y para las reclamaciones de consumidores se
        aplica lo previsto en las
        <NuxtLink to="/condiciones-generales#litigios">condiciones generales de venta</NuxtLink>.
      </p>
    </section>
  </LegalDocument>
</template>
