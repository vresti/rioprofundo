/**
 * ============================================================================
 *  RÍO PROFUNDO — Cloudflare Worker (cache de borde de DOS CAPAS + SWR + cron)
 *
 *  Tres rutas de LECTURA, cada una con su cache y su TTL:
 *    - /            o /?d=marea     -> tablero de marea      (TTL corto, 5 min)
 *    - /?d=utiles                   -> ayudas náuticas        (TTL largo, 6 h)
 *    - /?d=combustibles             -> precios de combustible (TTL del día, 12 h)
 *
 *  DOS CAPAS DE CACHE:
 *    1) caches.default  -> POR COLO, rapidísimo, pero EVICTABLE. Es el camino
 *       feliz: HIT en milisegundos, y stale-while-revalidate cuando vence.
 *    2) KV (env.RP_KV)  -> GLOBAL y DURABLE (no se evicta). Es la RED que tapa
 *       el agujero viejo: cuando un colo está frío (caches.default sin copia),
 *       en vez de esperar 5 s al GAS, leemos KV en ms y servimos al instante
 *       (HIT-KV / STALE-KV), y revalidamos por detrás. El visitante casi nunca
 *       toca el GAS.
 *
 *  CRON (scheduled): precalienta KV en forma global cada pocos minutos, de modo
 *  que el GAS lo golpea el cron —no la gente— y todos los colos leen KV fresco.
 *
 *  DEGRADACIÓN: si el GAS falla, queda la copia vieja (borde o KV) y se sigue
 *  sirviendo. Si KV no está vinculado (env.RP_KV ausente), el Worker funciona
 *  igual que antes (solo caches.default + GAS).
 *
 *  ---------------------------------------------------------------------------
 *  SUSCRIPCIONES (20/07/2026) — rutas nuevas, POR PATH, aisladas de lo de arriba
 *  ---------------------------------------------------------------------------
 *  Fase 1: alta gratis por mail. El cobro NO existe todavía; el teléfono se pide
 *  OBLIGATORIO y se guarda INACTIVO para el día que WhatsApp sea el producto pago.
 *
 *  MAIL Y TELÉFONO SE VALIDAN CON UN SOLO CLICK: el mail de confirmación dice
 *  explícitamente qué número se está confirmando, y al clickear se dan por buenos
 *  los dos + el disclaimer. NO se manda ningún WhatsApp en el alta.
 *
 *  ⚠️ EL TELÉFONO QUEDA ATESTIGUADO, NO VERIFICADO. El mail sí está probado (el
 *  tipo clickeó en su casilla); del número sólo sabemos que lo declaró alguien
 *  con esa casilla y aceptó el disclaimer. Un dígito mal no se detecta acá.
 *  DÓNDE MUERDE: el día que se prenda WhatsApp, el primer mensaje iría a un
 *  número no probado -> le llega a un desconocido y el reporte se lo come NUESTRO
 *  número. POR ESO la verificación del teléfono va EN EL UPGRADE (cuando paga y
 *  activa WhatsApp, el 1er mensaje es "confirmá que sos vos"): ahí la persona
 *  espera el mensaje, la fricción es cero y ningún número recibe nada sin probar.
 *  `normalizarTel_` acá abajo ataja la clase de error más común (formato AR).
 *
 *    POST /suscribir   {email, nombre, telefono?}  -> encola un alta
 *    GET  /confirmar?t=TOKEN                       -> encola la confirmación
 *    GET  /baja?t=TOKEN                            -> encola la baja (1 click)
 *    POST /baja                {email}             -> encola PEDIDO de baja
 *    GET  /pendientes?k=SECRETO                    -> GAS lee la cola
 *    POST /ack?k=SECRETO       {keys:[...]}        -> GAS borra lo procesado
 *
 *  POR QUÉ UNA COLA EN KV Y NO UN POST DIRECTO AL GAS:
 *   1) Un `doPost` en Alerta obligaría a "Nueva versión" de la implementación
 *      ACTIVA — la maniobra que congeló la web 16 h el 19/07. Por acá, el lado
 *      GAS es una función que corre POR TRIGGER: pegar y guardar, sin deploy.
 *   2) Si el GAS está caído, las altas se encolan en vez de perderse.
 *   Es el mismo patrón cola+drenaje del Chat WS Hub, que ya está en producción.
 *
 *  EL WORKER NO MANDA MAILS ni conoce la identidad de nadie: sólo encola hechos.
 *  El token lo genera GAS (que es el dueño de la hoja `Contactos`); acá sólo se
 *  registra que alguien lo clickeó. Así el secreto de la lista nunca sale de GAS.
 *
 *  SECRETO: `RP_SUB_SECRET` (Worker secret, NO variable de texto plano). Si no
 *  está, /pendientes y /ack responden 503 — falla CERRADO a propósito.
 * ============================================================================
 */

// Endpoint /exec de AlertaSudestada (la implementación ACTIVA, la que se mantiene).
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxIz24SiqcaG_svSWWciB77AngYxABuYxB3VU9wcsmssA5M7trk0eJsgLDhmO6exq0y/exec';

// Rutas permitidas (LISTA BLANCA). Cualquier otro ?d= cae en 'marea'.
//   min      -> minutos de frescura (bajo ese umbral es HIT; encima, stale)
//   cacheKey -> clave en caches.default (borde por-colo)
//   kv       -> clave en KV (global durable)
const RUTAS = {
  marea:        { min: 5,   cacheKey: 'https://rioprofundo.cache/marea-v1',        kv: 'marea' },
  utiles:       { min: 360, cacheKey: 'https://rioprofundo.cache/utiles-v1',       kv: 'utiles' },        // 6 h
  combustibles: { min: 720, cacheKey: 'https://rioprofundo.cache/combustibles-v1', kv: 'combustibles' }  // 12 h (el GAS baja 1 vez/día)
};

// Origen permitido para el form. La web es GitHub Pages en rioprofundo.com y el
// Worker vive en workers.dev -> es CROSS-ORIGIN. Las lecturas siguen con '*'
// (son públicas); las escrituras se acotan a la web propia.
const ORIGENES_OK = ['https://rioprofundo.com', 'https://www.rioprofundo.com'];

// Tope de altas por IP por hora. No es seguridad seria, es anti-tonteras.
const ALTAS_POR_IP_HORA = 5;

// Versión de los términos aceptados en el alta. Se guarda con cada suscriptor:
// si el texto cambia (y va a cambiar cuando exista el pago), queda registro de
// QUÉ aceptó cada uno. Subirla cada vez que se toque el texto del disclaimer.
const DISCLAIMER_V = '2026-07-20';

async function manejar(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // ---- DESPACHO POR PATH (suscripciones) -----------------------------------
  // Va ANTES de todo lo demás: estas rutas no tocan el cache del tablero.
  if (path !== '/') {
    if (request.method === 'OPTIONS') return preflight(request);
    switch (path) {
      case '/suscribir':  return request.method === 'POST' ? altaSuscripcion(request, env) : metodoNo();
      case '/confirmar':  return request.method === 'GET'  ? confirmarAlta(request, env)   : metodoNo();
      case '/baja':       return request.method === 'GET'  ? bajaPorToken(request, env)
                               : request.method === 'POST' ? bajaPorMail(request, env)     : metodoNo();
      case '/pendientes': return request.method === 'GET'  ? leerCola(request, env)        : metodoNo();
      case '/hay':        return request.method === 'GET'  ? avisoCola(request, env)       : metodoNo();
      case '/ack':        return request.method === 'POST' ? borrarCola(request, env)      : metodoNo();
      // --- ÁREA DE CLIENTES (21/07/2026) ---
      case '/espejo':     return request.method === 'POST' ? recibirEspejo(request, env)
                               : request.method === 'GET'  ? mirarEspejo(request, env)     : metodoNo();
      case '/entrar':     return request.method === 'POST' ? pedirCodigo(request, env)     : metodoNo();
      case '/sesion':     return request.method === 'POST' ? abrirSesion(request, env)     : metodoNo();
      case '/cuenta':     return request.method === 'POST' ? verCuenta(request, env)       : metodoNo();
      // --- ACTIVACIÓN DE WHATSAPP (22/07/2026) ---
      case '/activar':    return request.method === 'POST' ? pedirActivacion(request, env) : metodoNo();
      default:            return json({ error: true, msg: 'No encontrado' }, 404);
    }
  }

  // ---- A PARTIR DE ACÁ, EL TABLERO (intacto) -------------------------------
  if (request.method !== 'GET') {
    return json({ error: true, msg: 'Method not allowed' }, 405);
  }

  // Resolver ruta desde ?d= con lista blanca. Lo que no esté en RUTAS cae en 'marea'.
  const pedido = url.searchParams.get('d') || 'marea';
  const d = RUTAS[pedido] ? pedido : 'marea';
  const cfg = RUTAS[d];
  const kv = (env && env.RP_KV) ? env.RP_KV : null;

  const cache = caches.default;
  const cacheReq = new Request(cfg.cacheKey);
  const cached = await cache.match(cacheReq);

  // ---- CAPA 1: cache de borde (por-colo, el camino más rápido) --------------
  if (cached) {
    const guardado = Number(cached.headers.get('x-guardado') || '0');
    const edadSeg = (Date.now() - guardado) / 1000;

    // 1a) Copia FRESCA -> servir ya
    if (edadSeg < cfg.min * 60) {
      return conCORS(cached, 'HIT');
    }

    // 1b) Copia VENCIDA -> servirla IGUAL al instante (SWR) y refrescar por detrás
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(refrescar_(d, cfg, cache, cacheReq, kv).catch(function () {}));
      return conCORS(cached, 'STALE-REVAL');
    }
  }

  // ---- CAPA 2: KV global (durable) — tapa el colo frío ----------------------
  // El borde no tenía copia. Antes de ir al GAS (lento), probamos KV: si hay algo,
  // lo servimos al instante y, si hace falta, revalidamos por detrás.
  if (kv) {
    try {
      const g = await kv.getWithMetadata(cfg.kv);
      if (g && g.value) {
        const guardado = Number((g.metadata && g.metadata.guardado) || 0);
        const edadSeg = (Date.now() - guardado) / 1000;
        const resp = armarResp(g.value, guardado || Date.now(), cfg);

        // rellenar el borde de este colo para los próximos hits (barato, por detrás)
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(cache.put(cacheReq, resp.clone()).catch(function () {}));
        }

        if (edadSeg < cfg.min * 60) {
          return conCORS(resp, 'HIT-KV');           // KV fresco: no hace falta el GAS
        }
        // KV vencido: servir igual y revalidar contra el GAS por detrás
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(refrescar_(d, cfg, cache, cacheReq, kv).catch(function () {}));
        }
        return conCORS(resp, 'STALE-KV');
      }
    } catch (e) { /* KV falló: seguimos al GAS */ }
  }

  // ---- CAPA 3: ni borde ni KV -> pedir al GAS y esperar (primera vez; raro) --
  try {
    const paraCache = await refrescar_(d, cfg, cache, cacheReq, kv);
    return conCORS(paraCache, cached ? 'STALE-MISS' : 'MISS');
  } catch (err) {
    if (cached) return conCORS(cached, 'STALE');
    return json({ error: true, msg: 'No disponible', detalle: String((err && err.message) || err) }, 503);
  }
}

/**
 * refrescar_ — va al GAS, valida el JSON y guarda la copia nueva EN LAS DOS CAPAS
 * (borde + KV). Devuelve la Response lista para servir. Si el GAS falla, lanza
 * (el caller decide si sirve la copia vieja). Se usa en primer plano (MISS), en
 * segundo plano (waitUntil) y en el cron.
 *
 * VALIDACIÓN: además de ok:true, en la ruta 'marea' exige que venga el `presente`
 * con valor. Si el GAS responde ok pero con presente:null (p.ej. un deploy a medio
 * camino), NO se cachea ni se sirve como bueno: se lanza, y queda la copia vieja
 * buena (si la hay). Así nunca se cachea —ni en borde ni en KV— un null.
 */
async function refrescar_(d, cfg, cache, cacheReq, kv) {
  const gasUrl = GAS_URL + (d === 'marea' ? '' : '?d=' + d);
  const upstream = await fetch(gasUrl, { method: 'GET', redirect: 'follow' });
  if (!upstream.ok) throw new Error('GAS HTTP ' + upstream.status);
  const texto = await upstream.text();

  let parsed;
  try { parsed = JSON.parse(texto); } catch (e) { throw new Error('GAS no devolvió JSON'); }
  if (!parsed || parsed.error || !parsed.ok) throw new Error('GAS devolvió error');

  // Guardia específica de 'marea': no aceptar un tablero sin presente con valor.
  if (d === 'marea' && (!parsed.presente || parsed.presente.valor == null)) {
    throw new Error('marea sin presente (no se cachea)');
  }

  const ahora = Date.now();
  const paraCache = armarResp(texto, ahora, cfg);

  // Capa 1: borde por-colo
  await cache.put(cacheReq, paraCache.clone());

  // Capa 2: KV global durable. TTL generoso (2 días) para que sobreviva aunque
  // nadie visite; se sobreescribe en cada refresco. El timestamp va en metadata.
  if (kv) {
    try {
      await kv.put(cfg.kv, texto, { metadata: { guardado: ahora }, expirationTtl: 172800 });
    } catch (e) { /* si KV falla, igual servimos desde el borde */ }
  }

  return paraCache;
}

/**
 * precalentar — corre por CRON (scheduled). Refresca en KV (global) las rutas
 * cuya copia está por vencer, para que ningún visitante tenga que ir al GAS.
 * Umbral 0.8·TTL: marea (5 min) se refresca casi siempre; utiles/combustibles
 * (6 h / 12 h) casi nunca, así no golpeamos al GAS de más.
 */
async function precalentar(env, ctx) {
  const cache = caches.default;
  const kv = (env && env.RP_KV) ? env.RP_KV : null;

  const tareas = Object.keys(RUTAS).map(async function (d) {
    const cfg = RUTAS[d];
    if (kv) {
      try {
        const g = await kv.getWithMetadata(cfg.kv);
        if (g && g.value) {
          const guardado = Number((g.metadata && g.metadata.guardado) || 0);
          const edadSeg = (Date.now() - guardado) / 1000;
          if (edadSeg < cfg.min * 60 * 0.8) return;   // todavía fresca -> no tocar el GAS
        }
      } catch (e) { /* si no se puede leer KV, refrescamos igual */ }
    }
    const cacheReq = new Request(cfg.cacheKey);
    await refrescar_(d, cfg, cache, cacheReq, kv).catch(function () {});
  });

  await Promise.all(tareas);
}

// ===========================================================================
//  SUSCRIPCIONES — la cola
//
//  Un ítem de cola es una clave KV `q:<ts>:<uuid>` con un JSON adentro:
//    { tipo, ts, ...datos }   tipo = alta | confirm | baja | bajareq
//  GAS la lee por /pendientes, la procesa, y borra por /ack. TTL de 14 días:
//  si GAS estuviera muerto dos semanas, la cola se limpia sola en vez de crecer
//  para siempre.
// ===========================================================================

const COLA_TTL_SEG = 14 * 24 * 3600;

/**
 * Encola un hecho. El dato va DOS VECES: en el valor y en la metadata.
 *
 * ¿Por qué duplicarlo? Porque `kv.list()` devuelve la metadata junto con las
 * claves, así que la cola entera se lee con UNA llamada y CERO `get`. Sin esto
 * había que hacer un `kv.get()` por ítem: con la cola vacía no se nota nunca,
 * pero 80 altas de golpe = 80 lecturas secuenciales, y el Worker se queda sin
 * CPU justo el día que el sistema funciona. El valor queda como respaldo por si
 * algún ítem excede el límite de 1 KB de metadata.
 */
async function encolar_(kv, tipo, datos) {
  const clave = 'q:' + Date.now() + ':' + crypto.randomUUID();
  const obj = Object.assign({ tipo: tipo, ts: Date.now() }, datos);
  const cuerpo = JSON.stringify(obj);
  // Metadata topea en 1024 bytes. Un alta ronda los 150; si algo se pasa,
  // guardamos sólo el tipo y el lector cae al `get` para ese ítem.
  const meta = cuerpo.length < 900 ? obj : { tipo: tipo, grande: true };
  await kv.put(clave, cuerpo, { metadata: meta, expirationTtl: COLA_TTL_SEG });
  // BANDERA — ver `avisoCola` más abajo. Una escritura más por alta (son pocas
  // por semana) a cambio de que GAS no tenga que listar cuando no hay nada.
  await kv.put(BANDERA, String(Date.now()));
  return clave;
}

/**
 * ⚠️⚠️ POR QUÉ EXISTE ESTA BANDERA — EL BUG DEL 21/07/2026, QUE VENÍA DE ANTES.
 *
 * KV cobra `list()` aparte y **el plan gratuito da 1000 por día**. `leerCola`
 * hace UN list por llamada, y `drenarSuscripciones` corre CADA MINUTO:
 *
 *      1440 list/día  contra un tope de 1000.
 *
 * O sea que todos los días, pasadas unas ~16 h, la cola dejaba de poder leerse
 * hasta la medianoche UTC — y como `susLeerCola_` recibe el error y devuelve
 * vacío, **el drenaje no procesaba nada y no se quejaba**. Estuvo así desde que
 * la suscripción salió a producción (20/07); no se notó porque no hubo altas
 * reales. Lo destapó el login del área de clientes, que se encolaba bien (un
 * `put`) pero nunca se drenaba.
 *
 * LA SALIDA: un `read` cuesta ~100 veces menos que un `list` (100.000/día contra
 * 1000). El Worker marca esta bandera al encolar; GAS la lee barato cada minuto
 * y **sólo lista si algo cambió**. Idle = cero list.
 *
 * ⚠️ La bandera es una PISTA, no la verdad. Si se desincroniza, los ítems
 * quedarían varados en silencio — por eso GAS lista igual cada 15 min como red
 * de seguridad (96/día). No sacar esa red.
 */
const BANDERA = 'q:flag';

/** GET /hay?k=SECRETO — ¿hay algo nuevo encolado? Un `get`, sin `list`. */
async function avisoCola(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  if (!autorizado_(request, env)) return json({ ok: false, msg: 'No autorizado' }, 401);
  if (!kv) return json({ ok: false, msg: 'KV no disponible' }, 503);
  const v = await kv.get(BANDERA);
  return json({ ok: true, flag: v || '' });
}

/**
 * POST /suscribir — el alta. Valida, limita por IP y encola. NO escribe en la
 * hoja ni manda mail: eso lo hace GAS al drenar (es el dueño de `Contactos`).
 *
 * Responde SIEMPRE el mismo ok:true si el mail es válido, exista o no en la
 * lista: si no, esto sería un oráculo para averiguar quién está suscripto.
 */
async function altaSuscripcion(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  if (!kv) return jsonCORS(request, { ok: false, msg: 'Suscripciones no disponibles' }, 503);

  let body;
  try { body = await leerCuerpo_(request); }
  catch (e) { return jsonCORS(request, { ok: false, msg: 'Cuerpo inválido' }, 400); }

  // Honeypot: un campo oculto que un humano nunca completa. Si viene lleno,
  // contestamos ok (que el bot crea que ganó) y no encolamos nada.
  if (String(body.web || '').trim() !== '') {
    return jsonCORS(request, { ok: true, msg: 'Listo' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!emailValido_(email)) {
    return jsonCORS(request, { ok: false, msg: 'Ese mail no parece válido' }, 400);
  }

  const nombre = String(body.nombre || '').trim().slice(0, 80);

  // Teléfono OBLIGATORIO. Se guarda pero NO se usa hasta el upgrade a WhatsApp.
  // Normalizar acá es lo único que ataja el dígito mal antes de que, el día del
  // upgrade, un mensaje termine en la casilla de un desconocido.
  const telefono = normalizarTel_(body.telefono);
  if (!telefono) {
    return jsonCORS(request, { ok: false, msg: 'Revisá el celular: poné código de área sin el 0 y el número sin el 15. Ej: 11 1234 5678' }, 400);
  }

  // Consentimiento. Sin esto no hay alta: es el registro de que aceptó, y es lo
  // que hace válido el "confirmo mail y teléfono de una" del mail siguiente.
  if (body.acepta !== true) {
    return jsonCORS(request, { ok: false, msg: 'Hay que aceptar los términos' }, 400);
  }

  // Tope por IP: barato y suficiente. Si algún día hace falta más, Turnstile.
  const ip = request.headers.get('cf-connecting-ip') || 'sin-ip';
  const claveIp = 'rate:' + ip + ':' + Math.floor(Date.now() / 3600000);
  const usado = Number((await kv.get(claveIp)) || '0');
  if (usado >= ALTAS_POR_IP_HORA) {
    return jsonCORS(request, { ok: false, msg: 'Demasiados intentos. Probá en un rato.' }, 429);
  }
  await kv.put(claveIp, String(usado + 1), { expirationTtl: 7200 });

  await encolar_(kv, 'alta', {
    email: email,
    nombre: nombre,
    telefono: telefono,
    acepta_v: DISCLAIMER_V,          // qué versión de los términos aceptó
    ip: ip                            // con el ts de la cola, el registro de consentimiento
  });
  return jsonCORS(request, { ok: true, msg: 'Listo' });
}

/**
 * normalizarTel_ — deja el número en el formato que espera `Contactos` y el Chat
 * WS Hub: 549 + área (sin 0) + número (sin 15). Devuelve '' si no puede
 * normalizarlo con confianza: mejor rechazar y que lo corrija ahora, a mandarle
 * un WhatsApp a un tercero dentro de seis meses.
 *
 * Acepta:  11 1234-5678 / 011 1234 5678 / +54 9 11 1234 5678 / 5491112345678
 *
 * ⚠️ NO resuelve el 15 INTERCALADO ("011 15 3659 7788"): el 15 va después del
 * área, y sin saber si el área es de 2, 3 o 4 dígitos, sacarlo es adivinar —
 * y adivinar mal acá es un número de otra persona. Eso se RECHAZA con un
 * mensaje que explica cómo escribirlo. Preferimos fricción hoy que un mensaje
 * a un desconocido mañana.
 */
function normalizarTel_(crudo) {
  let n = String(crudo || '').replace(/[^0-9]/g, '');
  if (!n) return '';

  if (n.indexOf('54') === 0) n = n.slice(2);   // país
  if (n.indexOf('9') === 0 && n.length > 10) n = n.slice(1);  // el 9 de móvil
  if (n.indexOf('0') === 0) n = n.slice(1);    // 0 de larga distancia
  if (n.indexOf('15') === 0 && n.length > 10) n = n.slice(2); // 15 pegado adelante

  // Area (2-4) + abonado (6-8) = 10 dígitos en todo el país.
  if (n.length !== 10) return '';
  return '549' + n;
}

/**
 * GET /confirmar?t=TOKEN — el doble opt-in. El token lo generó GAS y viajó en el
 * mail de confirmación; acá sólo se registra el click y se le muestra una página
 * al humano. Quien pasa de PENDIENTE a SI es GAS, al drenar.
 */
async function confirmarAlta(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  const token = String(new URL(request.url).searchParams.get('t') || '').trim();
  if (!kv || !tokenValido_(token)) return paginaHTML('Link inválido', 'Ese link no es válido o ya venció. Podés suscribirte otra vez desde la home.', 400);

  await encolar_(kv, 'confirm', { token: token });
  // ?j=1 -> respuesta JSON para la página de rioprofundo.com que hace el fetch.
  // Los links de los mails apuntan al dominio propio (workers.dev en un botón
  // "Confirmar" es señal de spam), y esa página delega acá.
  if (new URL(request.url).searchParams.get('j') === '1') {
    return jsonCORS(request, { ok: true });
  }
  return paginaHTML(
    'Suscripción confirmada',
    'Listo: vas a recibir los avisos por MAIL, gratis — cuando el río se salga de lo normal, crecientes y bajantes fuertes. Si además los querés por WhatsApp, es un servicio aparte (pago): activalo desde Mi cuenta en rioprofundo.com.'
  );
}

/** GET /baja?t=TOKEN — baja de un click (el token viaja en el mail de bienvenida). */
async function bajaPorToken(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  const token = String(new URL(request.url).searchParams.get('t') || '').trim();
  if (!kv || !tokenValido_(token)) return paginaHTML('Link inválido', 'Ese link no es válido o ya venció.', 400);

  await encolar_(kv, 'baja', { token: token });
  if (new URL(request.url).searchParams.get('j') === '1') {
    return jsonCORS(request, { ok: true });
  }
  return paginaHTML('Baja registrada', 'No vas a recibir más avisos. Si fue sin querer, podés volver a suscribirte cuando quieras.');
}

/**
 * POST /baja {email} — el pedido de baja desde la página pública.
 *
 * POR QUÉ NO DA DE BAJA DIRECTO: los avisos salen por BCC (un solo mail para
 * toda la lista, para que nadie vea a los demás), así que NO pueden llevar un
 * link con token por persona. La página pública sólo puede pedir el mail — y si
 * eso diera de baja directo, cualquiera podría desuscribir a otro. Entonces:
 * acá se ENCOLA un pedido, GAS le manda a ESE mail su link de un click, y la
 * baja la confirma quien tiene la casilla.
 */
async function bajaPorMail(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  if (!kv) return jsonCORS(request, { ok: false, msg: 'No disponible' }, 503);

  let body;
  try { body = await leerCuerpo_(request); }
  catch (e) { return jsonCORS(request, { ok: false, msg: 'Cuerpo inválido' }, 400); }

  const email = String(body.email || '').trim().toLowerCase();
  if (!emailValido_(email)) return jsonCORS(request, { ok: false, msg: 'Ese mail no parece válido' }, 400);

  await encolar_(kv, 'bajareq', { email: email });
  // Mismo mensaje exista o no: no confirmamos quién está en la lista.
  return jsonCORS(request, { ok: true, msg: 'Si ese mail está suscripto, te llega el link de baja.' });
}

/**
 * GET /pendientes?k=SECRETO — GAS lee la cola. Devuelve hasta 200 ítems con su
 * clave, para que después pueda hacer /ack de lo que efectivamente procesó.
 * No borra nada acá: si GAS se cae a mitad de camino, la cola sigue entera.
 */
async function leerCola(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  if (!autorizado_(request, env)) return json({ ok: false, msg: 'No autorizado' }, 401);
  if (!kv) return json({ ok: false, msg: 'KV no disponible' }, 503);

  // UNA sola llamada: `list` ya trae la metadata, que ES el dato (ver encolar_).
  const lista = await kv.list({ prefix: 'q:', limit: 200 });
  const items = [];
  const rezagados = [];

  for (const k of lista.keys) {
    if (k.metadata && k.metadata.tipo && !k.metadata.grande) {
      items.push({ clave: k.name, dato: k.metadata });
    } else {
      rezagados.push(k.name);   // ítem viejo (sin metadata) o demasiado grande
    }
  }

  // Sólo estos necesitan `get`. En régimen normal la lista está vacía; existe
  // para no perder lo que ya estaba encolado antes de este cambio.
  for (const nombre of rezagados.slice(0, 25)) {
    const v = await kv.get(nombre);
    if (v) { try { items.push({ clave: nombre, dato: JSON.parse(v) }); } catch (e) { /* corrupto: lo salteamos */ } }
  }

  return json({ ok: true, n: items.length, items: items, rezagados: rezagados.length });
}

/** POST /ack?k=SECRETO {keys:[...]} — GAS borra lo que ya procesó. */
async function borrarCola(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  if (!autorizado_(request, env)) return json({ ok: false, msg: 'No autorizado' }, 401);
  if (!kv) return json({ ok: false, msg: 'KV no disponible' }, 503);

  let body;
  try { body = await leerCuerpo_(request); }
  catch (e) { return json({ ok: false, msg: 'Cuerpo inválido' }, 400); }

  const claves = Array.isArray(body.keys) ? body.keys.slice(0, 200) : [];
  let n = 0;
  for (const c of claves) {
    if (typeof c === 'string' && c.indexOf('q:') === 0) { await kv.delete(c); n++; }
  }
  return json({ ok: true, borradas: n });
}

// ===========================================================================
//  ÁREA DE CLIENTES — espejo de lectura + login sin contraseña  (21/07/2026)
//
//  POR QUÉ EXISTE ESTO. El portal necesita datos POR USUARIO. El reflejo sería
//  que el Worker le pregunte a GAS, y ahí está la mina: **Alerta tiene UN SOLO
//  `doGet`** y es el que sirve el tablero. Agregarle rutas obliga a "Nueva
//  versión" de la implementación ACTIVA — la maniobra que congeló la web 16 h el
//  19/07. Entonces se invierte: un trigger de GAS (sin deploy) EMPUJA un espejo
//  a KV, y el Worker sólo lee.
//    → cero deploys de GAS, cero GAS en la ruta del request (ms, no 5 s), y si
//      GAS está caído el portal sigue andando con el último espejo.
//
//  ⚠️ EL ESPEJO SE ESCRIBE SÓLO CUANDO ALGO CAMBIA. El plan gratuito de KV da
//  ~1000 escrituras por día: publicar N usuarios cada minuto lo reventaría en
//  horas. El lado GAS manda únicamente las filas cuya huella cambió (ver
//  `Espejo.gs`). Como una cuenta cambia unas pocas veces AL AÑO, en régimen las
//  escrituras son ~0.
//
//  LOGIN: sin contraseñas. El Worker genera el código, lo guarda en KV y encola
//  el envío para que GAS lo mande por el canal que la persona tenga (WhatsApp si
//  paga, mail si no). Así el Worker puede verificarlo solo, sin otra vuelta.
// ===========================================================================

/** Días que vive una sesión. Largo a propósito: la mayoría de las visitas no ven login. */
const SESION_DIAS = 90;
/** Minutos que vale un código de ingreso. */
const CODIGO_MIN = 15;
/** Intentos antes de quemar el código. */
const CODIGO_INTENTOS = 5;

/**
 * Clave de KV para un mail. Es un HMAC con el secreto, NO un hash del mail:
 * así, aunque alguien conozca la dirección, no puede derivar la clave y pedirle
 * el registro a KV. Defensa en profundidad — el control real es la sesión.
 */
async function claveUsuario_(email, env) {
  const h = await hmacHex_(String(email).trim().toLowerCase(), env.RP_SUB_SECRET);
  return 'u:' + h.slice(0, 32);
}

async function hmacHex_(mensaje, secreto) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('HMAC', k, enc.encode(mensaje));
  return [...new Uint8Array(firma)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * POST /espejo?k=SECRETO  {filas:[{h, estado, vence, dias, tel, ...}]}
 * GAS empuja los snapshots que cambiaron. `h` ya viene calculado del lado GAS
 * con el MISMO HMAC (ver `espejoClave_` en Espejo.gs): si esas dos funciones se
 * desincronizan, el portal no encuentra a nadie.
 */
async function recibirEspejo(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  if (!autorizado_(request, env)) return json({ ok: false, msg: 'No autorizado' }, 401);
  if (!kv) return json({ ok: false, msg: 'KV no disponible' }, 503);

  let body;
  try { body = await leerCuerpo_(request); }
  catch (e) { return json({ ok: false, msg: 'Cuerpo inválido' }, 400); }

  // cfg:pago (22/07/2026): precio y alias, que viven en la hoja Config de GAS.
  // Viaja por este mismo POST (con huella del lado GAS: sólo cuando cambia).
  if (body.cfg && typeof body.cfg === 'object' && !Array.isArray(body.cfg)) {
    await kv.put('cfg:pago', JSON.stringify({
      precio: Number(body.cfg.precio) || 0,
      alias: String(body.cfg.alias || '').slice(0, 60),
      cbu: String(body.cfg.cbu || '').replace(/[^0-9]/g, '').slice(0, 22),
      titular: String(body.cfg.titular || '').slice(0, 80),
      // NUESTRO número de WhatsApp (celda `WS_NUMERO` de Config). Lo usa
      // `linkWaMe_` para armar el link en el acto en `/activar`.
      ws_numero: String(body.cfg.ws_numero || '').replace(/[^0-9]/g, '').slice(0, 15)
    }));
  }

  const filas = Array.isArray(body.filas) ? body.filas.slice(0, 200) : [];
  let n = 0;
  for (const f of filas) {
    if (!f || typeof f.h !== 'string' || !/^[a-f0-9]{32}$/.test(f.h)) continue;
    const dato = Object.assign({}, f); delete dato.h;
    // Sin TTL: el espejo tiene que sobrevivir a que GAS esté caído mucho tiempo.
    // Las bajas se limpian con {baja:true}, no dejando vencer la clave.
    if (f.baja) { await kv.delete('u:' + f.h); }
    else { await kv.put('u:' + f.h, JSON.stringify(dato)); }
    n++;
  }
  return json({ ok: true, escritas: n });
}

/**
 * GET /espejo?k=SECRETO[&email=…] — DIAGNÓSTICO. No escribe nada.
 *
 * Existe por una razón concreta: `/entrar` **responde siempre lo mismo** exista o
 * no el mail (la guarda anti-oráculo), así que cuando algo falla no hay ninguna
 * señal de dónde. Esto abre esa caja: dice qué claves tiene KV y qué hash calcula
 * el Worker para un mail — que es exactamente lo que hay que comparar contra
 * `espejoClave_` de GAS si el portal "no encuentra a nadie".
 */
async function mirarEspejo(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  if (!autorizado_(request, env)) return json({ ok: false, msg: 'No autorizado' }, 401);
  if (!kv) return json({ ok: false, msg: 'KV no disponible' }, 503);

  // ⚠️ Cada paso va envuelto: un throw suelto acá sale como "error code: 1101",
  // que no dice NADA de dónde reventó. Prefiero una respuesta fea que un 500 mudo.
  const out = { ok: true, pasos: [] };
  let paso = 'inicio';
  try {
    paso = 'list u:';
    const us = await kv.list({ prefix: 'u:', limit: 100 });
    out.usuarios_en_kv = us.keys.length;
    out.claves = us.keys.map(k => k.name);
    out.pasos.push('list u: ok');

    paso = 'list q:';
    const qs = await kv.list({ prefix: 'q:', limit: 100 });
    out.cola_pendiente = qs.keys.length;
    out.cola_tipos = qs.keys.map(k => (k.metadata && k.metadata.tipo) || '?');
    out.pasos.push('list q: ok');

    // cfg:pago tal como está guardado. Sirve para confirmar de un vistazo que
    // `ws_numero` llegó (sin él no hay link instantáneo, y el síntoma es mudo:
    // simplemente vuelve el "Preparando tu enlace…" de antes).
    paso = 'get cfg:pago';
    const cfg = await kv.get('cfg:pago');
    out.cfg_pago = cfg ? JSON.parse(cfg) : null;
    out.link_instantaneo = !!(out.cfg_pago && String(out.cfg_pago.ws_numero || '').length >= 10);
    out.pasos.push('cfg:pago ok');

    const email = (new URL(request.url).searchParams.get('email') || '').trim().toLowerCase();
    if (email) {
      paso = 'hmac';
      const clave = await claveUsuario_(email, env);
      out.pasos.push('hmac ok');

      paso = 'get ' + clave;
      const dato = await kv.get(clave);
      out.pasos.push('get ok');

      out.consulta = { email: email, hash_worker: clave.slice(2), encontrado: !!dato, dato: null };
      if (dato) {
        paso = 'parse';
        try { out.consulta.dato = JSON.parse(dato); }
        catch (e) { out.consulta.dato = '(no es JSON) ' + String(dato).slice(0, 120); }
      }
    }
  } catch (e) {
    return json({ ok: false, murio_en: paso, error: String(e && e.message || e),
                  stack: String(e && e.stack || '').slice(0, 400), parcial: out }, 200);
  }
  return json(out);
}

/**
 * POST /entrar  {email}
 * ⚠️ RESPONDE SIEMPRE LO MISMO, exista o no el mail. Si dijera "no existe",
 * el formulario sería un oráculo para averiguar quién está suscripto probando
 * direcciones. El costo de la discreción es que un typo se siente como un mail
 * que no llega — por eso el texto dice "si ese mail está registrado".
 */
async function pedirCodigo(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  if (!kv) return jsonCORS(request, { ok: false, msg: 'No disponible' }, 503);

  let body;
  try { body = await leerCuerpo_(request); }
  catch (e) { return jsonCORS(request, { ok: false, msg: 'Cuerpo inválido' }, 400); }

  const email = String(body.email || '').trim().toLowerCase();

  // ⚠️⚠️ ESTA RESPUESTA ES LA MISMA PARA TODOS LOS CAMINOS, Y ES DELIBERADO:
  // exista o no el mail, esté frenado o no, la página recibe EXACTAMENTE esto. Si
  // alguna rama agregara un campo propio —el canal real, "ya te mandamos", un
  // `demora` distinto—, `/entrar` volvería a ser un **oráculo** para averiguar
  // quién está suscripto probando direcciones, que es justo lo que la guarda
  // anti-oráculo vino a tapar. `demora` va acá adentro por eso: es una propiedad
  // del sistema (el mail sale por el drenaje de GAS, trigger de 1 min), no un dato
  // de esta persona. El día que el mail salga del Worker (Resend, pendiente #16)
  // pasa a false y la página deja de pedir paciencia sola.
  //
  // ⚠️ `demora` sale de la CONFIGURACIÓN, no de esta persona: es `true` mientras el
  // mail salga por la cola de GAS y `false` cuando lo manda el Worker. Atarlo a lo
  // que pasó con ESTE pedido (¿se mandó?, ¿existía el mail?) lo convertiría en la
  // pista que la guarda anti-oráculo justamente evita. Se apaga solo el día que
  // aparece la key de Resend, sin tocar la página.
  const respuesta = {
    ok: true,
    demora: !(env && env.RESEND_API_KEY),
    msg: 'Si ese mail está registrado, te mandamos un código.'
  };
  if (!emailValido_(email)) return jsonCORS(request, respuesta, 200);

  const clave = await claveUsuario_(email, env);
  const existe = await kv.get(clave);
  if (!existe) return jsonCORS(request, respuesta, 200);   // misma respuesta, sin pista

  // ⚠️ FRENO ANTI-BOMBARDEO. Sin esto, /entrar es una máquina de mandarle mails
  // (o WhatsApps) a un tercero: basta con postear su dirección en loop. Si ya se
  // emitió un código hace menos de un minuto, se reusa y NO se encola otro envío
  // — el reintento legítimo sigue funcionando pasado ese minuto.
  const cc = 'c:' + clave.slice(2);
  let codigo = '';
  const previo = await kv.get(cc);
  if (previo) {
    try {
      const r = JSON.parse(previo);
      // Menos de un minuto: no se manda nada. El freno es por envío, no por código.
      if (r.ts && (Date.now() - r.ts) < 60000) return jsonCORS(request, respuesta, 200);
      // ⚠️⚠️ PASADO EL MINUTO SE REUSA EL MISMO CÓDIGO. NO SE ROTA. (25/07/2026)
      //
      // Antes acá se generaba uno nuevo y se PISABA el anterior, y eso convertía
      // la impaciencia en un bucle infinito: el mail tarda más de un minuto, así
      // que **la ventana de rotación era más corta que el tiempo de entrega**. La
      // persona esperaba 90 s, volvía a pedir, y con ese gesto MATABA el código
      // que le estaba llegando. Después recibía dos mails idénticos, tipeaba el
      // del primero, leía "código incorrecto o vencido", pedía otro… para siempre.
      //
      // Reusando, todos los mails de su bandeja sirven y volver a pedir es
      // inofensivo. Es la misma regla que salvó la verificación por WhatsApp:
      // NUNCA invalidar algo que ya está en vuelo.
      //
      // `intentos` NO se reinicia a propósito: la quema a los CODIGO_INTENTOS es
      // lo que impide adivinar 4 caracteres a fuerza bruta, y un reenvío legítimo
      // no es motivo para regalar intentos nuevos.
      if (/^[A-Z][0-9]{3}$/.test(String(r.codigo || ''))) {
        codigo = r.codigo;
        // Se refresca el `ts` (para que el freno del minuto cuente desde ESTE
        // envío) sin tocar el código ni los intentos, y se estira la vigencia.
        await kv.put(cc, JSON.stringify({ codigo: codigo, intentos: r.intentos || 0, ts: Date.now() }),
          { expirationTtl: CODIGO_MIN * 60 });
      }
    } catch (e) { /* corrupto: se emite uno nuevo abajo */ }
  }

  if (!codigo) {
    codigo = codigoIngreso_();
    await kv.put(cc,
      JSON.stringify({ codigo: codigo, intentos: 0, ts: Date.now() }),
      { expirationTtl: CODIGO_MIN * 60 });
  }

  let canal = 'mail';
  try { canal = (JSON.parse(existe).ws ? 'whatsapp' : 'mail'); } catch (e) { /* default mail */ }

  // ⚡ EL MAIL SALE DE ACÁ, EN SEGUNDOS (25/07/2026). Si Resend no está —falta la
  // key, el dominio todavía no está verificado, o se cayó— `mandarMail_` devuelve
  // false y se encola como siempre: tarda como antes, pero NO se pierde.
  //
  // ⚠️ WhatsApp sigue yendo por la cola SIEMPRE: el único que llega al hub es GAS.
  let mandado = false;
  if (canal === 'mail') {
    mandado = await mandarMail_(env, email, 'Tu código de ingreso: ' + codigo,
      'Para entrar a tu cuenta de Río Profundo, escribí este código en la página: ' + codigo,
      'Vence en ' + CODIGO_MIN + ' minutos. Si no fuiste vos quien lo pidió, podés ignorar este mail.');
  }
  if (!mandado) {
    await encolar_(kv, 'logincode', { email: email, codigo: codigo, canal: canal });
  }

  return jsonCORS(request, respuesta, 200);
}

// ===========================================================================
//  MAIL DESDE EL WORKER (Resend) — pendiente #16, 25/07/2026
// ===========================================================================
/*
 *  POR QUÉ ESTO EXISTE, EN UNA LÍNEA: el mail transaccional salía por el drenaje
 *  de GAS (trigger de 1 min + caché de borde de KV), o sea que el código de
 *  ingreso tardaba un par de minutos. Y el mail dejó de ser "el aviso": desde el
 *  área de clientes **es la puerta de entrada a la cuenta**. Un código que tarda
 *  no es un aviso tarde, es alguien que no puede entrar — y que pide otro, y otro.
 *
 *  El truco del `wa.me` no se podía repetir acá: aquel link era instantáneo
 *  porque el destino era la propia pantalla. Un mail necesita quién lo mande, y
 *  GAS no puede correr más seguido que un minuto. Por eso el remitente se muda
 *  acá: el Worker ya está en el camino del request.
 *
 *  ⚠️ REQUISITOS DE INFRAESTRUCTURA (sin esto NO manda, y no rompe: cae solo al
 *  camino viejo por la cola de GAS):
 *    1. `RESEND_API_KEY` como secret del Worker.
 *    2. El dominio `mail.rioprofundo.com` VERIFICADO en Resend (SPF + DKIM).
 *       Es un SUBDOMINIO a propósito: no toca el MX de `rioprofundo.com`, que hoy
 *       usa Cloudflare Email Routing para reenviar info@ a info@tasks-on.com.
 *
 *  ⚠️ NUNCA mandar links a `workers.dev` desde acá. Es lo que mandó el primer
 *  mail de confirmación a spam el 20/07: dominio compartido gratuito y muy usado
 *  para abuso. Todo link va a rioprofundo.com.
 */
const MAIL_DE = 'Río Profundo <avisos@mail.rioprofundo.com>';
const MAIL_REPLY = 'info@rioprofundo.com';
const MAIL_WEB = 'https://rioprofundo.com/';

/**
 * Manda un mail por Resend. Devuelve true SÓLO si Resend lo aceptó.
 *
 * ⚠️ NUNCA lanza y NUNCA devuelve true sin confirmación: quien la llama usa el
 * false para caer al camino viejo (encolar para que lo mande GAS). Así, si falta
 * la key, el dominio no está verificado todavía o Resend está caído, **no se
 * pierde un solo mail** — sólo vuelve a tardar como antes.
 *
 * `p1` y `p2` son los dos párrafos, igual que `susMandar_` de GAS, y el pie es el
 * mismo de `susMandarCrudo_`: los dos remitentes tienen que verse idénticos
 * mientras el sistema esté partido entre los dos caminos.
 */
async function mandarMail_(env, para, asunto, p1, p2, opciones) {
  const key = env && env.RESEND_API_KEY;
  if (!key) return false;
  const o = opciones || {};

  const pie = '<hr style="border:none;border-top:1px solid #dde;margin:24px 0">'
    + '<p style="color:#889;font-size:12px">Río Profundo · '
    + '<a href="' + MAIL_WEB + '">rioprofundo.com</a> · ' + MAIL_REPLY + '</p>';
  const html = '<div style="font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;'
    + 'color:#223;max-width:34rem"><p>' + escHtml_(p1) + '</p>'
    + '<p>' + (o.p2Html || escHtml_(p2 || '')) + '</p>' + pie + '</div>';
  const texto = p1 + '\n\n' + String(p2 || '').replace(/<[^>]+>/g, '')
    + '\n\n— Río Profundo · ' + MAIL_WEB;

  const cuerpo = {
    from: MAIL_DE, to: [para], subject: asunto, text: texto, html: html,
    reply_to: MAIL_REPLY
  };
  // `List-Unsubscribe` sólo donde tiene sentido: de un código de ingreso no se
  // puede "desuscribir" nadie. Va en los mails de la suscripción, y es lo que
  // `GmailApp` no sabía poner (media razón del pendiente #16).
  if (o.bajaUrl) {
    cuerpo.headers = {
      'List-Unsubscribe': '<' + o.bajaUrl + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    };
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo)
    });
    if (r.status >= 200 && r.status < 300) return true;
    console.log('mandarMail_: Resend HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return false;
  } catch (e) {
    console.log('mandarMail_: ' + e);
    return false;
  }
}

function escHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Mismo formato que la verificación de teléfono (A503): sin I/O/Q, no se confunden. */
function codigoIngreso_() {
  const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const n = crypto.getRandomValues(new Uint32Array(2));
  return L[n[0] % L.length] + String(n[1] % 1000).padStart(3, '0');
}

/** POST /sesion {email, codigo} -> token firmado. */
async function abrirSesion(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  if (!kv) return jsonCORS(request, { ok: false, msg: 'No disponible' }, 503);

  let body;
  try { body = await leerCuerpo_(request); }
  catch (e) { return jsonCORS(request, { ok: false, msg: 'Cuerpo inválido' }, 400); }

  const email = String(body.email || '').trim().toLowerCase();
  const dado = String(body.codigo || '').trim().toUpperCase();
  const malo = { ok: false, msg: 'Código incorrecto o vencido.' };
  if (!emailValido_(email) || !/^[A-Z][0-9]{3}$/.test(dado)) return jsonCORS(request, malo, 200);

  const clave = await claveUsuario_(email, env);
  const cc = 'c:' + clave.slice(2);
  const crudo = await kv.get(cc);
  if (!crudo) return jsonCORS(request, malo, 200);

  let reg; try { reg = JSON.parse(crudo); } catch (e) { return jsonCORS(request, malo, 200); }

  if (reg.codigo !== dado) {
    reg.intentos = (reg.intentos || 0) + 1;
    // Se quema al pasarse: sin esto, 4 dígitos se adivinan a fuerza bruta.
    if (reg.intentos >= CODIGO_INTENTOS) await kv.delete(cc);
    else await kv.put(cc, JSON.stringify(reg), { expirationTtl: CODIGO_MIN * 60 });
    return jsonCORS(request, malo, 200);
  }

  await kv.delete(cc);                                  // un código, un uso
  const token = await firmarSesion_(clave.slice(2), env);
  return jsonCORS(request, { ok: true, token: token, dias: SESION_DIAS }, 200);
}

/** POST /cuenta {token} -> el espejo de esa persona. */
async function verCuenta(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  if (!kv) return jsonCORS(request, { ok: false, msg: 'No disponible' }, 503);

  let body;
  try { body = await leerCuerpo_(request); }
  catch (e) { return jsonCORS(request, { ok: false, msg: 'Cuerpo inválido' }, 400); }

  const h = await verificarSesion_(String(body.token || ''), env);
  if (!h) return jsonCORS(request, { ok: false, msg: 'Sesión vencida' }, 401);

  const crudo = await kv.get('u:' + h);
  if (!crudo) return jsonCORS(request, { ok: false, msg: 'Sin datos' }, 404);

  const cuenta = JSON.parse(crudo);

  // Datos de pago (22/07/2026): precio + alias desde cfg:pago, y el IMPORTE
  // personalizado — los centavos son los últimos 2 dígitos del celular, que acá
  // se leen del teléfono ENMASCARADO del espejo (los últimos 4 son visibles).
  // Si cfg:pago no está (Config sin cargar), `pago` va null y la página lo dice.
  let pago = null;
  try {
    const cfg = await kv.get('cfg:pago');
    if (cfg) {
      pago = JSON.parse(cfg);
      const dd = parseInt(String(cuenta.tel || '').slice(-2), 10);
      if (pago.precio > 0 && !isNaN(dd)) {
        pago.importe = ((pago.precio - 1) * 100 + dd) / 100;
      }
    }
  } catch (e) { pago = null; }

  return jsonCORS(request, { ok: true, cuenta: cuenta, pago: pago }, 200);
}

/**
 * POST /activar  {token, nombre, domicilio}  (22/07/2026)
 *
 * El pedido de activación de WhatsApp: datos fiscales (consumidor final, V1:
 * nombre y apellido + domicilio, nada más) -> ítem `activar` en la cola. GAS
 * escribe `Facturacion` y dispara el código A503 por WhatsApp (verPedir).
 *
 * Sólo con sesión: el token dice QUIÉN es, así que acá no viaja el mail — GAS
 * resuelve el hash contra Contactos. Freno de 60 s por usuario: sin él, el
 * botón repetido encola pedidos y cada uno re-manda un WhatsApp (misma familia
 * que el freno de /entrar).
 */
async function pedirActivacion(request, env) {
  const kv = (env && env.RP_KV) ? env.RP_KV : null;
  if (!kv) return jsonCORS(request, { ok: false, msg: 'No disponible' }, 503);

  let body;
  try { body = await leerCuerpo_(request); }
  catch (e) { return jsonCORS(request, { ok: false, msg: 'Cuerpo inválido' }, 400); }

  const h = await verificarSesion_(String(body.token || ''), env);
  if (!h) return jsonCORS(request, { ok: false, msg: 'Sesión vencida' }, 401);

  const crudo = await kv.get('u:' + h);
  if (!crudo) return jsonCORS(request, { ok: false, msg: 'Sin datos' }, 404);

  let cuenta; try { cuenta = JSON.parse(crudo); } catch (e) { cuenta = {}; }
  if (cuenta.ws) {
    // Ya activo: la renovación en V1 va por mail + transferencia, a mano.
    return jsonCORS(request, { ok: false, msg: 'WhatsApp ya está activo en tu cuenta.' }, 200);
  }

  const nombre = String(body.nombre || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const domicilio = String(body.domicilio || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (nombre.length < 5 || nombre.length > 80 || nombre.indexOf(' ') < 0) {
    return jsonCORS(request, { ok: false, msg: 'Poné tu nombre y apellido completos (van en la factura).' }, 200);
  }
  if (domicilio.length < 6 || domicilio.length > 160) {
    return jsonCORS(request, { ok: false, msg: 'Poné el domicilio completo: calle, número y localidad.' }, 200);
  }

  // Freno anti-repetición: un código por minuto por usuario, iniciativa del
  // usuario siempre (el reintento pasado el minuto es legítimo y funciona).
  //
  // ⚠️ VA ANTES DE EMITIR, Y ESE ORDEN ES LA GUARDA CENTRAL DEL DISEÑO NUEVO:
  // mientras el freno está puesto NO se genera otro código, porque emitir uno
  // nuevo **invalida el que la persona ya tiene en la mano** (el bug del `L016`).
  // Al doble toque se le devuelve EL MISMO link, que es lo que quería.
  const fa = 'a:' + h;
  const cv = 'v:' + h;
  if (await kv.get(fa)) {
    const vigente = await kv.get(cv);
    const link = (vigente && /^[A-Z][0-9]{3}$/.test(vigente)) ? await linkWaMe_(kv, vigente) : '';
    return jsonCORS(request, {
      ok: !!link, esperar: true, wa: link, wa_cod: link ? vigente : '',
      msg: link ? '' : 'Ya te dimos un código hace un momento. Esperá un minuto y probá de nuevo.'
    }, 200);
  }
  await kv.put(fa, '1', { expirationTtl: 60 });

  // ============================================================================
  //  EL CÓDIGO LO EMITE EL WORKER, Y EL LINK VUELVE EN ESTA MISMA RESPUESTA
  //  (25/07/2026 — la muerte del "Preparando tu enlace…")
  //
  //  Antes el código nacía en GAS y viajaba al botón por el espejo. Eso metía
  //  TRES esperas apiladas antes de que la persona pudiera hacer su parte:
  //    · hasta 60 s esperando la corrida del trigger,
  //    · hasta 60 s hasta que GAS VE la bandera `q:flag` (caché de borde de KV),
  //    · hasta 60 s hasta que `/cuenta` DEVUELVE el espejo nuevo (mismo caché).
  //  Y lo peor: **leer seguido lo empeora**, porque cada lectura re-arma el caché
  //  de 60 s con el valor viejo — o sea que el poll de la página y el `/hay` de
  //  GAS mantenían caliente justo el dato que querían ver cambiar. Y no se puede
  //  tunear: el mínimo de `cacheTtl` en KV es 60 s. KV es un caché pensado para
  //  servir dato viejo rápido; ahí arriba se había montado un apretón de manos
  //  en tiempo real.
  //
  //  Precedente que esto sigue: el CÓDIGO DE INGRESO ya lo genera el Worker,
  //  exactamente por lo mismo. GAS queda como el que PERSISTE y MATCHEA (es el
  //  único que lee `Notificaciones` del hub), no como el que inventa.
  //
  //  ⚠️ LO QUE ESTO ARRASTRA, Y QUE VA DEL LADO DE GAS: ahora la persona puede
  //  mandarnos el mensaje ANTES de que exista la fila. `verDrenarRespuestas_`
  //  descartaba lo anterior al código → `VER_GRACIA_MIN` + el `ts` que se manda
  //  acá abajo. Sin eso, este cambio garantiza el bug que vino a arreglar.
  // ============================================================================
  let codigo = await kv.get(cv);
  if (!codigo || !/^[A-Z][0-9]{3}$/.test(codigo)) {
    codigo = codigoVerif_();
    await kv.put(cv, codigo, { expirationTtl: VERIF_TTL_SEG });
  }
  const wa = await linkWaMe_(kv, codigo);

  // El `ts` es el instante REAL de emisión. GAS lo escribe en la col 15 en vez de
  // la hora de su propia corrida, que puede llegar hasta ~2 min después.
  await encolar_(kv, 'activar', {
    h: h, nombre: nombre, domicilio: domicilio, codigo: codigo, ts: Date.now()
  });

  // Si falta `ws_numero` en `cfg:pago`, `wa` viene vacío y la página cae al
  // camino de antes (espera el link por el espejo). Degrada, no rompe.
  return jsonCORS(request, {
    ok: true, tel: cuenta.tel || '', wa: wa, wa_cod: wa ? codigo : '', msg: ''
  }, 200);
}

/** Vigencia del código de verificación. Espeja `VER_VIGENCIA_MIN` de GAS (30 min). */
const VERIF_TTL_SEG = 1800;

/**
 * Código de verificación: 1 letra + 3 dígitos (A503).
 *
 * ⚠️ Espejo de `verGenerarCodigo_` de GAS —mismo alfabeto sin I/O/Q, que se
 * confunden con 1 y 0 al leerlas de una notificación— y GAS valida el formato
 * con `/^[A-Z][0-9]{3}$/` antes de escribirlo. Si acá cambia el formato, allá se
 * descarta el ítem: son dos copias de la misma decisión.
 */
function codigoVerif_() {
  const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const b = new Uint32Array(2);
  crypto.getRandomValues(b);
  return L[b[0] % L.length] + String(b[1] % 1000).padStart(3, '0');
}

/**
 * El link `wa.me` con NUESTRO número (de `cfg:pago.ws_numero`, que sale de la
 * celda `WS_NUMERO` de la hoja Config) y el código adentro.
 *
 * Devuelve '' si el número no está o quedó mal cargado: mejor sin botón que un
 * botón que abre un chat con nadie. El texto no necesita coincidir palabra por
 * palabra con `verTextoUsuario_` de GAS — el match busca el código DENTRO del
 * mensaje, no compara el texto entero.
 */
async function linkWaMe_(kv, codigo) {
  let num = '';
  try {
    const c = await kv.get('cfg:pago');
    if (c) num = String((JSON.parse(c) || {}).ws_numero || '');
  } catch (e) { num = ''; }
  num = num.replace(/[^0-9]/g, '');
  if (num.length < 10) return '';
  return 'https://wa.me/' + num + '?text='
    + encodeURIComponent('Hola Río Profundo, quiero activar mis avisos. Mi código es ' + codigo);
}

/** token = base64url({h,exp}) + '.' + HMAC. Sin estado en KV: se valida solo. */
async function firmarSesion_(h, env) {
  const payload = b64url_(JSON.stringify({ h: h, exp: Date.now() + SESION_DIAS * 86400000 }));
  const firma = await hmacHex_(payload, env.RP_SUB_SECRET);
  return payload + '.' + firma.slice(0, 32);
}

async function verificarSesion_(token, env) {
  const p = String(token).split('.');
  if (p.length !== 2) return null;
  const esperada = (await hmacHex_(p[0], env.RP_SUB_SECRET)).slice(0, 32);
  if (!igualesSeguro_(p[1], esperada)) return null;
  let d; try { d = JSON.parse(deB64url_(p[0])); } catch (e) { return null; }
  if (!d || !d.h || !d.exp || Date.now() > d.exp) return null;
  return /^[a-f0-9]{32}$/.test(d.h) ? d.h : null;
}

function igualesSeguro_(a, b) {
  if (a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

function b64url_(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64url_(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(t + '==='.slice((t.length + 3) % 4))));
}

// --- helpers de suscripción -------------------------------------------------

/**
 * Acepta JSON y text/plain. El form manda text/plain a propósito: así el pedido
 * es "simple" para CORS y el navegador NO hace preflight OPTIONS.
 */
async function leerCuerpo_(request) {
  const txt = await request.text();
  if (!txt) return {};
  return JSON.parse(txt);
}

function emailValido_(e) {
  return e.length >= 6 && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e);
}

/** El token lo genera GAS; acá sólo se valida la FORMA (hex/base, sin firmar). */
function tokenValido_(t) {
  return /^[A-Za-z0-9_-]{16,64}$/.test(t);
}

/** Compara el secreto en tiempo ~constante. Falla CERRADO si no está seteado. */
function autorizado_(request, env) {
  const esperado = env && env.RP_SUB_SECRET;
  if (!esperado) return false;
  const dado = new URL(request.url).searchParams.get('k') || '';
  if (dado.length !== esperado.length) return false;
  let dif = 0;
  for (let i = 0; i < dado.length; i++) dif |= dado.charCodeAt(i) ^ esperado.charCodeAt(i);
  return dif === 0;
}

function metodoNo() { return json({ ok: false, msg: 'Método no permitido' }, 405); }

/** Preflight CORS. El form evita disparo con text/plain, pero por las dudas. */
function preflight(request) {
  const origen = request.headers.get('origin') || '';
  const permitido = ORIGENES_OK.indexOf(origen) >= 0 ? origen : ORIGENES_OK[0];
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': permitido,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400'
    }
  });
}

/** JSON de ESCRITURA: CORS acotado a la web propia (a diferencia del tablero). */
function jsonCORS(request, obj, status) {
  const origen = request.headers.get('origin') || '';
  const permitido = ORIGENES_OK.indexOf(origen) >= 0 ? origen : ORIGENES_OK[0];
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': permitido,
      'cache-control': 'no-store'
    }
  });
}

/** Página mínima para los links de mail (confirmar / baja). Sin dependencias. */
function paginaHTML(titulo, texto, status) {
  const html = '<!doctype html><html lang="es"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex">'
    + '<title>' + esc_(titulo) + ' · Río Profundo</title>'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#0b1a2b;color:#e8eef5;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}'
    + '.c{max-width:30rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .75rem;font-weight:600}'
    + 'p{margin:0 0 1.5rem;color:#a9bdd2}a{color:#4db8ff;text-decoration:none}a:hover{text-decoration:underline}</style>'
    + '</head><body><div class="c"><h1>' + esc_(titulo) + '</h1><p>' + esc_(texto) + '</p>'
    + '<p><a href="https://rioprofundo.com/">🌊 Ir a Río Profundo</a></p></div></body></html>';
  return new Response(html, {
    status: status || 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ===========================================================================
//  Helpers del tablero (sin cambios)
// ===========================================================================

// Response "de cache": texto + timestamp de guardado + cache-control interno.
function armarResp(texto, guardado, cfg) {
  return new Response(texto, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-guardado': String(guardado),
      'cache-control': 'public, max-age=' + (cfg.min * 60 * 2)
    }
  });
}

function conCORS(resp, estado) {
  const guardado = Number(resp.headers.get('x-guardado') || Date.now());
  const edadSeg = Math.round((Date.now() - guardado) / 1000);
  const h = new Headers(resp.headers);
  h.set('access-control-allow-origin', '*');
  h.set('x-cache', estado);
  h.set('x-edad-seg', String(edadSeg));
  h.set('cache-control', 'public, max-age=60');
  return new Response(resp.body, { status: resp.status, headers: h });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }
  });
}

// --- Formato MODULE (el que usa Cloudflare; ctx habilita waitUntil y cron) ---
export default {
  fetch(request, env, ctx) { return manejar(request, env, ctx); },
  scheduled(event, env, ctx) { ctx.waitUntil(precalentar(env, ctx)); }
};
