// Utilidades compartidas del cliente
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = (p = 'c') => `${p}-${Math.random().toString(16).slice(2, 12)}`;

export function icons(root = document) {
  try { window.lucide?.createIcons({ root }); } catch { /* sin íconos */ }
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}
export function throttle(fn, ms) {
  let last = 0, t, pending;
  return (...a) => {
    pending = a;
    const now = Date.now();
    const run = () => { last = Date.now(); t = null; fn(...pending); };
    if (now - last >= ms) run();
    else if (!t) t = setTimeout(run, ms - (now - last));
  };
}

export const store = {
  get(k, def = null) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* almacenamiento no disponible */ } },
};

export function clientId() {
  let id = store.get('rav:clientId');
  if (!id) { id = (crypto.randomUUID?.() || uid('cl') + uid('x')).replace(/[^A-Za-z0-9-]/g, ''); store.set('rav:clientId', id); }
  return id;
}

export function toast(msg, type = '', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export const fmtTime = t => new Date(t).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' });

const COLORS = ['#0b4a8b', '#0f9d76', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#4d7c0f', '#b91c1c', '#9333ea', '#0369a1'];
export function avatar(name) {
  let h = 0; for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  return `<span class="avatar" style="background:${COLORS[h % COLORS.length]}">${esc(ini)}</span>`;
}

/** Modal genérico. Devuelve { el, close }. */
export function modal({ title, icon = '', body = '', foot = '', wide = false, onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${icon ? `<i data-lucide="${icon}"></i>` : ''}${esc(title)}</h3>
        <button class="btn ghost icon" data-close aria-label="Cerrar"><i data-lucide="x"></i></button></div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  back.querySelector('[data-close]').onclick = close;
  document.addEventListener('keydown', onKey);
  $('#modal-root').appendChild(back);
  icons(back);
  return { el: back, close };
}

export function download(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado al portapapeles', 'ok', 1600); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copiado al portapapeles', 'ok', 1600); } catch { toast('No se pudo copiar', 'err'); }
    ta.remove();
  }
}

export const fileStamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
export const slugify = s => (s || 'cuaderno').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'cuaderno';
