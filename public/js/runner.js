// Envoltura de webR: inicialización, ejecución con captura de texto y gráficos,
// instalación de paquetes, interrupción y cola de ejecución secuencial.

async function condMessage(obj) {
  if (typeof obj === 'string') return obj;
  try {
    const m = await obj.get('message');
    const arr = await m.toArray();
    return String(arr[0] ?? '');
  } catch {
    try { return String(await obj.toString()); } catch { return String(obj); }
  }
}

function bitmapToDataURL(bmp) {
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  try { bmp.close?.(); } catch { /* ignore */ }
  return c.toDataURL('image/png');
}

export class RRunner {
  constructor({ onStatus = () => {}, ...cfg } = {}) {
    this.onStatus = onStatus;
    this.configure(cfg);
    this.webR = null;
    this.ready = null;
    this.queue = Promise.resolve();
    this.installed = new Set();
    this.busy = 0;
  }

  /** Configuración de webR enviada por el servidor: { baseUrl, repoUrl, module } */
  configure({ baseUrl, repoUrl, module } = {}) {
    if (this.webR) return;
    this.baseUrl = (baseUrl || this.baseUrl || '/vendor/webr/').replace(/\/?$/, '/');
    this.repoUrl = repoUrl || this.repoUrl || 'https://repo.r-wasm.org/';
    this.module = module || this.module || `${this.baseUrl}webr.js`;
  }

  init() {
    if (this.ready) return this.ready;
    this.onStatus('loading', 'Cargando R…');
    this.ready = (async () => {
      const { WebR } = await import(this.module);
      this.webR = new WebR({ baseUrl: this.baseUrl, repoUrl: this.repoUrl });
      await this.webR.init();
      // Opciones de presentación más legibles en clase
      await this.webR.evalRVoid('options(width = 90, digits = 6, warn = 1)');
      // Permite usar install.packages("x") en las celdas: lo redirige a webr::install()
      // (repositorio de binarios WebAssembly). Ver https://docs.r-wasm.org/webr/latest/packages.html
      try { await this.webR.evalRVoid('webr::shim_install()'); } catch { /* versión sin shim */ }
      this.onStatus('ready', 'R listo');
      return this;
    })().catch(err => {
      this.onStatus('error', 'R no disponible');
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  /** Ejecuta código R en cola; devuelve { lines, images, ms, error } */
  run(code, opts) {
    const job = this.queue.then(() => this._run(code, opts));
    this.queue = job.catch(() => {});
    return job;
  }

  async _run(code, { width = 800, height = 560 } = {}) {
    await this.init();
    this.busy++;
    this.onStatus('busy', 'Ejecutando…');
    const t0 = performance.now();
    const lines = [], images = [];
    let error = false;
    const shelter = await new this.webR.Shelter();
    try {
      const res = await shelter.captureR(code, {
        withAutoprint: true,
        captureStreams: true,
        captureConditions: true,
        captureGraphics: { width, height },
        throwJsException: false,
      });
      for (const o of res.output) {
        if (o.type === 'stdout') lines.push({ t: 'out', d: o.data });
        else if (o.type === 'stderr') lines.push({ t: 'err', d: o.data });
        else {
          const msg = (await condMessage(o.data)).replace(/\n$/, '');
          if (o.type === 'message') lines.push({ t: 'msg', d: msg });
          else if (o.type === 'warning') lines.push({ t: 'warn', d: `Advertencia: ${msg}` });
          else if (o.type === 'error') { error = true; lines.push({ t: 'err', d: `Error: ${msg}` }); }
        }
      }
      for (const bmp of res.images || []) images.push(bitmapToDataURL(bmp));
    } catch (e) {
      error = true;
      lines.push({ t: 'err', d: `Error: ${e?.message || e}` });
    } finally {
      try { await shelter.purge(); } catch { /* ignore */ }
      this.busy--;
      if (!this.busy) this.onStatus('ready', 'R listo');
    }
    return { lines, images, ms: Math.round(performance.now() - t0), error };
  }

  interrupt() {
    try { this.webR?.interrupt(); } catch { /* ignore */ }
  }

  /** Instala paquetes desde el repositorio webR. log(msg, tipo) */
  async installPackages(pkgs, log = () => {}) {
    await this.init();
    const done = [];
    for (const p of pkgs) {
      if (this.installed.has(p)) { done.push(p); continue; }
      log(`▶ Instalando «${p}»…`, 'info');
      this.onStatus('busy', `Instalando ${p}…`);
      try {
        await this.webR.installPackages([p], { mount: true, quiet: true });
        // Verificar que realmente quedó disponible
        const name = p.replace(/[^A-Za-z0-9.]/g, '');
        const ok = await this.webR.evalRString(`if (isTRUE(suppressWarnings(requireNamespace("${name}", quietly = TRUE)))) "si" else "no"`);
        if (ok !== 'si') throw new Error('no se pudo instalar: verifique el nombre, que exista en repo.r-wasm.org y su conexión a internet');
        this.installed.add(p);
        done.push(p);
        log(`✔ «${p}» instalado.`, 'ok');
      } catch (e) {
        log(`✘ «${p}»: ${e?.message || e}`, 'err');
      }
    }
    this.onStatus('ready', 'R listo');
    return done;
  }
}
