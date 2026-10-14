// Interfaz del DOCENTE: edita y ejecuta el cuaderno (webR local) y lo transmite en vivo.
import { $, esc, icons, uid, debounce, throttle, toast, modal, download, copyText, fmtTime, avatar, fileStamp, slugify } from './util.js';
import { NotebookView } from './notebook.js';
import { RRunner } from './runner.js';
import { toJSON, toR, toHTML, parseNotebookFile } from './render.js';
import { setFontSize, shareModal } from './shell.js';

export function setup(ctx) {
  const { socket, panel, code } = ctx;
  let S = null;                    // estado del aula (copia local)
  let participants = [];
  let stopAll = false;
  let lastFocusId = null;
  const updaters = new Map();      // id → función debounced de envío

  $('#role-label').textContent = 'Docente · transmitiendo en vivo';

  // ── Motor R ──
  const rChip = $('#r-chip');
  rChip.classList.remove('hidden');
  const runner = new RRunner({
    onStatus: (st, label) => {
      rChip.className = `chip ${st === 'ready' ? 'ok' : st === 'error' ? 'bad' : 'busy'}`;
      $('#r-label').textContent = label;
    },
  });

  // ── Cuaderno ──
  const sendUpdate = id => {
    if (!updaters.has(id)) {
      updaters.set(id, debounce(() => {
        const c = nb.get(id);
        if (c) socket.emit('cell:update', { id, code: c.code });
      }, 110));
    }
    return updaters.get(id);
  };
  const flushUpdate = id => updaters.get(id)?.flush();
  const emitFocus = throttle(f => socket.emit('focus', f), 90);

  const nb = new NotebookView($('#notebook'), {
    editable: true,
    onChange: id => sendUpdate(id)(),
    onFocus: f => { lastFocusId = f.id; emitFocus(f); },
    onRun: id => runCell(id),
    onAdd: (afterId, type) => addCell(afterId, type),
    onDelete: id => {
      const c = nb.get(id);
      if (c?.code.trim() && !confirm('¿Eliminar esta celda?')) return;
      nb.remove(id);
      socket.emit('cell:delete', { id });
    },
    onMove: (id, dir) => { flushUpdate(id); if (nb.move(id, dir)) socket.emit('cell:move', { id, dir }); },
    onType: (id, type) => { flushUpdate(id); nb.setType(id, type); socket.emit('cell:type', { id, type }); },
  });
  ctx.nb = nb;

  function addCell(afterId, type = 'code', codeTxt = '') {
    const cell = { id: uid(), type, code: codeTxt, output: null, execCount: null };
    nb.add(cell, afterId, { edit: true });
    socket.emit('cell:add', { afterId, cell: { id: cell.id, type, code: codeTxt } });
    return cell.id;
  }

  async function runCell(id) {
    const c = nb.get(id);
    if (!c) return;
    if (c.type === 'markdown') { nb.setEditing(id, false); return; }
    flushUpdate(id);
    nb.setRunning(id, 'Ejecutando…');
    socket.emit('cell:running', { id });
    const out = await runner.run(c.code);
    if (!nb.has(id)) return out;
    nb.setOutput(id, out, null);
    socket.emit('cell:output', { id, output: out });
    return out;
  }

  async function runAll() {
    stopAll = false;
    $('#btn-runall').disabled = true;
    try {
      for (const c of nb.list) {
        if (stopAll) break;
        if (c.type === 'code' && c.code.trim()) await runCell(c.id);
      }
    } finally { $('#btn-runall').disabled = false; }
  }

  // ── Barra de herramientas ──
  $('#toolbar').innerHTML = `
    <button class="btn" data-t="addCode"><i data-lucide="square-plus"></i><span class="lbl">Celda R</span></button>
    <button class="btn" data-t="addMd"><i data-lucide="type"></i><span class="lbl">Texto</span></button>
    <span class="sep"></span>
    <button class="btn run" id="btn-runall" data-t="runAll"><i data-lucide="play"></i><span class="lbl">Ejecutar todo</span></button>
    <button class="btn" data-t="stop" title="Interrumpir la ejecución"><i data-lucide="square"></i><span class="lbl">Detener</span></button>
    <button class="btn" data-t="clear" title="Borrar todas las salidas"><i data-lucide="eraser"></i><span class="lbl">Limpiar</span></button>
    <span class="sep"></span>
    <button class="btn" data-t="pkgs"><i data-lucide="package"></i><span class="lbl">Paquetes</span></button>
    <button class="btn" data-t="library"><i data-lucide="library"></i><span class="lbl">Cuadernos</span></button>
    <button class="btn" data-t="export"><i data-lucide="download"></i><span class="lbl">Descargar</span></button>
    <span class="sep"></span>
    <button class="btn icon" data-t="fsMinus" title="Reducir letra"><i data-lucide="a-arrow-down"></i></button>
    <button class="btn icon" data-t="fsPlus" title="Aumentar letra"><i data-lucide="a-arrow-up"></i></button>
    <a class="btn icon" href="/aula/${code}?vista=estudiante" target="_blank" rel="noopener" title="Abrir vista de estudiante"><i data-lucide="eye"></i></a>
    <a class="btn icon" href="/docente" title="Mis aulas"><i data-lucide="layout-grid"></i></a>
    <span class="spacer"></span>
    <button class="btn" data-t="panel"><i data-lucide="panel-right"></i><span class="lbl">Panel</span></button>`;
  const T = {
    addCode: () => addCell(lastFocusId && nb.has(lastFocusId) ? lastFocusId : null, 'code'),
    addMd: () => addCell(lastFocusId && nb.has(lastFocusId) ? lastFocusId : null, 'markdown'),
    runAll,
    stop: () => { stopAll = true; runner.interrupt(); toast('Interrupción enviada a R'); },
    clear: () => { if (confirm('¿Borrar todas las salidas (texto y gráficos)?')) { nb.clearOutputs(); socket.emit('cells:clearOutputs'); } },
    pkgs: packagesModal,
    library: libraryModal,
    export: exportModal,
    fsMinus: () => setFontSize(-1, nb),
    fsPlus: () => setFontSize(1, nb),
    panel: () => panel.toggle(),
  };
  $('#toolbar').querySelectorAll('[data-t]').forEach(b => b.onclick = () => T[b.dataset.t]());

  // Título editable
  const titleEl = $('#room-title'), titleIn = $('#room-title-input');
  titleEl.style.cursor = 'text';
  titleEl.title = 'Clic para cambiar el título';
  titleEl.onclick = () => { titleIn.value = titleEl.textContent; titleEl.classList.add('hidden'); titleIn.classList.remove('hidden'); titleIn.focus(); titleIn.select(); };
  const saveTitle = async () => {
    titleIn.classList.add('hidden'); titleEl.classList.remove('hidden');
    const t = titleIn.value.trim();
    if (!t || t === titleEl.textContent) return;
    titleEl.textContent = t;
    await fetch(`/api/rooms/${code}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t }) });
  };
  titleIn.onblur = saveTitle;
  titleIn.onkeydown = e => { if (e.key === 'Enter') titleIn.blur(); if (e.key === 'Escape') { titleIn.value = titleEl.textContent; titleIn.blur(); } };

  // Atajos globales
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveToLibrary(); }
  });

  // ── Eventos del servidor ──
  let first = true;
  socket.on('state', s => {
    S = s;
    nb.setAll(s.cells);
    const hadOutputs = s.cells.some(c => c.output);
    if (first && hadOutputs) $('#restart-note').classList.remove('hidden');
    if (first) {
      first = false;
      runner.configure(s.webr);
      runner.init().then(async () => {
        if (S.packages?.length) {
          toast(`Instalando paquetes del aula: ${S.packages.join(', ')}`, '', 4000);
          await runner.installPackages(S.packages, m => console.log(`[paquetes] ${m}`));
        }
      }).catch(err => toast(`No se pudo iniciar webR: ${err.message}`, 'err', 8000));
    }
    panel.refresh();
    updateBadges();
    icons();
  });
  // Cambios hechos desde otra pestaña del docente
  socket.on('cell:add', ({ afterId, cell }) => { if (!nb.has(cell.id)) nb.add(cell, afterId); });
  socket.on('cell:update', ({ id, code: src }) => nb.update(id, src));
  socket.on('cell:delete', ({ id }) => nb.remove(id));
  socket.on('cell:move', ({ id, dir }) => nb.move(id, dir));
  socket.on('cell:type', ({ id, type }) => nb.setType(id, type));
  socket.on('cell:running', ({ id }) => nb.setRunning(id, 'Ejecutando en otra pestaña…'));
  socket.on('cell:output', ({ id, output, execCount }) => {
    const c = nb.get(id);
    if (!c) return;
    if (c.output && c.output.ms === output?.ms && c.output.lines?.length === output?.lines?.length) nb.setExecCount(id, execCount);
    else nb.setOutput(id, output, execCount);
  });
  socket.on('cells:clearOutputs', () => nb.clearOutputs());
  socket.on('notebook:replace', ({ cells }) => nb.setAll(cells));
  socket.on('packages', list => { S.packages = list; });
  socket.on('settings', st => { S.settings = st; panel.refresh('class'); });

  socket.on('participants', list => {
    const prevHands = new Set(participants.filter(p => p.hand).map(p => p.clientId));
    participants = list;
    const students = list.filter(p => p.role === 'student');
    $('#people-count').textContent = students.length;
    for (const p of students) if (p.hand && !prevHands.has(p.clientId)) toast(`✋ ${p.name} levantó la mano`);
    updateBadges();
    panel.refresh('people');
  });
  socket.on('question:new', q => { S.questions.push(q); toast(`❓ Pregunta de ${q.name}`); updateBadges(); panel.refresh('questions'); });
  socket.on('question:update', q => { const i = S.questions.findIndex(x => x.id === q.id); if (i >= 0) S.questions[i] = q; updateBadges(); panel.refresh('questions'); });
  socket.on('questions', l => { S.questions = l; updateBadges(); panel.refresh('questions'); });
  socket.on('submission:new', s => { S.submissions.push(s); toast(`📥 Entrega de ${s.name}`); updateBadges(); panel.refresh('subs'); });
  socket.on('submission:update', s => { const i = S.submissions.findIndex(x => x.id === s.id); if (i >= 0) S.submissions[i] = s; updateBadges(); panel.refresh('subs'); });
  socket.on('submissions', l => { S.submissions = l; updateBadges(); panel.refresh('subs'); });
  socket.on('poll', p => { S.poll = p; panel.refresh('poll'); updateBadges(); });
  socket.on('react', ({ emoji, name }) => {
    const el = document.createElement('div');
    el.className = 'reaction';
    el.innerHTML = `<b>${esc(emoji)}</b>${esc(name)}`;
    $('#reactions').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  });

  function updateBadges() {
    if (!S) return;
    panel.badge('people', participants.filter(p => p.hand).length);
    panel.badge('questions', S.questions.filter(q => !q.resolved).length);
    panel.badge('subs', S.submissions.filter(s => !s.reviewed).length);
    panel.badge('poll', S.poll?.open ? '•' : 0, true);
  }

  // ── Panel lateral ──
  const guard = fn => el => (S ? fn(el) : (el.innerHTML = '<div class="empty-state">Conectando…</div>'));
  panel.define([
    { id: 'people', label: 'Participantes', icon: 'users', render: guard(renderPeople) },
    { id: 'questions', label: 'Preguntas', icon: 'message-circle-question', render: guard(renderQuestions) },
    { id: 'subs', label: 'Entregas', icon: 'inbox', render: guard(renderSubs) },
    { id: 'poll', label: 'Encuesta', icon: 'chart-bar', render: guard(renderPoll) },
    { id: 'class', label: 'Clase', icon: 'settings-2', render: guard(renderClass) },
  ]);

  function renderPeople(el) {
    const students = participants.filter(p => p.role === 'student');
    const hands = students.filter(p => p.hand);
    el.innerHTML = `
      <div class="panel-section row" style="justify-content:space-between">
        <span><b>${students.length}</b> estudiante(s) conectados</span>
        ${hands.length ? '<button class="btn sm" data-lowerall><i data-lucide="hand"></i> Bajar todas</button>' : ''}
      </div>
      ${students.length ? '' : `<div class="empty-state">Aún no hay estudiantes.<br><br><button class="btn sm" data-share><i data-lucide="qr-code"></i> Mostrar código e invitación</button></div>`}
      <div>${students.map(p => `
        <div class="person">
          ${avatar(p.name)}
          <div style="flex:1;min-width:0"><div style="overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>
            ${p.hand ? `<div class="small" style="color:#92400e">✋ mano levantada · ${fmtTime(p.hand)}</div>` : ''}</div>
          ${p.tabs > 1 ? `<span class="chip" title="Pestañas abiertas">${p.tabs}</span>` : ''}
          ${p.hand ? `<button class="btn sm" data-lower="${esc(p.clientId)}">Bajar</button>` : ''}
        </div>`).join('')}</div>
      ${participants.filter(p => p.role === 'teacher').length > 1 ? `<p class="small muted">Hay ${participants.filter(p => p.role === 'teacher').length} pestañas de docente abiertas.</p>` : ''}`;
    el.querySelector('[data-lowerall]')?.addEventListener('click', () => socket.emit('hands:lower', {}));
    el.querySelector('[data-share]')?.addEventListener('click', () => shareModal(code, S.title));
    el.querySelectorAll('[data-lower]').forEach(b => b.onclick = () => socket.emit('hands:lower', { clientId: b.dataset.lower }));
  }

  function renderQuestions(el) {
    const qs = [...S.questions].sort((a, b) => (a.resolved - b.resolved) || b.at - a.at);
    el.innerHTML = `
      <div class="panel-section row" style="justify-content:space-between">
        <span>${qs.filter(q => !q.resolved).length} pendiente(s)</span>
        ${qs.length ? '<button class="btn sm danger" data-clear>Vaciar</button>' : ''}
      </div>
      ${!S.settings.allowQuestions ? '<p class="small muted">Las preguntas están desactivadas (pestaña Clase).</p>' : ''}
      ${qs.length ? '' : '<div class="empty-state">Sin preguntas por ahora.</div>'}
      <div class="list">${qs.map(q => `
        <div class="item ${q.resolved ? 'done' : 'highlight'}" data-id="${q.id}">
          <div class="item-head">${avatar(q.name)}<strong>${esc(q.name)}</strong><span class="small muted" style="margin-left:auto">${fmtTime(q.at)}</span></div>
          <div class="item-body">${esc(q.text)}</div>
          ${q.answer ? `<div class="item-body small" style="color:var(--accent)"><b>Respuesta:</b> ${esc(q.answer)}</div>` : ''}
          <div class="item-actions">
            <button class="btn sm" data-a="answer"><i data-lucide="reply"></i> Responder</button>
            <button class="btn sm" data-a="project" title="Mostrar a toda la clase"><i data-lucide="megaphone"></i> Proyectar</button>
            <button class="btn sm" data-a="toggle">${q.resolved ? 'Reabrir' : '<i data-lucide="check"></i> Resuelta'}</button>
          </div>
        </div>`).join('')}</div>`;
    el.querySelector('[data-clear]')?.addEventListener('click', () => confirm('¿Eliminar todas las preguntas?') && socket.emit('questions:clear'));
    el.querySelectorAll('.item').forEach(it => {
      const q = S.questions.find(x => x.id === it.dataset.id);
      it.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
        if (b.dataset.a === 'toggle') socket.emit('question:resolve', { id: q.id, resolved: !q.resolved });
        if (b.dataset.a === 'project') socket.emit('announce', { text: `Pregunta de ${q.name}: ${q.text}`, level: 'info' });
        if (b.dataset.a === 'answer') {
          const m = modal({
            title: `Responder a ${q.name}`, icon: 'reply',
            body: `<p class="muted" style="margin-top:0">${esc(q.text)}</p><textarea class="input" id="ans" maxlength="600">${esc(q.answer || '')}</textarea>
                   <p class="small muted">Sólo ${esc(q.name)} verá la respuesta. Use «Proyectar» para compartirla con toda la clase.</p>`,
            foot: '<button class="btn primary" id="ans-ok">Enviar respuesta</button>',
          });
          m.el.querySelector('#ans').focus();
          m.el.querySelector('#ans-ok').onclick = () => { socket.emit('question:resolve', { id: q.id, answer: m.el.querySelector('#ans').value, resolved: true }); m.close(); };
        }
      });
    });
  }

  function renderSubs(el) {
    const subs = [...S.submissions].sort((a, b) => (a.reviewed - b.reviewed) || b.at - a.at);
    el.innerHTML = `
      <div class="panel-section row" style="justify-content:space-between">
        <span>${subs.length} entrega(s) · ${subs.filter(s => !s.reviewed).length} sin revisar</span>
        ${subs.length ? '<button class="btn sm danger" data-clear>Vaciar</button>' : ''}
      </div>
      ${!S.settings.allowSubmissions ? '<p class="small muted">Las entregas están desactivadas (pestaña Clase).</p>' : ''}
      ${subs.length ? '' : '<div class="empty-state">Los estudiantes pueden enviarle código desde «Mi espacio».</div>'}
      <div class="list">${subs.map(s => `
        <div class="item ${s.reviewed ? 'done' : ''}" data-id="${s.id}">
          <div class="item-head">${avatar(s.name)}<strong>${esc(s.name)}</strong><span class="small muted" style="margin-left:auto">${fmtTime(s.at)}</span></div>
          ${s.note ? `<div class="item-body small">${esc(s.note)}</div>` : ''}
          <pre>${esc(s.code)}</pre>
          ${s.outputText ? `<details><summary class="small muted">Salida obtenida por el estudiante</summary><pre style="background:#f8fafc;color:#334155">${esc(s.outputText)}</pre></details>` : ''}
          <div class="item-actions">
            <button class="btn sm primary" data-a="insert"><i data-lucide="corner-down-right"></i> Insertar en el cuaderno</button>
            <button class="btn sm" data-a="copy"><i data-lucide="copy"></i></button>
            <button class="btn sm" data-a="rev">${s.reviewed ? 'Pendiente' : '<i data-lucide="check"></i> Revisada'}</button>
          </div>
        </div>`).join('')}</div>`;
    el.querySelector('[data-clear]')?.addEventListener('click', () => confirm('¿Eliminar todas las entregas?') && socket.emit('submissions:clear'));
    el.querySelectorAll('.item').forEach(it => {
      const s = S.submissions.find(x => x.id === it.dataset.id);
      it.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
        if (b.dataset.a === 'copy') copyText(s.code);
        if (b.dataset.a === 'rev') socket.emit('submission:reviewed', { id: s.id, reviewed: !s.reviewed });
        if (b.dataset.a === 'insert') {
          const md = addCell(lastFocusId && nb.has(lastFocusId) ? lastFocusId : null, 'markdown', `**Propuesta de ${s.name}**${s.note ? ` — ${s.note}` : ''}`);
          nb.setEditing(md, false);
          const id = addCell(md, 'code', s.code);
          lastFocusId = id;
          socket.emit('submission:reviewed', { id: s.id, reviewed: true });
          document.getElementById(`cell-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      });
    });
  }

  const PRESETS = {
    comp: { q: '¿Comprendieron lo explicado?', o: ['Sí, todo claro', 'Más o menos', 'No, necesito otra explicación'] },
    vf: { q: 'Verdadero o falso:', o: ['Verdadero', 'Falso'] },
    abcd: { q: 'Seleccione la respuesta correcta:', o: ['A', 'B', 'C', 'D'] },
    ritmo: { q: '¿Cómo va el ritmo de la clase?', o: ['Muy rápido', 'Adecuado', 'Muy lento'] },
  };
  function renderPoll(el) {
    const p = S.poll;
    const n = participants.filter(x => x.role === 'student').length;
    if (p) {
      const r = p.results || { counts: p.options.map(() => 0), total: 0 };
      el.innerHTML = `
        <div class="panel-section">
          <h4>${p.open ? 'Encuesta abierta' : 'Encuesta cerrada'}</h4>
          <p style="margin:0 0 10px;font-weight:700">${esc(p.question)}</p>
          ${p.options.map((o, i) => {
            const pct = r.total ? Math.round(100 * r.counts[i] / r.total) : 0;
            return `<div class="small">${esc(o)}</div><div class="bar"><div style="width:${pct}%"></div><span>${r.counts[i]} · ${pct}%</span></div>`;
          }).join('')}
          <p class="small muted">${r.total} de ${n} estudiante(s) han respondido.</p>
          <div class="row" style="flex-wrap:wrap">
            ${p.open ? '<button class="btn primary sm" data-a="end"><i data-lucide="lock"></i> Cerrar y mostrar resultados</button>' : ''}
            <button class="btn sm" data-a="clear">${p.open ? 'Cancelar' : 'Nueva encuesta'}</button>
          </div>
        </div>`;
      el.querySelector('[data-a="end"]')?.addEventListener('click', () => socket.emit('poll:end'));
      el.querySelector('[data-a="clear"]').onclick = () => socket.emit('poll:clear');
      return;
    }
    el.innerHTML = `
      <div class="panel-section">
        <h4>Plantillas rápidas</h4>
        <div class="row" style="flex-wrap:wrap">
          <button class="btn sm" data-p="comp">¿Comprendieron?</button>
          <button class="btn sm" data-p="ritmo">Ritmo</button>
          <button class="btn sm" data-p="vf">V / F</button>
          <button class="btn sm" data-p="abcd">A-B-C-D</button>
        </div>
      </div>
      <div class="panel-section">
        <h4>Nueva encuesta</h4>
        <div class="field"><label>Pregunta</label><input class="input" id="pq" maxlength="300"></div>
        <div class="field"><label>Opciones (una por línea, 2 a 8)</label><textarea class="input" id="po" rows="4"></textarea></div>
        <label class="switch"><span>Mostrar resultados en vivo a los estudiantes</span><input type="checkbox" id="pl"></label>
        <button class="btn primary" style="width:100%;margin-top:10px" id="pgo"><i data-lucide="send"></i> Lanzar encuesta</button>
      </div>`;
    el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
      const pr = PRESETS[b.dataset.p];
      el.querySelector('#pq').value = pr.q;
      el.querySelector('#po').value = pr.o.join('\n');
    });
    el.querySelector('#pgo').onclick = () => {
      const question = el.querySelector('#pq').value.trim();
      const options = el.querySelector('#po').value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!question || options.length < 2) return toast('Escriba la pregunta y al menos dos opciones', 'err');
      socket.emit('poll:start', { question, options, showResults: el.querySelector('#pl').checked });
    };
  }

  function renderClass(el) {
    const st = S.settings;
    el.innerHTML = `
      <div class="panel-section">
        <h4>Invitar</h4>
        <div class="share-code" style="font-size:30px">${esc(code)}</div>
        <div class="row"><button class="btn sm" style="flex:1" data-share><i data-lucide="qr-code"></i> QR y enlace</button>
          <button class="btn sm" style="flex:1" data-copylink><i data-lucide="link"></i> Copiar enlace</button></div>
      </div>
      <div class="panel-section">
        <h4>Anuncio para la clase</h4>
        <textarea class="input" id="an" maxlength="400" rows="2" placeholder="Ej.: Abran el conjunto de datos de la práctica 3">${esc(S.announce?.text || '')}</textarea>
        <div class="row" style="margin-top:6px">
          <select class="input" id="al" style="flex:0 0 120px">
            <option value="info">Información</option><option value="warn">Atención</option><option value="ok">Éxito</option>
          </select>
          <button class="btn primary sm" data-an>Publicar</button>
          <button class="btn sm" data-anoff>Quitar</button>
        </div>
      </div>
      <div class="panel-section">
        <h4>Temporizador</h4>
        <div class="row" style="flex-wrap:wrap">
          ${[1, 3, 5, 10, 15].map(m => `<button class="btn sm" data-min="${m}">${m} min</button>`).join('')}
        </div>
        <div class="row" style="margin-top:6px">
          <input class="input" id="tm" type="number" min="1" max="240" placeholder="min" style="flex:0 0 80px">
          <input class="input" id="tl" maxlength="80" placeholder="Etiqueta (opcional)">
        </div>
        <div class="row" style="margin-top:6px">
          <button class="btn primary sm" data-tgo style="flex:1"><i data-lucide="timer"></i> Iniciar</button>
          <button class="btn sm" data-toff style="flex:1">Detener</button>
        </div>
      </div>
      <div class="panel-section">
        <h4>Permisos de los estudiantes</h4>
        ${[['allowDownload', 'Descargar el cuaderno (.R / .html)'], ['allowQuestions', 'Enviar preguntas'],
           ['allowSubmissions', 'Enviar código al docente'], ['allowLocalRun', 'Ejecutar R en su navegador («Mi espacio»)']]
          .map(([k, l]) => `<label class="switch"><span>${l}</span><input type="checkbox" data-set="${k}" ${st[k] ? 'checked' : ''}></label>`).join('')}
      </div>
      <div class="panel-section">
        <h4>Paquetes del aula</h4>
        <div>${(S.packages || []).map(p => `<span class="pkg-tag">${esc(p)}</span>`).join('') || '<span class="small muted">Ninguno. Use el botón «Paquetes».</span>'}</div>
      </div>
      <p class="small muted">R Aula Viva versión ${esc(ctx.version)}</p>`;
    el.querySelector('#al').value = S.announce?.level || 'info';
    el.querySelector('[data-share]').onclick = () => shareModal(code, S.title);
    el.querySelector('[data-copylink]').onclick = () => copyText(`${location.origin}/aula/${code}`);
    el.querySelector('[data-an]').onclick = () => socket.emit('announce', { text: el.querySelector('#an').value, level: el.querySelector('#al').value });
    el.querySelector('[data-anoff]').onclick = () => { el.querySelector('#an').value = ''; socket.emit('announce', null); };
    el.querySelectorAll('[data-min]').forEach(b => b.onclick = () => socket.emit('timer', { seconds: +b.dataset.min * 60, label: el.querySelector('#tl').value }));
    el.querySelector('[data-tgo]').onclick = () => {
      const m = parseFloat(el.querySelector('#tm').value);
      if (!(m > 0)) return toast('Indique los minutos', 'err');
      socket.emit('timer', { seconds: Math.round(m * 60), label: el.querySelector('#tl').value });
    };
    el.querySelector('[data-toff]').onclick = () => socket.emit('timer', null);
    el.querySelectorAll('[data-set]').forEach(c => c.onchange = () => socket.emit('settings', { [c.dataset.set]: c.checked }));
  }

  // ── Modal: paquetes ──
  function packagesModal() {
    const m = modal({
      title: 'Paquetes de R (webR)', icon: 'package',
      body: `
        <p class="small muted" style="margin-top:0">Separe los nombres con comas. Los paquetes se instalan desde el repositorio de webR
          (<a href="https://repo.r-wasm.org/" target="_blank" rel="noopener">repo.r-wasm.org</a>) y quedan registrados en el aula para que los estudiantes los carguen en «Mi espacio».</p>
        <div class="row"><input class="input" id="pk" placeholder="ggplot2, dplyr, tidyr, psych"><button class="btn primary" id="pk-go"><i data-lucide="download"></i> Instalar</button></div>
        <div class="log hidden" id="pk-log" style="margin-top:12px"></div>
        <div style="margin-top:12px" id="pk-tags"></div>`,
    });
    const log = m.el.querySelector('#pk-log');
    const tags = () => {
      m.el.querySelector('#pk-tags').innerHTML = (S.packages || []).length
        ? `<div class="small muted" style="margin-bottom:6px">Registrados en el aula (clic para quitar):</div>${S.packages.map(p => `<button class="pkg-tag" style="border:0;cursor:pointer" data-rm="${esc(p)}">${esc(p)} ✕</button>`).join('')}`
        : '';
      m.el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { socket.emit('packages', S.packages.filter(x => x !== b.dataset.rm)); S.packages = S.packages.filter(x => x !== b.dataset.rm); tags(); });
    };
    tags();
    const go = async () => {
      const list = m.el.querySelector('#pk').value.split(',').map(s => s.trim()).filter(Boolean);
      if (!list.length) return;
      log.classList.remove('hidden');
      log.innerHTML = '';
      const btn = m.el.querySelector('#pk-go');
      btn.disabled = true;
      const ok = await runner.installPackages(list, (msg, t) => {
        log.insertAdjacentHTML('beforeend', `<span class="${t}">${esc(msg)}</span>\n`);
        log.scrollTop = log.scrollHeight;
      });
      btn.disabled = false;
      if (ok.length) {
        S.packages = [...new Set([...(S.packages || []), ...ok])];
        socket.emit('packages', S.packages);
        tags();
      }
      log.insertAdjacentHTML('beforeend', '<span class="info">─ Listo.</span>\n');
    };
    m.el.querySelector('#pk-go').onclick = go;
    m.el.querySelector('#pk').onkeydown = e => e.key === 'Enter' && go();
    m.el.querySelector('#pk').focus();
  }

  // ── Biblioteca de cuadernos ──
  async function saveToLibrary(title) {
    const t = title || S.title;
    const r = await fetch('/api/notebooks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: t, file: slugify(t), cells: nb.list.map(c => ({ id: c.id, type: c.type, code: c.code })) }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) toast(`Guardado en la biblioteca: ${j.file}`, 'ok'); else toast(j.error || 'No se pudo guardar', 'err');
    return r.ok;
  }

  async function applyNotebook(parsed, { mode = 'replace', runAfter = false } = {}) {
    const cells = parsed.cells.map(c => ({ ...c, id: uid(), output: null, execCount: null }));
    if (!cells.length) return toast('El archivo no contiene celdas', 'err');
    if (mode === 'replace') {
      nb.setAll(cells);
      socket.emit('notebook:replace', { cells, title: parsed.title || undefined });
    } else {
      let after = nb.list.at(-1)?.id || null;
      for (const c of cells) { nb.add(c, after); socket.emit('cell:add', { afterId: after, cell: c }); after = c.id; }
    }
    toast(`${cells.length} celda(s) cargadas`, 'ok');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (runAfter) runAll();
  }

  async function libraryModal() {
    const m = modal({
      title: 'Cuadernos', icon: 'library', wide: true,
      body: `
        <div class="panel-section">
          <h4>Guardar el cuaderno actual en el servidor</h4>
          <div class="row"><input class="input" id="lb-title" maxlength="120" value="${esc(S.title)}"><button class="btn primary" id="lb-save"><i data-lucide="save"></i> Guardar</button></div>
          <p class="small muted">Atajo: Ctrl+S. Se guarda el código (sin salidas) y puede reutilizarse en cualquier aula.</p>
        </div>
        <div class="panel-section">
          <h4>Al abrir un cuaderno</h4>
          <div class="row" style="flex-wrap:wrap;gap:16px">
            <label><input type="radio" name="lb-mode" value="replace" checked> Reemplazar el cuaderno del aula</label>
            <label><input type="radio" name="lb-mode" value="append"> Agregar al final</label>
            <label><input type="checkbox" id="lb-run" checked> Ejecutar todas las celdas</label>
          </div>
        </div>
        <div class="panel-section">
          <h4>Biblioteca del servidor</h4>
          <div id="lb-list" class="list"><div class="empty-state">Cargando…</div></div>
        </div>
        <div class="panel-section">
          <h4>Importar</h4>
          <div class="row" style="flex-wrap:wrap">
            <button class="btn" id="lb-file"><i data-lucide="folder-open"></i> Desde archivo (.json, .R, .Rmd, .qmd, .ipynb)</button>
            <input type="file" id="lb-input" accept=".json,.R,.r,.Rmd,.rmd,.qmd,.ipynb,.txt" class="hidden">
          </div>
          <div class="row" style="margin-top:8px"><input class="input" id="lb-url" placeholder="https://raw.githubusercontent.com/…/clase.Rmd"><button class="btn" id="lb-urlgo"><i data-lucide="link"></i> Desde URL</button></div>
          <p class="small muted">La URL debe permitir CORS (GitHub Raw, Gist, etc.).</p>
        </div>`,
    });
    const opts = () => ({ mode: m.el.querySelector('input[name="lb-mode"]:checked').value, runAfter: m.el.querySelector('#lb-run').checked });
    const confirmReplace = () => opts().mode !== 'replace' || confirm('Se reemplazará el cuaderno actual del aula para todos los participantes. ¿Continuar?');
    m.el.querySelector('#lb-save').onclick = async () => { if (await saveToLibrary(m.el.querySelector('#lb-title').value.trim())) loadList(); };

    async function loadList() {
      const box = m.el.querySelector('#lb-list');
      const r = await fetch('/api/notebooks').then(x => x.json()).catch(() => ({ notebooks: [] }));
      box.innerHTML = r.notebooks?.length ? r.notebooks.map(n => `
        <div class="item row" style="justify-content:space-between">
          <div style="min-width:0"><strong>${esc(n.title)}</strong><div class="small muted">${esc(n.file)} · ${n.cells ?? '?'} celdas · ${new Date(n.modified).toLocaleString('es-PA')}</div></div>
          <div class="row"><button class="btn sm primary" data-open="${esc(n.file)}">Abrir</button>
            <button class="btn sm danger" data-del="${esc(n.file)}"><i data-lucide="trash-2"></i></button></div>
        </div>`).join('') : '<div class="empty-state">La biblioteca está vacía.</div>';
      icons(box);
      box.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
        if (!confirmReplace()) return;
        const txt = await fetch(`/api/notebooks/${encodeURIComponent(b.dataset.open)}`).then(x => x.text());
        const o = opts();
        m.close();
        applyNotebook(parseNotebookFile(txt, b.dataset.open), o);
      });
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm(`¿Eliminar ${b.dataset.del} de la biblioteca?`)) return;
        await fetch(`/api/notebooks/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
        loadList();
      });
    }
    loadList();

    const inp = m.el.querySelector('#lb-input');
    m.el.querySelector('#lb-file').onclick = () => inp.click();
    inp.onchange = () => {
      const f = inp.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const parsed = parseNotebookFile(rd.result, f.name);
          if (!confirmReplace()) return;
          const o = opts();
          m.close();
          applyNotebook(parsed, o);
        } catch (e) { toast(`Archivo no válido: ${e.message}`, 'err', 6000); }
      };
      rd.readAsText(f);
    };
    m.el.querySelector('#lb-urlgo').onclick = async () => {
      const url = m.el.querySelector('#lb-url').value.trim();
      if (!url) return;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const parsed = parseNotebookFile(await r.text(), new URL(url).pathname);
        if (!confirmReplace()) return;
        const o = opts();
        m.close();
        applyNotebook(parsed, o);
      } catch (e) {
        toast(`No se pudo cargar: ${e.message}${String(e.message).includes('fetch') ? ' (¿CORS?)' : ''}`, 'err', 7000);
      }
    };
  }

  // ── Descargas ──
  function exportModal() {
    const m = modal({
      title: 'Descargar', icon: 'download',
      body: `<div class="list">
        <button class="btn" data-x="r"><i data-lucide="file-code"></i> Script R (.R, formato knitr::spin)</button>
        <button class="btn" data-x="html"><i data-lucide="file-text"></i> Reporte HTML con salidas y gráficos</button>
        <button class="btn" data-x="json"><i data-lucide="braces"></i> Cuaderno (.json, sólo código)</button>
        <button class="btn" data-x="jsonfull"><i data-lucide="archive"></i> Cuaderno con salidas (.json)</button>
        <button class="btn" data-x="print"><i data-lucide="printer"></i> Imprimir / guardar como PDF</button>
      </div>`,
    });
    const base = `${slugify(S.title)}_${fileStamp()}`;
    m.el.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => {
      const cells = nb.list;
      if (b.dataset.x === 'r') download(`${base}.R`, toR(cells, S.title));
      if (b.dataset.x === 'json') download(`${base}.json`, toJSON(cells, S.title), 'application/json');
      if (b.dataset.x === 'jsonfull') download(`${base}_salidas.json`, toJSON(cells, S.title, true), 'application/json');
      if (b.dataset.x === 'html') download(`${base}.html`, await toHTML(cells, S.title), 'text/html;charset=utf-8');
      if (b.dataset.x === 'print') { m.close(); setTimeout(() => window.print(), 200); return; }
      m.close();
    });
  }

  // Aviso al cerrar si hay ejecución en curso
  window.addEventListener('beforeunload', e => { if (runner.busy) { e.preventDefault(); e.returnValue = ''; } });
}
