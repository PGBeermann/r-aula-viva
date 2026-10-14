// Funciones comunes de la interfaz del aula (panel, barra superior, temporizador, anuncios)
import { $, esc, icons, store, clientId, toast, modal, copyText } from './util.js';

export const code = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '').toUpperCase();
export const params = new URLSearchParams(location.search);

// ─── Panel lateral con pestañas ──────────────────────────────────────────────
export function createPanel() {
  const tabsEl = $('#tabs'), bodyEl = $('#tab-body'), side = $('#side');
  const tabs = new Map();
  let active = null;
  const api = {
    define(list) {
      tabs.clear();
      tabsEl.innerHTML = '';
      for (const t of list) {
        const b = document.createElement('button');
        b.className = 'tab';
        b.title = t.label;
        b.innerHTML = `<i data-lucide="${t.icon}"></i><span>${esc(t.label)}</span><span class="badge hidden"></span>`;
        b.onclick = () => api.show(t.id);
        tabsEl.appendChild(b);
        tabs.set(t.id, { ...t, btn: b });
      }
      tabsEl.classList.toggle('compact', list.length > 3);
      icons(tabsEl);
      const close = document.createElement('button');
      close.className = 'tab tab-close';
      close.title = 'Cerrar panel';
      close.innerHTML = '<i data-lucide="x"></i>';
      close.onclick = () => api.toggle(false);
      tabsEl.appendChild(close);
      icons(close);
      const saved = store.get(`rav:tab:${code}`);
      api.show(saved && tabs.has(saved) ? saved : list[0].id, false);
    },
    show(id, open = true) {
      if (!tabs.has(id)) return;
      active = id;
      store.set(`rav:tab:${code}`, id);
      for (const [k, t] of tabs) t.btn.classList.toggle('active', k === id);
      bodyEl.innerHTML = '';
      tabs.get(id).render(bodyEl);
      icons(bodyEl);
      if (open && side.classList.contains('collapsed')) api.toggle(true);
    },
    refresh(id) { if (!id || id === active) { const sc = bodyEl.scrollTop; api.show(active, false); bodyEl.scrollTop = sc; } },
    isActive: id => active === id && !side.classList.contains('collapsed'),
    badge(id, n, soft = false) {
      const b = tabs.get(id)?.btn.querySelector('.badge');
      if (!b) return;
      b.textContent = n;
      b.classList.toggle('hidden', !n);
      b.classList.toggle('soft', soft);
    },
    toggle(force) {
      const open = force ?? side.classList.contains('collapsed');
      side.classList.toggle('collapsed', !open);
      store.set('rav:panelOpen', open);
      document.dispatchEvent(new CustomEvent('panel-toggle'));
      setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    },
    get active() { return active; },
  };
  const open = store.get('rav:panelOpen', window.innerWidth > 1000);
  side.classList.toggle('collapsed', !open);
  return api;
}

// ─── Utilidades de la barra superior ─────────────────────────────────────────
function syncTopHeight() {
  document.documentElement.style.setProperty('--top-h', `${$('#topbar').offsetHeight}px`);
}
new ResizeObserver(syncTopHeight).observe(document.getElementById('topbar'));

export function setFontSize(delta, nb) {
  const cur = store.get('rav:fs', 14);
  const fs = delta === 0 ? cur : Math.max(11, Math.min(26, cur + delta));
  store.set('rav:fs', fs);
  document.documentElement.style.setProperty('--fs', `${fs}px`);
  nb?.refreshAll();
}

export function shareModal(roomCode, title) {
  const link = `${location.origin}/aula/${roomCode}`;
  const m = modal({
    title: 'Invitar estudiantes', icon: 'share-2',
    body: `
      <p class="muted" style="margin-top:0;text-align:center">${esc(title)}</p>
      <div class="share-code">${esc(roomCode)}</div>
      <img class="qr" src="/api/rooms/${encodeURIComponent(roomCode)}/qr.svg" alt="Código QR para entrar al aula">
      <div class="row"><input class="input mono" readonly value="${esc(link)}"><button class="btn" data-copy><i data-lucide="copy"></i> Copiar</button></div>
      <p class="small muted">Los estudiantes pueden escanear el QR, abrir el enlace o entrar en <b>${esc(location.host)}</b> con el código.</p>`,
  });
  m.el.querySelector('[data-copy]').onclick = () => copyText(link);
}

// Temporizador compartido
let timerInt = null;
export function showTimer(t) {
  const chip = $('#timer-chip');
  clearInterval(timerInt);
  if (!t) { chip.classList.add('hidden'); return; }
  const offset = (t.serverNow || Date.now()) - Date.now();
  let warned = false;
  const tick = () => {
    const left = Math.max(0, t.endsAt - (Date.now() + offset));
    const s = Math.ceil(left / 1000);
    chip.textContent = `${t.label ? t.label + ' · ' : ''}${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    chip.classList.remove('hidden');
    chip.classList.toggle('done', left <= 0);
    if (left <= 0) {
      if (!warned) { warned = true; chip.textContent = `${t.label ? t.label + ' · ' : ''}¡Tiempo!`; toast('⏰ ¡Se acabó el tiempo!', '', 5000); }
      clearInterval(timerInt);
    }
  };
  tick();
  timerInt = setInterval(tick, 500);
}

export function showAnnounce(a) {
  const el = $('#announce');
  if (!a) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.className = `announce ${a.level || 'info'}`;
  el.innerHTML = `<i data-lucide="megaphone"></i><span>${esc(a.text)}</span>`;
  icons(el);
}

export function fatal(msg, sub = '') {
  document.body.innerHTML = `<div class="hero"><div class="card" style="text-align:center">
    <div class="brand" style="justify-content:center"><div class="brand-logo">R</div></div>
    <h1>${esc(msg)}</h1><p class="lead">${esc(sub)}</p><a class="btn primary" href="/">Volver al inicio</a></div></div>`;
}

export function askName() {
  return new Promise(resolve => {
    const m = modal({
      title: 'Bienvenido(a) al aula', icon: 'user',
      body: `<div class="field"><label>Nombre y apellido</label><input class="input" maxlength="40" id="nm" autocomplete="name" placeholder="Ej.: María Rodríguez"></div>
             <p class="small muted">Su docente verá este nombre en la lista de participantes.</p>`,
      foot: '<button class="btn primary" id="nm-ok">Entrar</button>',
      onClose: () => resolve(store.get('rav:name') || null),
    });
    const inp = m.el.querySelector('#nm');
    inp.value = store.get('rav:name') || '';
    inp.focus();
    const ok = () => {
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      store.set('rav:name', v);
      m.close();
    };
    m.el.querySelector('#nm-ok').onclick = ok;
    inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
  });
}

