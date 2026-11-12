<script setup lang="ts">
const runtime = useRuntimeConfig()
const { terms, email, ownDelivery, parcel, deferredPayment } = useCommercialTerms()
const bankTransfer = computed(() => runtime.public.bankTransferEnabled === true)
const isProduction = runtime.public.appEnv === 'production'

const sections = [
  { id: 'vendedor', title: 'Vendedor' },
  { id: 'ambito', title: 'Ámbito y aceptación' },
  { id: 'compra', title: 'Proceso de compra' },
  { id: 'precios', title: 'Precios e IVA' },
  { id: 'pago', title: 'Formas de pago' },
  { id: 'envio', title: 'Envío y plazos' },
  { id: 'desistimiento', title: 'Desistimiento de 14 días' },
  { id: 'excepciones', title: 'Productos sin desistimiento' },
  { id: 'formulario-desistimiento', title: 'Formulario de desistimiento' },
  { id: 'garantia', title: 'Garantía legal' },
  { id: 'uso-seguro', title: 'Uso seguro de los productos' },
  { id: 'profesionales', title: 'Clientes profesionales' },
  { id: 'litigios', title: 'Ley aplicable y reclamaciones' }
]
</script>

<template>
  <LegalDocument path="/condiciones-generales" :sections="sections">
    <template #intro>
      <p>
        Condiciones que se aplican a las compras en la tienda online NETECO. Las aceptas al confirmar cada pedido y
        puedes guardarlas o imprimirlas desde esta página. Distinguimos entre consumidores, que compran para uso
        personal, y clientes profesionales, que compran para su empresa o actividad.
      </p>
    </template>

    <section id="vendedor">
      <h2>Vendedor</h2>
      <p>
        Vende
        <LegalDatum :value="terms.companyLegalName" label="razón social">el titular de la tienda</LegalDatum>, con estos
        datos:
      </p>
      <LegalIdentity />
    </section>

    <section id="ambito">
      <h2>Ámbito y aceptación</h2>
      <p>
        Estas condiciones se rigen por el Real Decreto Legislativo 1/2007, texto refundido de la Ley General para la
        Defensa de los Consumidores y Usuarios (TRLGDCU), y por la Ley 34/2002 (LSSI-CE). Las partes que solo afectan a
        consumidores se indican como tales; las que solo afectan a empresas y profesionales están en
        <a href="#profesionales">Clientes profesionales</a>.
      </p>
      <p>
        El contrato se celebra en español. Se aplica la versión de estas condiciones vigente en el momento de confirmar
        el pedido; si las cambiamos, el cambio no afecta a los pedidos ya confirmados.
      </p>
    </section>

    <section id="compra">
      <h2>Proceso de compra</h2>
      <ol>
        <li>Añade los productos al carrito. Puedes cambiar cantidades o quitarlos en cualquier momento.</li>
        <li>
          En la página de finalizar compra, indica tus datos de contacto, la dirección de entrega y, si la necesitas, la
          de facturación.
        </li>
        <li>Elige el modo de envío y la forma de pago. El resumen muestra el precio final con impuestos y portes.</li>
        <li>
          Revisa el resumen: es el momento de corregir cualquier error en los datos. Después acepta estas condiciones y
          confirma el pedido con el botón final, que implica la obligación de pagar.
        </li>
      </ol>
      <p>
        Al confirmar te enviamos un correo con el resumen del pedido, que sirve de confirmación del contrato. El pedido
        queda archivado y, si tienes cuenta, puedes consultarlo en Mi cuenta junto con su factura.
      </p>
      <p>
        Si después de confirmar no podemos servir un producto, por ejemplo por falta de existencias, te avisamos cuanto
        antes y te devolvemos lo que hayas pagado por él sin demora.
      </p>
    </section>

    <section id="precios">
      <h2>Precios e IVA</h2>
      <p>
        Los precios están en euros. Para consumidores se muestran con el IVA incluido. Si tienes cuenta de empresa,
        puedes ver los precios sin IVA; en ese caso el IVA se suma y se desglosa antes de confirmar y en la factura.
      </p>
      <p>
        Los gastos de envío y cualquier otro cargo se muestran antes de confirmar el pedido; no pagarás nada que no
        hayas visto en el resumen. Emitimos factura de cada pedido con el IVA desglosado.
      </p>
      <p>
        Si un precio publicado contiene un error evidente, te avisaremos antes de enviar el pedido para que decidas si
        lo mantienes con el precio correcto o lo anulas sin coste.
      </p>
    </section>

    <section id="pago">
      <h2>Formas de pago</h2>
      <ul>
        <li>
          <strong>Tarjeta y Bizum</strong>, a través de la pasarela de pago segura de la entidad bancaria. No vemos ni
          guardamos los datos completos de tu tarjeta.
        </li>
        <li v-if="bankTransfer">
          <strong>Transferencia bancaria</strong>. Te damos los datos al confirmar y preparamos el pedido cuando
          recibimos el importe.
        </li>
        <li v-if="deferredPayment">
          <strong>Pago aplazado para empresas</strong>. {{ deferredPayment
          }}<template v-if="terms.deferredPaymentConditions"> {{ terms.deferredPaymentConditions }}</template>
        </li>
      </ul>
      <p>Más detalle en <NuxtLink to="/formas-de-pago">Formas de pago</NuxtLink>.</p>
    </section>

    <section id="envio">
      <h2>Envío y plazos</h2>
      <ul>
        <li>{{ ownDelivery.text }}</li>
        <li v-if="parcel">{{ parcel.text }}</li>
      </ul>
      <p>
        El plazo y el coste de tu pedido se muestran antes de confirmarlo. Si no se indica otro, entregamos en un máximo
        de 30 días naturales desde la confirmación (art. 66 bis TRLGDCU). Si no podemos cumplir el plazo te avisamos, y
        si tampoco cumplimos el plazo adicional que nos des, puedes anular el pedido y te devolvemos lo pagado.
      </p>
      <p>
        El producto viaja por nuestra cuenta y riesgo hasta que tú, o la persona que indiques, lo recibe. Al recibirlo,
        comprueba el número de bultos y su estado, anota cualquier daño visible en el albarán del transportista y
        avísanos lo antes posible para gestionarlo.
      </p>
      <p>
        Algunos productos químicos se transportan como mercancía peligrosa y pueden tener restricciones de envío, que
        indicamos en su ficha. Más información en <NuxtLink to="/envios">Envíos y reparto</NuxtLink>.
      </p>
    </section>

    <section id="desistimiento">
      <h2>Desistimiento de 14 días</h2>
      <p>
        Si eres consumidor, puedes desistir del contrato sin dar ninguna razón en un plazo de
        <strong>14 días naturales</strong> desde el día en que tú, o un tercero que indiques distinto del transportista,
        recibís el producto. Si un pedido llega en varias entregas, el plazo cuenta desde la última.
      </p>
      <h3>Cómo ejercerlo</h3>
      <p>
        Comunícanoslo antes de que termine el plazo con una declaración clara, por ejemplo un correo a
        <a :href="`mailto:${email}`">{{ email }}</a> o la solicitud de
        <NuxtLink to="/devoluciones">Devoluciones</NuxtLink>. Puedes usar el
        <a href="#formulario-desistimiento">formulario de desistimiento</a>, aunque no es obligatorio. Te confirmaremos
        la recepción sin demora.
      </p>
      <h3>Devolución del producto</h3>
      <p>
        Devuelve el producto sin demora y, como máximo, en 14 días naturales desde que nos comunicas el desistimiento.
        Salvo que te indiquemos otra cosa, el coste directo de la devolución corre de tu cuenta. Los productos químicos
        clasificados como mercancía peligrosa no se pueden enviar por cualquier medio: antes de moverlos, te indicamos
        cómo devolverlos con seguridad.
      </p>
      <p>
        Puedes abrir el embalaje y examinar el producto como lo harías en una tienda. Solo respondes de la pérdida de
        valor que resulte de una manipulación distinta de la necesaria para comprobar su naturaleza, características y
        funcionamiento.
      </p>
      <h3>Reembolso</h3>
      <p>
        Te devolvemos todos los pagos recibidos, incluidos los gastos de envío ordinarios, en un máximo de 14 días
        naturales desde que nos comunicas el desistimiento, por el mismo medio de pago que usaste salvo que acordemos
        otro sin coste para ti. Podemos esperar a recibir el producto, o a que nos acredites que lo has enviado, antes
        de reembolsar. Si elegiste un envío más caro que el ordinario, el sobrecoste no se reembolsa.
      </p>
    </section>

    <section id="excepciones">
      <h2>Productos sin derecho de desistimiento</h2>
      <p>Según el artículo 103 del TRLGDCU, no se puede desistir de:</p>
      <ul>
        <li>
          <strong
            >Productos precintados que no son aptos para devolverse por razones de protección de la salud o de higiene y
            que se han desprecintado tras la entrega</strong
          >: por ejemplo, productos químicos de limpieza, desinfectantes, jabones, geles y productos de higiene personal
          cuyo precinto, tapón de seguridad o envase sellado se haya abierto.
        </li>
        <li>
          Productos que, tras la entrega, se han <strong>mezclado de forma inseparable</strong> con otros, como un
          concentrado ya diluido o trasvasado.
        </li>
        <li>Productos que <strong>pueden deteriorarse o caducar con rapidez</strong>.</li>
        <li>
          Productos <strong>fabricados según tus especificaciones o personalizados</strong>, por ejemplo con tu
          logotipo.
        </li>
      </ul>
      <p>
        Los productos químicos y de higiene que conservan su precinto intacto sí pueden devolverse dentro del plazo. Las
        excepciones no afectan a la garantía: si un producto llega defectuoso o no es el que pediste, se aplica la
        <a href="#garantia">garantía legal</a> aunque esté abierto.
      </p>
    </section>

    <section id="formulario-desistimiento">
      <h2>Formulario de desistimiento</h2>
      <p>Modelo del anexo B del TRLGDCU. Solo tienes que completarlo y enviárnoslo si quieres desistir del contrato.</p>
      <div class="legal-form" data-withdrawal-form>
        <p>
          A la atención de
          <LegalDatum :value="terms.companyLegalName" label="razón social">el titular de la tienda</LegalDatum>,
          <LegalDatum :value="terms.companyAddress" label="domicilio" /><template
            v-if="terms.companyAddress || !isProduction"
            >, </template
          >{{ email }}:
        </p>
        <p>
          Por la presente le comunico/comunicamos (*) que desisto de mi/desistimos de nuestro (*) contrato de venta del
          siguiente bien/prestación del siguiente servicio (*):
        </p>
        <ul>
          <li>Pedido el/recibido el (*):</li>
          <li>Número de pedido:</li>
          <li>Nombre del consumidor o de los consumidores:</li>
          <li>Domicilio del consumidor o de los consumidores:</li>
          <li>Firma del consumidor o de los consumidores (solo si el presente formulario se presenta en papel):</li>
          <li>Fecha:</li>
        </ul>
        <p>(*) Táchese lo que no proceda.</p>
      </div>
    </section>

    <section id="garantia">
      <h2>Garantía legal de conformidad</h2>
      <p>
        Si eres consumidor, respondemos de cualquier falta de conformidad que exista en el momento de la entrega y se
        manifieste en un plazo de <strong>tres años</strong> desde ella (art. 120 TRLGDCU). Si el defecto aparece en los
        dos primeros años, se presume que ya existía al entregar el producto, salvo prueba en contrario.
      </p>
      <p>
        Puedes elegir entre la reparación o la sustitución del producto, salvo que una de ellas sea imposible o
        desproporcionada. Si no son posibles o no se hacen en un plazo razonable, puedes pedir una rebaja del precio o,
        si el defecto no es de escasa importancia, resolver el contrato. Todo ello es gratuito para ti, incluidos los
        portes.
      </p>
      <p>
        En los productos con fecha de caducidad, la conformidad se valora conforme a esa fecha. La garantía no cubre los
        daños causados por un uso o almacenamiento contrario a la etiqueta o a la ficha técnica. La garantía comercial
        que ofrezca un fabricante se suma a la legal y no la sustituye.
      </p>
      <p>
        Para usarla, <ContactAction /> con el número de pedido y, si puedes, una foto del problema, o abre la solicitud
        en <NuxtLink to="/devoluciones">Devoluciones</NuxtLink>.
      </p>
    </section>

    <section id="uso-seguro">
      <h2>Uso seguro de los productos</h2>
      <p>
        Usa los productos de limpieza y desinfección siguiendo su etiqueta y, en el caso de los profesionales, su ficha
        de datos de seguridad. Si necesitas una ficha técnica o de seguridad que no aparece en la página del producto,
        pídenosla y te la enviamos. Guarda los productos en su envase original, fuera del alcance de los niños y sin
        mezclarlos con otros.
      </p>
    </section>

    <section id="profesionales">
      <h2>Clientes profesionales</h2>
      <p>
        Si compras para tu empresa o actividad profesional, se aplica todo lo anterior con estas diferencias, salvo que
        hayamos pactado condiciones particulares por escrito, que prevalecen:
      </p>
      <ul>
        <li>
          <strong>Sin desistimiento</strong>: el derecho de desistimiento es exclusivo de los consumidores. Aceptamos
          devoluciones de producto sin abrir solo si las autorizamos antes; te diremos cómo y en qué condiciones.
        </li>
        <li>
          <strong>Revisión a la entrega</strong>: comprueba la mercancía al recibirla. Los defectos de cantidad o
          calidad en mercancía embalada deben comunicarse en los 4 días siguientes a la recepción, y los vicios internos
          en los 30 días siguientes a la entrega (arts. 336 y 342 del Código de Comercio).
        </li>
        <li>
          <strong>Precios</strong>: pueden mostrarse sin IVA; el IVA y los demás impuestos aplicables se suman en el
          pedido y en la factura.
        </li>
        <li>
          <strong>Pago aplazado</strong>: solo con cuenta de empresa aprobada<template v-if="deferredPayment"
            >, en las condiciones indicadas en <a href="#pago">Formas de pago</a></template
          >, y dentro del plazo máximo de la Ley 3/2004 de lucha contra la morosidad. Los retrasos devengan el interés
          de demora y la indemnización por costes de cobro que fija esa ley.
        </li>
        <li>
          <strong>Responsabilidad</strong>: salvo dolo o culpa grave, nuestra responsabilidad se limita al importe del
          pedido afectado y no incluye el lucro cesante ni los daños indirectos.
        </li>
        <li>
          <strong>Jurisdicción</strong>: las partes se someten a los juzgados y tribunales del domicilio del vendedor.
        </li>
      </ul>
    </section>

    <section id="litigios">
      <h2>Ley aplicable y reclamaciones</h2>
      <p>
        Estas condiciones se rigen por la ley española. Si eres consumidor, conservas la protección que te dé la ley de
        tu país de residencia, y puedes reclamar ante los juzgados de tu domicilio.
      </p>
      <p>
        Si tienes una queja, cuéntanosla primero en <a :href="`mailto:${email}`">{{ email }}</a
        >; respondemos lo antes posible y siempre dentro del plazo legal. Tienes a tu disposición hojas oficiales de
        reclamaciones: pídelas por el mismo correo.
      </p>
      <p v-if="terms.disputeResolutionEntity || !isProduction">
        Entidad de resolución alternativa de litigios a la que estamos adheridos:
        <LegalDatum :value="terms.disputeResolutionEntity" label="entidad de resolución de litigios" />.
      </p>
      <p>
        Si no llegamos a un acuerdo, puedes acudir a la oficina municipal de información al consumidor o a la Junta
        Arbitral de Consumo de tu comunidad autónoma.
      </p>
      <p>
        La plataforma europea de resolución de litigios en línea (ODR) dejó de funcionar el 20 de julio de 2025, cuando
        el Reglamento (UE) 2024/3228 derogó el Reglamento (UE) 524/2013, y por eso no la enlazamos. Para una reclamación
        con una empresa de otro país de la Unión, puedes pedir ayuda al
        <a href="https://portal-cec.consumo.gob.es" target="_blank" rel="noopener"
          >Centro Europeo del Consumidor en España</a
        >.
      </p>
    </section>
  </LegalDocument>
</template>
