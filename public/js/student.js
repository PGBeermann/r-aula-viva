// Interfaz del ESTUDIANTE: sigue en vivo el cuaderno del docente y dispone de
// un espacio personal donde puede ejecutar R en su propio navegador (webR).
import { $, esc, icons, uid, debounce, toast, modal, download, copyText, fmtTime, fileStamp, slugify, store } from './util.js';
import { NotebookView } from './notebook.js';
import { RRunner } from './runner.js';
import { toJSON, toR, toHTML, parseNotebookFile } from './render.js';
import { setFontSize } from './shell.js';

export function setup(ctx) {
  const { socket, panel, code, name } = ctx;
  let S = null;
  let follow = store.get('rav:follow', true);
  let hand = null;
  let myQuestions = [];
  let pollHidden = null;   // id de encuesta cerrada que el estudiante ocultó
  let pollMin = null;      // id de encuesta minimizada

  $('#role-label').textContent = `Estudiante · ${name}`;

  // ── Cuaderno del docente (sólo lectura) ──
  const nb = new NotebookView($('#notebook'), {
    editable: false,
    cellActions: d => d.type === 'markdown' ? '' : `
      <button class="btn ghost sm" data-act="copy" title="Copiar código"><i data-lucide="copy"></i></button>
      <button class="btn ghost sm" data-act="mine" title="Llevar a «Mi espacio» para ejecutarlo y modificarlo"><i data-lucide="flask-conical"></i><span class="lbl">Probar</span></button>`,
    onAction: (act, id) => {
      const c = nb.get(id);
      if (act === 'copy') copyText(c.code);
      if (act === 'mine') {
        if (!S.settings.allowLocalRun) return toast('El docente desactivó la ejecución local por ahora', 'err');
        const nid = scratchAdd(c.code);
        panel.show('mine');
        setTimeout(() => { scratchRun(nid); document.getElementById(`cell-${nid}`)?.scrollIntoView({ block: 'nearest' }); }, 60);
      }
    },
  });
  ctx.nb = nb;

  // ── Barra de herramientas ──
  const EMOJIS = [['👍', 'De acuerdo'], ['👏', 'Aplauso'], ['🤔', 'Tengo dudas'], ['😕', 'No entiendo'], ['🐢', 'Más despacio'], ['🚀', '¡Listo!']];
  $('#toolbar').innerHTML = `
    <button class="btn ${follow ? 'on' : ''}" id="btn-follow" title="Desplazarse automáticamente a donde escribe el docente"><i data-lucide="crosshair"></i><span class="lbl">Seguir al docente</span></button>
    <button class="btn icon" id="btn-fsm" title="Reducir letra"><i data-lucide="a-arrow-down"></i></button>
    <button class="btn icon" id="btn-fsp" title="Aumentar letra"><i data-lucide="a-arrow-up"></i></button>
    <span class="sep"></span>
    <button class="btn" id="btn-hand"><i data-lucide="hand"></i><span class="lbl">Levantar la mano</span></button>
    <div class="emoji-bar">${EMOJIS.map(([e, t]) => `<button data-e="${e}" title="${t}">${e}</button>`).join('')}</div>
    <span class="sep"></span>
    <button class="btn" id="btn-open" title="Abrir un archivo .R, .Rmd o .json de su computadora en «Mi espacio»"><i data-lucide="folder-open"></i><span class="lbl">Abrir archivo</span></button>
    <button class="btn" id="btn-dl"><i data-lucide="download"></i><span class="lbl">Descargar</span></button>
    <span class="spacer"></span>
    <button class="btn" id="btn-panel"><i data-lucide="panel-right"></i><span class="lbl">Mi espacio</span></button>`;
  $('#btn-follow').onclick = () => {
    follow = !follow;
    store.set('rav:follow', follow);
    $('#btn-follow').classList.toggle('on', follow);
    if (follow && S?.focus) nb.setFocus(S.focus, { follow: true });
  };
  $('#btn-fsm').onclick = () => { setFontSize(-1, nb); scratch.refreshAll(); };
  $('#btn-fsp').onclick = () => { setFontSize(1, nb); scratch.refreshAll(); };
  $('#btn-hand').onclick = () => socket.emit('hand', !hand);
  $('#btn-panel').onclick = () => panel.toggle();
  $('#btn-dl').onclick = downloadModal;
  $('#btn-open').onclick = () => { panel.show('mine'); pickLocalFile(); };
  let lastReact = 0;
  $('#toolbar').querySelectorAll('[data-e]').forEach(b => b.onclick = () => {
    if (Date.now() - lastReact < 1500) return;
    lastReact = Date.now();
    socket.emit('react', b.dataset.e);
    toast(`${b.dataset.e} enviado al docente`, '', 1200);
  });
  // Si el estudiante se desplaza manualmente hacia arriba/abajo, se pausa el seguimiento
  let userScrollT = 0;
  window.addEventListener('wheel', () => { userScrollT = Date.now(); }, { passive: true });
  window.addEventListener('touchmove', () => { userScrollT = Date.now(); }, { passive: true });

  function setHand(v) {
    hand = v;
    const b = $('#btn-hand');
    b.classList.toggle('hand-on', !!v);
    b.querySelector('.lbl').textContent = v ? 'Bajar la mano' : 'Levantar la mano';
  }

  function applySettings() {
    $('#btn-dl').classList.toggle('hidden', !S.settings.allowDownload);
    panel.refresh();
  }

  // ── Eventos del servidor ──
  socket.on('state', s => {
    S = s;
    myQuestions = s.questions || [];
    nb.setAll(s.cells);
    if (s.focus) nb.setFocus(s.focus, { follow });
    applySettings();
    renderPoll();
    icons();
  });
  socket.on('cell:add', ({ afterId, cell }) => { if (!nb.has(cell.id)) nb.add(cell, afterId); });
  socket.on('cell:update', ({ id, code: src }) => {
    nb.update(id, src);
    if (S.focus?.id === id) nb.setFocus(S.focus, { follow: false });
  });
  socket.on('cell:delete', ({ id }) => nb.remove(id));
  socket.on('cell:move', ({ id, dir }) => nb.move(id, dir));
  socket.on('cell:type', ({ id, type }) => nb.setType(id, type));
  socket.on('cell:running', ({ id }) => nb.setRunning(id, 'Ejecutando en el equipo del docente…'));
  socket.on('cell:output', ({ id, output, execCount }) => nb.setOutput(id, output, execCount));
  socket.on('cells:clearOutputs', () => nb.clearOutputs());
  socket.on('notebook:replace', ({ cells }) => { nb.setAll(cells); window.scrollTo({ top: 0 }); toast('El docente cargó un nuevo cuaderno'); });
  socket.on('focus', f => {
    S.focus = f;
    nb.setFocus(f, { follow: follow && Date.now() - userScrollT > 2500 });
  });
  socket.on('settings', st => { S.settings = st; applySettings(); });
  socket.on('packages', list => { S.packages = list; if (panel.active === 'mine') panel.refresh('mine'); });
  socket.on('hand', setHand);
  socket.on('question:mine', q => {
    const i = myQuestions.findIndex(x => x.id === q.id);
    if (i >= 0) {
      if (q.answer && q.answer !== myQuestions[i].answer) toast('💬 El docente respondió su pregunta', 'ok', 5000);
      myQuestions[i] = q;
    } else myQuestions.push(q);
    const unread = myQuestions.filter(x => x.answer && !x._seen).length;
    panel.badge('questions', panel.isActive('questions') ? 0 : unread);
    panel.refresh('questions');
  });
  socket.on('submit:ok', () => toast('✔ Código enviado al docente', 'ok'));
  socket.on('poll', p => { S.poll = p; renderPoll(); });

  // ── Encuesta flotante ──
  function renderPoll() {
    const el = $('#poll-float');
    const p = S?.poll;
    if (!p || (!p.open && pollHidden === p.id)) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const r = p.results;
    el.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:4px">
        <span class="small muted"><i data-lucide="chart-bar"></i> ${p.open ? 'Encuesta' : 'Resultados'}</span>
        <span class="row" style="gap:2px">
          <button class="btn ghost icon" data-min title="${pollMin === p.id ? 'Mostrar' : 'Minimizar'}"><i data-lucide="${pollMin === p.id ? 'chevron-up' : 'chevron-down'}"></i></button>
          ${!p.open ? '<button class="btn ghost icon" data-x title="Cerrar"><i data-lucide="x"></i></button>' : ''}
        </span>
      </div>
      <div ${pollMin === p.id ? 'class="hidden"' : ''}>
      <h3>${esc(p.question)}</h3>
      ${p.options.map((o, i) => {
        if (r) {
          const pct = r.total ? Math.round(100 * r.counts[i] / r.total) : 0;
          return `<div class="small">${p.myVote === i ? '✔ ' : ''}${esc(o)}</div><div class="bar"><div style="width:${pct}%"></div><span>${pct}%</span></div>`;
        }
        return `<button class="btn poll-opt ${p.myVote === i ? 'chosen' : ''}" data-o="${i}" ${p.open ? '' : 'disabled'}>${esc(o)}</button>`;
      }).join('')}
      ${r && p.open ? `<div class="row" style="flex-wrap:wrap;margin-top:4px">${p.options.map((o, i) => `<button class="btn sm ${p.myVote === i ? 'chosen on' : ''}" data-o="${i}">${esc(o)}</button>`).join('')}</div>` : ''}
      <p class="small muted" style="margin:6px 0 0">${p.open ? (p.myVote !== null ? 'Respuesta registrada. Puede cambiarla mientras esté abierta.' : 'Seleccione una opción.') : `${r?.total ?? 0} respuesta(s).`}</p>
      </div>`;
    el.querySelector('[data-min]').onclick = () => { pollMin = pollMin === p.id ? null : p.id; renderPoll(); };
    el.querySelectorAll('[data-o]').forEach(b => b.onclick = () => socket.emit('poll:vote', { id: p.id, option: +b.dataset.o }));
    el.querySelector('[data-x]')?.addEventListener('click', () => { pollHidden = p.id; renderPoll(); });
    icons(el);
  }

  // ── Mi espacio (ejecución local con webR) ──
  const scratchKey = `rav:scratch:${code}`;
  let localRunner = null;
  let rState = 'off';
  const rChip = $('#r-chip');
  const getRunner = () => {
    if (!localRunner) {
      rChip.classList.remove('hidden');
      localRunner = new RRunner({
        ...(S.webr || {}),
        onStatus: (st, label) => {
          rState = st;
          rChip.className = `chip ${st === 'ready' ? 'ok' : st === 'error' ? 'bad' : 'busy'}`;
          $('#r-label').textContent = `Mi R: ${label}`;
          const s = document.getElementById('mine-status');
          if (s) s.textContent = label;
        },
      });
      localRunner.init()
        .then(() => S.packages?.length && localRunner.installPackages(S.packages, m => console.log(`[paquetes] ${m}`)))
        .catch(e => toast(`No se pudo iniciar R en este navegador: ${e.message}`, 'err', 8000));
    }
    return localRunner;
  };

  const saveScratch = debounce(() => store.set(scratchKey, scratch.list.map(c => ({
    id: c.id, type: c.type, code: c.code,
    output: c.output ? { ...c.output, images: [] } : null, execCount: c.execCount,  // sin imágenes para no llenar el almacenamiento
  }))), 400);

  const scratchHost = document.createElement('div');
  scratchHost.className = 'notebook';
  scratchHost.style.gap = '10px';
  let localCount = 0;
  const scratch = new NotebookView(scratchHost, {
    editable: true,
    noMove: true,
    extraActions: d => (d.type === 'code' ? ['<button class="btn ghost sm" data-act="send" title="Enviar este código al docente"><i data-lucide="send"></i></button>'] : []),
    onChange: () => saveScratch(),
    onRun: id => scratchRun(id),
    onAdd: (afterId, type) => { const c = { id: uid('m'), type, code: '' }; scratch.add(c, afterId, { edit: true }); saveScratch(); },
    onDelete: id => { scratch.remove(id); saveScratch(); },
    onType: (id, type) => { scratch.setType(id, type); saveScratch(); },
    onAction: (act, id) => { if (act === 'send') sendToTeacher(id); },
  });
  const saved = store.get(scratchKey, null);
  scratch.setAll(saved?.length ? saved : [{ id: uid('m'), type: 'code', code: '# Su espacio personal: practique aquí.\n# El código se ejecuta en SU navegador.\nx <- c(2.1, 2.4, 1.9, 2.6)\nmean(x)' }]);

  function scratchAdd(src) {
    const c = { id: uid('m'), type: 'code', code: src };
    scratch.add(c, scratch.list.at(-1)?.id || null);
    saveScratch();
    return c.id;
  }

  async function scratchRun(id) {
    if (!S.settings.allowLocalRun) return toast('El docente desactivó la ejecución local por ahora', 'err');
    const c = scratch.get(id);
    if (!c || c.type !== 'code') { scratch.setEditing(id, false); return; }
    scratch.setRunning(id, rState === 'ready' ? 'Ejecutando en su navegador…' : 'Iniciando R en su navegador (la primera vez tarda unos segundos)…');
    const out = await getRunner().run(c.code);
    scratch.setOutput(id, out, ++localCount);
    saveScratch();
  }

  function sendToTeacher(id) {
    if (!S.settings.allowSubmissions) return toast('El docente no está recibiendo entregas en este momento', 'err');
    const c = scratch.get(id);
    if (!c?.code.trim()) return toast('La celda está vacía', 'err');
    const m = modal({
      title: 'Enviar código al docente', icon: 'send',
      body: `<pre class="output-text" style="max-height:220px">${esc(c.code)}</pre>
             <div class="field" style="margin-top:10px"><label>Comentario (opcional)</label><input class="input" id="nt" maxlength="300" placeholder="Ej.: ¿por qué me da error en la línea 3?"></div>`,
      foot: '<button class="btn primary" id="snd"><i data-lucide="send"></i> Enviar</button>',
    });
    m.el.querySelector('#snd').onclick = () => {
      const outputText = (c.output?.lines || []).map(l => l.d).join('\n').slice(0, 8000);
      socket.emit('submit', { code: c.code, note: m.el.querySelector('#nt').value, outputText });
      m.close();
    };
  }

  // ── Panel lateral ──
  const guard = fn => el => (S ? fn(el) : (el.innerHTML = '<div class="empty-state">Conectando…</div>'));
  panel.define([
    { id: 'mine', label: 'Mi espacio', icon: 'flask-conical', render: guard(renderMine) },
    { id: 'questions', label: 'Preguntas', icon: 'message-circle-question', render: guard(renderQuestions) },
    { id: 'help', label: 'Ayuda', icon: 'circle-help', render: guard(renderHelp) },
  ]);

  function renderMine(el) {
    const wide = store.get('rav:wide', false);
    document.documentElement.style.setProperty('--panel-w', wide ? 'min(52vw, 760px)' : '380px');
    el.innerHTML = `
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <span class="small muted">R local: <b id="mine-status">${localRunner ? esc($('#r-label').textContent.replace('Mi R: ', '')) : 'sin iniciar'}</b></span>
        <div class="row">
          <button class="btn sm icon" data-wide title="${wide ? 'Reducir panel' : 'Ampliar panel'}"><i data-lucide="${wide ? 'minimize-2' : 'maximize-2'}"></i></button>
          <button class="btn sm" data-stop title="Detener ejecución"><i data-lucide="square"></i></button>
        </div>
      </div>
      <div class="row" style="margin-bottom:8px;flex-wrap:wrap">
        <button class="btn sm" data-open title="Abrir .R, .Rmd, .qmd o .json desde su computadora"><i data-lucide="folder-open"></i> Abrir</button>
        <button class="btn sm" data-r title="Guardar como script R"><i data-lucide="file-code"></i> Guardar .R</button>
        <button class="btn sm" data-json title="Guardar como cuaderno (se puede volver a abrir)"><i data-lucide="braces"></i> Guardar .json</button>
        <button class="btn sm danger" data-clear title="Vaciar mi espacio"><i data-lucide="trash-2"></i></button>
      </div>
      <div class="small muted" style="margin:-2px 0 8px">También puede arrastrar un archivo y soltarlo aquí.</div>
      ${!S.settings.allowLocalRun ? '<div class="announce warn" style="border-radius:8px;margin-bottom:8px">El docente desactivó temporalmente la ejecución local.</div>' : ''}
      ${S.packages?.length ? `<div class="small muted" style="margin-bottom:8px">Paquetes del aula: ${S.packages.map(p => `<span class="pkg-tag">${esc(p)}</span>`).join('')}</div>` : ''}`;
    el.appendChild(scratchHost);
    scratch.refreshAll();
    el.querySelector('[data-wide]').onclick = () => { store.set('rav:wide', !wide); panel.refresh('mine'); };
    el.querySelector('[data-stop]').onclick = () => localRunner?.interrupt();
    el.querySelector('[data-r]').onclick = () => download(`mi_espacio_${code}_${fileStamp()}.R`, toR(scratch.list, `Mi espacio — ${S.title}`));
    el.querySelector('[data-json]').onclick = () => download(`mi_espacio_${code}_${fileStamp()}.json`, toJSON(scratch.list, `Mi espacio — ${S.title}`), 'application/json');
    el.querySelector('[data-open]').onclick = pickLocalFile;
    el.querySelector('[data-clear]').onclick = () => {
      if (!confirm('¿Vaciar «Mi espacio»? Se borrarán sus celdas personales (no afecta la clase).')) return;
      scratch.setAll([{ id: uid('m'), type: 'code', code: '' }]);
      saveScratch();
    };
    // Arrastrar y soltar archivos sobre el panel
    el.ondragover = e => { e.preventDefault(); el.style.outline = '2px dashed var(--brand-2)'; };
    el.ondragleave = () => { el.style.outline = ''; };
    el.ondrop = e => {
      e.preventDefault();
      el.style.outline = '';
      const f = e.dataTransfer?.files?.[0];
      if (f) openLocalFile(f);
    };
  }

  // ── Abrir archivos locales (.R, .Rmd, .qmd, .json, .ipynb) en «Mi espacio» ──
  const fileInput = Object.assign(document.createElement('input'), {
    type: 'file', accept: '.R,.r,.Rmd,.rmd,.qmd,.json,.ipynb,.txt', className: 'hidden',
  });
  document.body.appendChild(fileInput);
  fileInput.onchange = () => { const f = fileInput.files[0]; fileInput.value = ''; if (f) openLocalFile(f); };
  function pickLocalFile() { fileInput.click(); }

  async function openLocalFile(file) {
    if (!/\.(r|rmd|qmd|json|ipynb|txt)$/i.test(file.name)) return toast('Formato no admitido. Use .R, .Rmd, .qmd o .json', 'err', 5000);
    if (file.size > 2 * 1024 * 1024) return toast('El archivo supera 2 MB', 'err');
    let parsed;
    try {
      parsed = parseNotebookFile(await file.text(), file.name);
    } catch (e) {
      return toast(`No se pudo leer «${file.name}»: ${e.message}`, 'err', 6000);
    }
    const cells = parsed.cells.map(c => ({ ...c, id: uid('m'), output: null, execCount: null }));
    if (!cells.length) return toast('El archivo no contiene código', 'err');
    const hasContent = scratch.list.some(c => c.code.trim());
    const m = modal({
      title: `Abrir «${file.name}»`, icon: 'folder-open',
      body: `
        <p style="margin-top:0">${cells.length} celda(s): ${cells.filter(c => c.type === 'code').length} de código R y ${cells.filter(c => c.type === 'markdown').length} de texto.</p>
        <div class="list" style="gap:6px">
          <label><input type="radio" name="om" value="append" ${hasContent ? 'checked' : ''}> Agregar al final de «Mi espacio»</label>
          <label><input type="radio" name="om" value="replace" ${hasContent ? '' : 'checked'}> Reemplazar el contenido de «Mi espacio»</label>
          <label style="margin-top:6px"><input type="checkbox" id="om-run" ${S.settings.allowLocalRun ? '' : 'disabled'}> Ejecutar todas las celdas al abrir</label>
        </div>
        <p class="small muted">El archivo se abre sólo en su navegador: ni el docente ni sus compañeros lo ven, salvo que usted envíe una celda.</p>`,
      foot: '<button class="btn" data-close>Cancelar</button><button class="btn primary" id="om-ok"><i data-lucide="check"></i> Abrir</button>',
    });
    m.el.querySelectorAll('.modal-foot [data-close]').forEach(b => b.onclick = m.close);
    m.el.querySelector('#om-ok').onclick = async () => {
      const mode = m.el.querySelector('input[name="om"]:checked').value;
      const runAll = m.el.querySelector('#om-run').checked;
      m.close();
      if (mode === 'replace') scratch.setAll(cells);
      else { let after = scratch.list.at(-1)?.id || null; for (const c of cells) { scratch.add(c, after); after = c.id; } }
      saveScratch();
      panel.show('mine');
      toast(`«${file.name}» abierto en Mi espacio`, 'ok');
      document.getElementById(`cell-${cells[0].id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      if (runAll) for (const c of cells) if (c.type === 'code' && c.code.trim()) await scratchRun(c.id);
    };
  }

  function renderQuestions(el) {
    myQuestions.forEach(q => { q._seen = true; });
    panel.badge('questions', 0);
    el.innerHTML = `
      ${S.settings.allowQuestions ? `
        <div class="panel-section">
          <h4>Pregunta al docente</h4>
          <textarea class="input" id="qq" maxlength="600" placeholder="Escriba su pregunta… (sólo el docente la verá)"></textarea>
          <button class="btn primary" style="width:100%;margin-top:6px" id="qsend"><i data-lucide="send"></i> Enviar pregunta</button>
        </div>` : '<p class="small muted">El docente desactivó las preguntas por ahora. Puede levantar la mano.</p>'}
      <div class="panel-section">
        <h4>Mis preguntas</h4>
        ${myQuestions.length ? '' : '<div class="empty-state">Aún no ha enviado preguntas.</div>'}
        <div class="list">${[...myQuestions].reverse().map(q => `
          <div class="item ${q.resolved ? 'done' : ''}">
            <div class="item-head"><span class="small muted">${fmtTime(q.at)}</span><span class="chip" style="margin-left:auto">${q.resolved ? 'Resuelta' : 'Pendiente'}</span></div>
            <div class="item-body">${esc(q.text)}</div>
            ${q.answer ? `<div class="item-body" style="color:var(--accent)"><b>Docente:</b> ${esc(q.answer)}</div>` : ''}
          </div>`).join('')}</div>
      </div>`;
    const send = () => {
      const t = el.querySelector('#qq').value.trim();
      if (!t) return;
      socket.emit('question', t);
      el.querySelector('#qq').value = '';
      toast('Pregunta enviada', 'ok');
    };
    el.querySelector('#qsend')?.addEventListener('click', send);
    el.querySelector('#qq')?.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });
  }

  function renderHelp(el) {
    el.innerHTML = `
      <div class="panel-section"><h4>¿Cómo funciona?</h4>
        <ul class="small" style="padding-left:18px;margin:0">
          <li>El cuaderno central es el del docente: verá en tiempo real lo que escribe (cursor <span style="background:var(--teacher);padding:0 4px;border-radius:3px">Docente</span>), las salidas y los gráficos.</li>
          <li><b>Seguir al docente</b> desplaza la página automáticamente a la celda en la que trabaja.</li>
          <li>Pulse <b>Probar</b> en cualquier celda para copiarla a <b>Mi espacio</b> y ejecutarla en su navegador. Puede modificarla sin afectar la clase.</li>
          <li>Con <i data-lucide="send" style="width:13px;height:13px"></i> envía su código al docente para revisión.</li>
          <li><b>Abrir archivo</b> carga en «Mi espacio» un <code>.R</code>, <code>.Rmd</code>, <code>.qmd</code> o <code>.json</code> de su computadora (también puede arrastrarlo al panel). Con <b>Guardar .R / .json</b> conserva su trabajo.</li>
          <li>Haga clic en un gráfico para ampliarlo; pase el ratón para descargarlo en PNG.</li>
        </ul></div>
      <div class="panel-section"><h4>Atajos en Mi espacio</h4>
        <ul class="small" style="padding-left:18px;margin:0">
          <li><b>Ctrl+Enter</b>: ejecutar la celda</li><li><b>Mayús+Enter</b>: ejecutar y pasar a la siguiente</li>
          <li><b>Ctrl+/</b>: comentar / descomentar</li></ul></div>`;
  }

  // ── Descargas ──
  function downloadModal() {
    if (!S.settings.allowDownload) return toast('Descargas desactivadas por el docente', 'err');
    const m = modal({
      title: 'Descargar el cuaderno de la clase', icon: 'download',
      body: `<div class="list">
        <button class="btn" data-x="html"><i data-lucide="file-text"></i> Reporte HTML (código, salidas y gráficos)</button>
        <button class="btn" data-x="r"><i data-lucide="file-code"></i> Script R (.R)</button>
        <button class="btn" data-x="json"><i data-lucide="braces"></i> Cuaderno (.json)</button>
      </div>`,
    });
    const base = `${slugify(S.title)}_${fileStamp()}`;
    m.el.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => {
      if (b.dataset.x === 'html') download(`${base}.html`, await toHTML(nb.list, S.title), 'text/html;charset=utf-8');
      if (b.dataset.x === 'r') download(`${base}.R`, toR(nb.list, S.title));
      if (b.dataset.x === 'json') download(`${base}.json`, toJSON(nb.list, S.title), 'application/json');
      m.close();
    });
  }
}
