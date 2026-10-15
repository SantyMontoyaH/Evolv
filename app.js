/* =====================================================================
   Evolv: control de déficit calórico
   ---------------------------------------------------------------------
   Persistencia: archivos JSON dentro de este mismo repositorio (carpeta
   /data), leídos y escritos con la API REST de GitHub (Contents API).
   El token personal de GitHub se introduce en Ajustes y se guarda solo
   en el localStorage del dispositivo; nunca va en el código.
   ===================================================================== */

'use strict';

/* ------------------------------ Configuración ------------------------------ */
const CONFIG = {
  OWNER: 'SantyMontoyaH',
  REPO: 'Evolv',
  BRANCH: 'main',
  ALTURA_CM: 177,              // Altura fija para la fórmula de la Marina
  OBJETIVO_DEFECTO: 2000,      // Objetivo diario si settings.json no tiene uno
  PATHS: {
    foods: 'data/foods.json',
    days: 'data/days.json',
    measurements: 'data/measurements.json',
    settings: 'data/settings.json',
  },
  PICOTEO: {
    verde:    { kcal: 50,  etiqueta: 'Picoteo verde' },
    amarillo: { kcal: 150, etiqueta: 'Picoteo amarillo' },
    rojo:     { kcal: 250, etiqueta: 'Picoteo rojo' },
  },
  LS_TOKEN: 'evolv_github_token',
};

/* --------------------------------- Estado ---------------------------------- */
const state = {
  fecha: hoyISO(),         // Día activo (YYYY-MM-DD, hora local del sistema)
  foods: [],
  days: {},
  measurements: [],
  settings: { objetivo_kcal: CONFIG.OBJETIVO_DEFECTO, altura_cm: CONFIG.ALTURA_CM },
  alimentoSeleccionado: null,
  chart: null,
};

/* ================================ Utilidades =============================== */

/** Devuelve la fecha local del sistema en formato YYYY-MM-DD (no UTC). */
function hoyISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Hora local HH:MM para sellar cada entrada. */
function horaActual() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Fecha legible en español a partir de YYYY-MM-DD. */
function fechaLegible(iso, opciones = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-ES', opciones);
}

/** Escapa texto antes de insertarlo como HTML (evita inyección). */
function esc(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Convierte un valor a número finito o devuelve null. */
function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Redondea a n decimales. */
function redondear(n, dec = 1) {
  const f = 10 ** dec;
  return Math.round(n * f) / f;
}

/** Genera un identificador único para entradas. */
function nuevoId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Crea un slug a partir de un nombre (id de alimento). */
function slug(texto) {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** Copia profunda (rompe referencias compartidas entre state y la caché). */
function clonar(obj) {
  return structuredClone(obj);
}

/**
 * Elimina entradas con id repetido y recalcula el total de cada día.
 * Sirve para limpiar datos que ya se guardaron duplicados.
 */
function limpiarDuplicados(days) {
  for (const f of Object.keys(days)) {
    const vistos = new Set();
    days[f].entradas = (days[f].entradas || []).filter((e) => {
      if (vistos.has(e.id)) return false;
      vistos.add(e.id);
      return true;
    });
    days[f].total_kcal = days[f].entradas.reduce((s, e) => s + e.kcal, 0);
  }
  return days;
}

/** Muestra un aviso temporal en la parte inferior. */
function toast(mensaje, tipo = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = mensaje;
  el.className = `fixed left-1/2 -translate-x-1/2 bottom-24 z-50 max-w-[90vw] px-4 py-3 rounded-xl text-sm font-medium shadow-lg ${
    tipo === 'error' ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2800);
}

/** Muestra u oculta el indicador de sincronización de la cabecera. */
function setSync(activo) {
  document.getElementById('syncDot').classList.toggle('hidden', !activo);
}

/* ===================== Capa de datos: GitHub Contents API ==================== */

const GH = {
  /** Caché local por ruta: { data, sha }. El sha es necesario para sobrescribir. */
  cache: {},
  /** Cola para serializar escrituras y evitar conflictos de sha. */
  cola: Promise.resolve(),

  token() {
    try { return localStorage.getItem(CONFIG.LS_TOKEN) || ''; } catch { return ''; }
  },

  url(path) {
    return `https://api.github.com/repos/${CONFIG.OWNER}/${CONFIG.REPO}/contents/${path}`;
  },

  headers() {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token()}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  },

  /** Decodifica base64 a texto UTF-8 (acentos incluidos). */
  decode(b64) {
    const bin = atob(b64.replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  },

  /** Codifica texto UTF-8 a base64. */
  encode(texto) {
    const bytes = new TextEncoder().encode(texto);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  },

  /**
   * Lee un JSON del repo. Si no existe devuelve `porDefecto` (sha null).
   * Para archivos > 1 MB la API no incluye `content`, así que se pide el blob.
   * IMPORTANTE: la caché guarda su propia copia y se devuelve otra copia
   * distinta, para que el estado de la app nunca comparta objetos con la caché.
   */
  async leer(path, porDefecto) {
    const res = await fetch(`${this.url(path)}?ref=${CONFIG.BRANCH}`, { headers: this.headers(), cache: 'no-store' });
    if (res.status === 404) {
      this.cache[path] = { data: clonar(porDefecto), sha: null };
      return clonar(porDefecto);
    }
    if (res.status === 401 || res.status === 403) throw new Error('Token sin permisos o caducado. Revísalo en Ajustes.');
    if (!res.ok) throw new Error(`GitHub respondió ${res.status} al leer ${path}`);
    const json = await res.json();
    let texto;
    if (json.content) {
      texto = this.decode(json.content);
    } else {
      const blob = await fetch(json.git_url, { headers: this.headers(), cache: 'no-store' }).then((r) => r.json());
      texto = this.decode(blob.content);
    }
    const data = texto.trim() ? JSON.parse(texto) : porDefecto;
    this.cache[path] = { data: clonar(data), sha: json.sha };
    return clonar(data);
  },

  /**
   * Modifica un JSON del repo de forma segura:
   * aplica `mutar(data)` sobre una copia de la caché y hace commit.
   * Si hay conflicto (otro dispositivo escribió antes), relee y reintenta.
   * Las escrituras se encadenan en una cola para no pisarse entre sí.
   * Devuelve una COPIA del resultado (nunca el objeto de la caché).
   */
  actualizar(path, mutar, mensaje, porDefecto) {
    const tarea = async () => {
      for (let intento = 0; intento < 3; intento++) {
        if (!this.cache[path] || intento > 0) await this.leer(path, porDefecto);
        const copia = clonar(this.cache[path].data);
        const nuevo = mutar(copia) ?? copia;
        const body = {
          message: mensaje,
          content: this.encode(`${JSON.stringify(nuevo, null, 2)}\n`),
          branch: CONFIG.BRANCH,
        };
        if (this.cache[path].sha) body.sha = this.cache[path].sha;
        const res = await fetch(this.url(path), { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
        if (res.ok) {
          const json = await res.json();
          this.cache[path] = { data: clonar(nuevo), sha: json.content.sha };
          return clonar(nuevo);
        }
        if (res.status === 409 || res.status === 422) continue; // sha desactualizado: reintentar
        if (res.status === 401 || res.status === 403) throw new Error('El token no tiene permiso de escritura (Contents: Read and write).');
        throw new Error(`GitHub respondió ${res.status} al guardar ${path}`);
      }
      throw new Error('No se pudo guardar por conflictos repetidos. Recarga la app.');
    };
    const p = this.cola.then(tarea, tarea);
    this.cola = p.catch(() => {});
    return p;
  },
};

/**
 * Envuelve una operación de guardado: muestra el indicador, actualiza el
 * estado con el resultado y repinta. Si falla, avisa y recarga desde GitHub.
 */
async function guardar(operacion, mensajeOk) {
  setSync(true);
  try {
    await operacion();
    if (mensajeOk) toast(mensajeOk);
  } catch (e) {
    console.error(e);
    toast(e.message, 'error');
    await cargarTodo();
  } finally {
    setSync(false);
    renderTodo();
  }
}

/** Carga los cuatro archivos de datos en paralelo. */
async function cargarTodo() {
  if (!GH.token()) {
    abrirAjustes(true);
    return;
  }
  setSync(true);
  try {
    const [foods, days, measurements, settings] = await Promise.all([
      GH.leer(CONFIG.PATHS.foods, []),
      GH.leer(CONFIG.PATHS.days, {}),
      GH.leer(CONFIG.PATHS.measurements, []),
      GH.leer(CONFIG.PATHS.settings, {}),
    ]);
    // GH.leer ya devuelve copias, pero se clona igualmente por seguridad.
    state.foods = clonar(foods);
    state.days = limpiarDuplicados(clonar(days));
    state.measurements = clonar(measurements);
    state.settings = { objetivo_kcal: CONFIG.OBJETIVO_DEFECTO, altura_cm: CONFIG.ALTURA_CM, ...settings };
  } catch (e) {
    console.error(e);
    toast(e.message, 'error');
  } finally {
    setSync(false);
    renderTodo();
  }
}

/* ======================== Lógica del día e historial ======================== */

/**
 * Devuelve el registro del día activo. Si el día aún no existe en days.json
 * se devuelve uno vacío: así la pantalla arranca en cero cada día nuevo
 * sin borrar los días anteriores.
 */
function diaActual() {
  return state.days[state.fecha] || { objetivo_kcal: state.settings.objetivo_kcal, total_kcal: 0, entradas: [] };
}

/** Añade una entrada (comida o picoteo) al día activo y la guarda en GitHub. */
function añadirEntrada(entrada) {
  const fecha = state.fecha;
  const objetivo = state.settings.objetivo_kcal;
  const completa = { id: nuevoId(), hora: horaActual(), ...entrada, kcal: Math.round(entrada.kcal) };

  // Actualización optimista: solo toca `state` (que ya no comparte objetos con la caché).
  const dia = clonar(diaActual());
  dia.entradas.push(completa);
  dia.total_kcal = dia.entradas.reduce((s, e) => s + e.kcal, 0);
  state.days[fecha] = dia;
  renderHoy();

  return guardar(async () => {
    const resultado = await GH.actualizar(CONFIG.PATHS.days, (days) => {
      const d = days[fecha] || { objetivo_kcal: objetivo, total_kcal: 0, entradas: [] };
      // Idempotente: si por cualquier motivo la entrada ya está, no se vuelve a añadir.
      if (!d.entradas.some((e) => e.id === completa.id)) d.entradas.push(completa);
      d.total_kcal = d.entradas.reduce((s, e) => s + e.kcal, 0);
      days[fecha] = d;
      return days;
    }, `data: ${fecha} +${completa.kcal} kcal (${completa.nombre})`, {});
    state.days = limpiarDuplicados(resultado);
  });
}

/** Elimina una entrada del día activo. */
function borrarEntrada(id) {
  const fecha = state.fecha;
  return guardar(async () => {
    const resultado = await GH.actualizar(CONFIG.PATHS.days, (days) => {
      const d = days[fecha];
      if (!d) return days;
      d.entradas = d.entradas.filter((e) => e.id !== id);
      d.total_kcal = d.entradas.reduce((s, e) => s + e.kcal, 0);
      return days;
    }, `data: ${fecha} elimina entrada`, {});
    state.days = limpiarDuplicados(resultado);
  }, 'Entrada eliminada');
}

/** Módulo de picoteo: suma kcal directas sin registrar alimento. */
function picoteo(nivel) {
  const p = CONFIG.PICOTEO[nivel];
  añadirEntrada({ tipo: 'picoteo', nivel, nombre: p.etiqueta, kcal: p.kcal });
  toast(`+${p.kcal} kcal`);
}

/** Calcula kcal y macros de un alimento para una cantidad en gramos. */
function nutrientesPara(food, gramos) {
  const f = gramos / food.porcion_g;
  return {
    kcal: food.kcal * f,
    proteina_g: redondear((food.proteina_g || 0) * f),
    carbohidratos_g: redondear((food.carbohidratos_g || 0) * f),
    grasa_g: redondear((food.grasa_g || 0) * f),
  };
}

/** Registra el alimento seleccionado con los gramos indicados. */
function añadirComida() {
  const food = state.alimentoSeleccionado;
  const gramos = num(document.getElementById('inpGramos').value);
  if (!food) return toast('Elige un alimento', 'error');
  if (!gramos || gramos <= 0) return toast('Indica los gramos', 'error');
  añadirEntrada({ tipo: 'comida', food_id: food.id, nombre: food.nombre, cantidad_g: gramos, ...nutrientesPara(food, gramos) });
  state.alimentoSeleccionado = null;
  document.getElementById('inpBuscar').value = '';
  renderSelector();
  toast(`${food.nombre} añadido`);
}

/**
 * Vigila el cambio de día: si la fecha del sistema cambia (pasa la medianoche
 * con la app abierta o se vuelve a ella al día siguiente) se pasa al nuevo día,
 * que arranca en cero, y se recargan los datos.
 */
function vigilarCambioDeDia() {
  const comprobar = () => {
    const hoy = hoyISO();
    if (hoy !== state.fecha) {
      state.fecha = hoy;
      cargarTodo();
    }
  };
  setInterval(comprobar, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) comprobar(); });
}

/* ============================ Catálogo de alimentos ============================ */

/** Guarda (crea o reemplaza) un alimento en foods.json. */
function guardarAlimento(ev) {
  ev.preventDefault();
  const f = ev.target;
  const nombre = f.nombre.value.trim();
  const porcion = num(f.porcion_g.value);
  const kcal = num(f.kcal.value);
  if (!nombre || !porcion || porcion <= 0 || kcal === null || kcal < 0) {
    return toast('Nombre, porción y kcal son obligatorios', 'error');
  }
  const food = {
    id: f.dataset.editId || slug(nombre),
    nombre,
    porcion_g: porcion,
    kcal,
    proteina_g: num(f.proteina_g.value) ?? 0,
    carbohidratos_g: num(f.carbohidratos_g.value) ?? 0,
    grasa_g: num(f.grasa_g.value) ?? 0,
    fibra_g: num(f.fibra_g.value) ?? 0,
    categoria: f.categoria.value.trim() || 'Otros',
  };
  guardar(async () => {
    state.foods = await GH.actualizar(CONFIG.PATHS.foods, (foods) => {
      const i = foods.findIndex((x) => x.id === food.id);
      if (i >= 0) foods[i] = food; else foods.push(food);
      return foods.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    }, `data: alimento ${food.nombre}`, []);
    f.reset();
    delete f.dataset.editId;
    document.getElementById('btnGuardarAlimento').textContent = 'Guardar alimento';
  }, 'Alimento guardado');
}

/** Carga un alimento en el formulario para editarlo. */
function editarAlimento(id) {
  const food = state.foods.find((x) => x.id === id);
  if (!food) return;
  const f = document.getElementById('formAlimento');
  ['nombre', 'porcion_g', 'kcal', 'proteina_g', 'carbohidratos_g', 'grasa_g', 'fibra_g', 'categoria']
    .forEach((k) => { f[k].value = food[k] ?? ''; });
  f.dataset.editId = food.id;
  document.getElementById('btnGuardarAlimento').textContent = 'Actualizar alimento';
  f.scrollIntoView({ behavior: 'smooth' });
}

/** Elimina un alimento del catálogo (las entradas pasadas no se tocan). */
function borrarAlimento(id) {
  const food = state.foods.find((x) => x.id === id);
  if (!food || !confirm(`¿Eliminar "${food.nombre}" del catálogo?`)) return;
  guardar(async () => {
    state.foods = await GH.actualizar(CONFIG.PATHS.foods, (foods) => foods.filter((x) => x.id !== id),
      `data: elimina alimento ${food.nombre}`, []);
  }, 'Alimento eliminado');
}

/* ===================== Calculadora de la Marina de EE. UU. ===================== */

/**
 * Fórmula oficial de la Marina de EE. UU. para hombres (sistema métrico):
 *   %grasa = 495 / (1.0324 − 0.19077·log10(abdomen − cuello) + 0.15456·log10(altura)) − 450
 * El abdomen se mide a la altura del ombligo. La cintura se guarda solo como seguimiento.
 * Devuelve null si las medidas no permiten el cálculo.
 */
function grasaMarinaHombre(ombligoCm, cuelloCm, alturaCm = CONFIG.ALTURA_CM) {
  if (!ombligoCm || !cuelloCm || !alturaCm || ombligoCm <= cuelloCm) return null;
  const pct = 495 / (1.0324 - 0.19077 * Math.log10(ombligoCm - cuelloCm) + 0.15456 * Math.log10(alturaCm)) - 450;
  return Number.isFinite(pct) && pct > 0 ? redondear(pct, 1) : null;
}

/** Lee el formulario de medidas y muestra el % de grasa en vivo. */
function previsualizarGrasa() {
  const f = document.getElementById('formMedidas');
  const pct = grasaMarinaHombre(num(f.ombligo_cm.value), num(f.cuello_cm.value));
  const peso = num(f.peso_kg.value);
  const out = document.getElementById('grasaPreview');
  if (pct === null) {
    out.innerHTML = '<span class="text-slate-500">Introduce ombligo y cuello</span>';
    return;
  }
  const masaGrasa = peso ? redondear(peso * pct / 100, 1) : null;
  out.innerHTML = `<span class="text-3xl font-bold text-emerald-400">${pct}%</span>
    <span class="block text-xs text-slate-400 mt-1">${masaGrasa !== null ? `${masaGrasa} kg grasa, ${redondear(peso - masaGrasa, 1)} kg masa magra` : 'grasa corporal'}</span>`;
}

/** Guarda el registro de medidas del día (si ya existe uno ese día, lo reemplaza). */
function guardarMedidas(ev) {
  ev.preventDefault();
  const f = ev.target;
  const registro = {
    fecha: state.fecha,
    peso_kg: num(f.peso_kg.value),
    cintura_cm: num(f.cintura_cm.value),
    ombligo_cm: num(f.ombligo_cm.value),
    cuello_cm: num(f.cuello_cm.value),
    altura_cm: CONFIG.ALTURA_CM,
  };
  if (!registro.peso_kg || !registro.ombligo_cm || !registro.cuello_cm) {
    return toast('Peso, ombligo y cuello son obligatorios', 'error');
  }
  registro.grasa_pct = grasaMarinaHombre(registro.ombligo_cm, registro.cuello_cm);
  if (registro.grasa_pct === null) return toast('Revisa las medidas: el ombligo debe ser mayor que el cuello', 'error');
  registro.metodo = 'US_NAVY_HOMBRE';

  guardar(async () => {
    state.measurements = await GH.actualizar(CONFIG.PATHS.measurements, (lista) => {
      const sin = lista.filter((m) => m.fecha !== registro.fecha);
      sin.push(registro);
      return sin.sort((a, b) => a.fecha.localeCompare(b.fecha));
    }, `data: medidas ${registro.fecha} (${registro.peso_kg} kg, ${registro.grasa_pct}%)`, []);
    f.reset();
    previsualizarGrasa();
  }, 'Medidas guardadas');
}

/** Elimina el registro de medidas de una fecha. */
function borrarMedida(fecha) {
  if (!confirm(`¿Eliminar las medidas del ${fechaLegible(fecha, { day: 'numeric', month: 'short', year: 'numeric' })}?`)) return;
  guardar(async () => {
    state.measurements = await GH.actualizar(CONFIG.PATHS.measurements, (lista) => lista.filter((m) => m.fecha !== fecha),
      `data: elimina medidas ${fecha}`, []);
  }, 'Registro eliminado');
}

/* =================================== Ajustes =================================== */

/** Abre el panel de ajustes. `obligatorio` se usa cuando aún no hay token. */
function abrirAjustes(obligatorio = false) {
  const m = document.getElementById('modalAjustes');
  document.getElementById('inpToken').value = GH.token();
  document.getElementById('inpObjetivo').value = state.settings.objetivo_kcal;
  document.getElementById('ajustesAviso').classList.toggle('hidden', !obligatorio);
  m.classList.remove('hidden');
}

function cerrarAjustes() {
  document.getElementById('modalAjustes').classList.add('hidden');
}

/** Guarda el token (local) y el objetivo diario (en settings.json). */
async function guardarAjustes(ev) {
  ev.preventDefault();
  const token = document.getElementById('inpToken').value.trim();
  const objetivo = num(document.getElementById('inpObjetivo').value);
  const tokenCambiado = token !== GH.token();
  try { localStorage.setItem(CONFIG.LS_TOKEN, token); } catch { /* modo privado */ }
  cerrarAjustes();
  if (tokenCambiado) {
    GH.cache = {};
    await cargarTodo();
  }
  if (objetivo && objetivo > 0 && objetivo !== state.settings.objetivo_kcal) {
    guardar(async () => {
      state.settings = await GH.actualizar(CONFIG.PATHS.settings, (s) => ({ ...s, objetivo_kcal: objetivo, altura_cm: CONFIG.ALTURA_CM }),
        `data: objetivo ${objetivo} kcal`, {});
    }, 'Objetivo actualizado');
  }
}

/* =================================== Render =================================== */

/** Pinta el resumen del día, la barra de progreso y la lista de entradas. */
function renderHoy() {
  const dia = diaActual();
  const objetivo = state.settings.objetivo_kcal;
  const total = dia.total_kcal;
  const restante = objetivo - total;
  const pct = Math.min(100, Math.round((total / objetivo) * 100));

  const fl = fechaLegible(state.fecha);
  document.getElementById('fechaHoy').textContent = fl.charAt(0).toUpperCase() + fl.slice(1);
  document.getElementById('kcalTotal').textContent = total;
  document.getElementById('kcalObjetivo').textContent = objetivo;
  const rest = document.getElementById('kcalRestante');
  rest.textContent = restante >= 0 ? `Te quedan ${restante} kcal` : `Te has pasado ${-restante} kcal`;
  rest.className = `text-sm font-semibold ${restante >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
  const barra = document.getElementById('barraKcal');
  barra.style.width = `${pct}%`;
  barra.className = `h-full rounded-full transition-all ${pct < 85 ? 'bg-emerald-500' : pct <= 100 && restante >= 0 ? 'bg-amber-400' : 'bg-red-500'}`;

  // Macros del día (solo de comidas registradas)
  const macros = dia.entradas.reduce((acc, e) => {
    acc.p += e.proteina_g || 0; acc.c += e.carbohidratos_g || 0; acc.g += e.grasa_g || 0; return acc;
  }, { p: 0, c: 0, g: 0 });
  document.getElementById('macros').textContent =
    `P ${redondear(macros.p, 0)} g | C ${redondear(macros.c, 0)} g | G ${redondear(macros.g, 0)} g`;

  const lista = document.getElementById('listaEntradas');
  if (!dia.entradas.length) {
    lista.innerHTML = '<li class="text-center text-slate-500 py-6">Aún no hay registros hoy</li>';
    return;
  }
  const colores = { verde: 'bg-emerald-500', amarillo: 'bg-amber-400', rojo: 'bg-red-500' };
  lista.innerHTML = [...dia.entradas].reverse().map((e) => `
    <li class="flex items-center gap-3 py-3">
      <span class="w-2.5 h-2.5 rounded-full shrink-0 ${e.tipo === 'picoteo' ? colores[e.nivel] : 'bg-sky-400'}"></span>
      <div class="flex-1 min-w-0">
        <p class="truncate font-medium">${esc(e.nombre)}</p>
        <p class="text-xs text-slate-400">${esc(e.hora)}${e.cantidad_g ? ` | ${e.cantidad_g} g` : ''}</p>
      </div>
      <span class="font-semibold tabular-nums">${e.kcal}</span>
      <button data-borrar-entrada="${esc(e.id)}" class="h-11 w-11 rounded-xl bg-slate-800 active:bg-slate-700 text-slate-400" aria-label="Eliminar">✕</button>
    </li>`).join('');
}

/** Pinta los resultados del buscador de alimentos y el panel de cantidad. */
function renderSelector() {
  const q = slug(document.getElementById('inpBuscar').value);
  const cont = document.getElementById('resultadosBusqueda');
  const panel = document.getElementById('panelCantidad');
  const sel = state.alimentoSeleccionado;

  if (sel) {
    cont.innerHTML = '';
    panel.classList.remove('hidden');
    document.getElementById('selNombre').textContent = sel.nombre;
    document.getElementById('selInfo').textContent = `${sel.kcal} kcal por ${sel.porcion_g} g`;
    actualizarPreviewKcal();
    return;
  }
  panel.classList.add('hidden');
  const resultados = (q ? state.foods.filter((f) => slug(f.nombre).includes(q)) : state.foods).slice(0, 8);
  cont.innerHTML = resultados.length
    ? resultados.map((f) => `
      <button data-elegir="${esc(f.id)}" class="w-full text-left px-4 py-3 rounded-xl bg-slate-800 active:bg-slate-700 flex justify-between gap-2">
        <span class="truncate">${esc(f.nombre)}</span>
        <span class="text-xs text-slate-400 shrink-0">${f.kcal} kcal / ${f.porcion_g} g</span>
      </button>`).join('')
    : '<p class="text-sm text-slate-500 px-1">Sin resultados. Créalo en la pestaña Alimentos.</p>';
}

/** Calcula en vivo las kcal del alimento seleccionado según los gramos. */
function actualizarPreviewKcal() {
  const sel = state.alimentoSeleccionado;
  const g = num(document.getElementById('inpGramos').value);
  document.getElementById('previewKcal').textContent = sel && g > 0 ? `${Math.round(nutrientesPara(sel, g).kcal)} kcal` : '';
}

/** Pinta la lista del catálogo de alimentos. */
function renderAlimentos() {
  const lista = document.getElementById('listaAlimentos');
  document.getElementById('numAlimentos').textContent = state.foods.length;
  lista.innerHTML = state.foods.map((f) => `
    <li class="flex items-center gap-2 py-3">
      <div class="flex-1 min-w-0">
        <p class="truncate font-medium">${esc(f.nombre)}</p>
        <p class="text-xs text-slate-400">${f.kcal} kcal / ${f.porcion_g} g | P ${f.proteina_g} C ${f.carbohidratos_g} G ${f.grasa_g} | ${esc(f.categoria)}</p>
      </div>
      <button data-editar-alimento="${esc(f.id)}" class="h-11 w-11 rounded-xl bg-slate-800 active:bg-slate-700" aria-label="Editar">✎</button>
      <button data-borrar-alimento="${esc(f.id)}" class="h-11 w-11 rounded-xl bg-slate-800 active:bg-slate-700 text-slate-400" aria-label="Eliminar">✕</button>
    </li>`).join('') || '<li class="text-center text-slate-500 py-6">Catálogo vacío</li>';
}

/** Pinta la pestaña de progreso: gráfica, mediciones e historial de kcal. */
function renderProgreso() {
  // Lista de mediciones (más recientes primero)
  const lm = document.getElementById('listaMedidas');
  lm.innerHTML = [...state.measurements].reverse().map((m) => `
    <li class="flex items-center gap-3 py-3">
      <div class="flex-1 min-w-0">
        <p class="font-medium">${fechaLegible(m.fecha, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
        <p class="text-xs text-slate-400">Cintura ${m.cintura_cm ?? '-'} | Ombligo ${m.ombligo_cm} | Cuello ${m.cuello_cm} cm</p>
      </div>
      <div class="text-right">
        <p class="font-semibold tabular-nums">${m.peso_kg} kg</p>
        <p class="text-xs text-emerald-400 tabular-nums">${m.grasa_pct}%</p>
      </div>
      <button data-borrar-medida="${esc(m.fecha)}" class="h-11 w-11 rounded-xl bg-slate-800 active:bg-slate-700 text-slate-400" aria-label="Eliminar">✕</button>
    </li>`).join('') || '<li class="text-center text-slate-500 py-6">Sin mediciones todavía</li>';

  // Historial de kcal de los últimos 14 días registrados
  const lh = document.getElementById('listaHistorial');
  const fechas = Object.keys(state.days).sort().reverse().slice(0, 14);
  lh.innerHTML = fechas.map((f) => {
    const d = state.days[f];
    const obj = d.objetivo_kcal || state.settings.objetivo_kcal;
    const dif = obj - d.total_kcal;
    return `<li class="flex justify-between py-2.5">
      <span class="${f === state.fecha ? 'text-emerald-400 font-semibold' : ''}">${fechaLegible(f, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
      <span class="tabular-nums">${d.total_kcal} / ${obj}
        <span class="ml-2 text-xs ${dif >= 0 ? 'text-emerald-400' : 'text-red-400'}">${dif >= 0 ? '-' : '+'}${Math.abs(dif)}</span></span>
    </li>`;
  }).join('') || '<li class="text-center text-slate-500 py-6">Sin días registrados</li>';

  renderGrafica();
}

/** Dibuja (o redibuja) la gráfica de evolución de peso y % de grasa con Chart.js. */
function renderGrafica() {
  const canvas = document.getElementById('graficaProgreso');
  const vacio = document.getElementById('graficaVacia');
  const datos = state.measurements;
  vacio.classList.toggle('hidden', datos.length > 0);
  canvas.classList.toggle('hidden', datos.length === 0);
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  if (!datos.length || typeof Chart === 'undefined') return;

  state.chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: datos.map((m) => fechaLegible(m.fecha, { day: 'numeric', month: 'short' })),
      datasets: [
        { label: 'Peso (kg)', data: datos.map((m) => m.peso_kg), borderColor: '#38bdf8', backgroundColor: '#38bdf8',
          yAxisID: 'yPeso', tension: 0.3, pointRadius: 4 },
        { label: 'Grasa (%)', data: datos.map((m) => m.grasa_pct), borderColor: '#34d399', backgroundColor: '#34d399',
          yAxisID: 'yGrasa', tension: 0.3, pointRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: '#cbd5e1', boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true }, grid: { color: '#1e293b' } },
        yPeso: { position: 'left', ticks: { color: '#38bdf8' }, grid: { color: '#1e293b' } },
        yGrasa: { position: 'right', ticks: { color: '#34d399', callback: (v) => `${v}%` }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

function renderTodo() {
  renderHoy();
  renderSelector();
  renderAlimentos();
  if (!document.getElementById('tab-progreso').classList.contains('hidden')) renderProgreso();
}

/** Cambia de pestaña en la navegación inferior. */
function cambiarTab(nombre) {
  document.querySelectorAll('[data-tab-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.tabPanel !== nombre));
  document.querySelectorAll('[data-tab]').forEach((b) => {
    const activo = b.dataset.tab === nombre;
    b.classList.toggle('text-emerald-400', activo);
    b.classList.toggle('text-slate-400', !activo);
  });
  if (nombre === 'progreso') renderProgreso();
  window.scrollTo({ top: 0 });
}

/* ================================== Eventos ================================== */

function enlazarEventos() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => cambiarTab(b.dataset.tab)));
  document.querySelectorAll('[data-picoteo]').forEach((b) => b.addEventListener('click', () => picoteo(b.dataset.picoteo)));

  document.getElementById('inpBuscar').addEventListener('input', () => {
    state.alimentoSeleccionado = null;
    renderSelector();
  });
  document.getElementById('inpGramos').addEventListener('input', actualizarPreviewKcal);
  document.getElementById('btnAñadirComida').addEventListener('click', añadirComida);
  document.getElementById('btnCancelarSel').addEventListener('click', () => {
    state.alimentoSeleccionado = null;
    renderSelector();
  });

  document.getElementById('formAlimento').addEventListener('submit', guardarAlimento);
  document.getElementById('formMedidas').addEventListener('submit', guardarMedidas);
  document.getElementById('formMedidas').addEventListener('input', previsualizarGrasa);
  document.getElementById('formAjustes').addEventListener('submit', guardarAjustes);
  document.getElementById('btnAjustes').addEventListener('click', () => abrirAjustes(false));
  document.getElementById('btnCerrarAjustes').addEventListener('click', cerrarAjustes);
  document.getElementById('btnRecargar').addEventListener('click', () => { GH.cache = {}; cargarTodo(); });

  // Delegación de eventos para los botones generados dinámicamente
  document.body.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.borrarEntrada) borrarEntrada(b.dataset.borrarEntrada);
    else if (b.dataset.elegir) {
      state.alimentoSeleccionado = state.foods.find((f) => f.id === b.dataset.elegir) || null;
      if (state.alimentoSeleccionado) document.getElementById('inpGramos').value = state.alimentoSeleccionado.porcion_g;
      renderSelector();
    } else if (b.dataset.editarAlimento) editarAlimento(b.dataset.editarAlimento);
    else if (b.dataset.borrarAlimento) borrarAlimento(b.dataset.borrarAlimento);
    else if (b.dataset.borrarMedida) borrarMedida(b.dataset.borrarMedida);
  });
}

/* =================================== Inicio =================================== */

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('alturaFija').textContent = CONFIG.ALTURA_CM;
  enlazarEventos();
  renderTodo();
  previsualizarGrasa();
  vigilarCambioDeDia();
  cargarTodo();
});
