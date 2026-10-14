// Renderizado (Markdown + LaTeX, salidas de R) e importación/exportación de cuadernos
import { esc, uid } from './util.js';

// ─── Markdown con fórmulas (KaTeX + mhchem para química: \ce{H2SO4}) ─────────
const MATH_RE = /(\\ce\{(?:[^{}\n]|\{[^{}\n]*\})*\}|\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?!\s)[^$\n]+?(?<!\s)\$(?!\w))/g;

function renderTex(raw) {
  let tex = raw, display = false;
  if (raw.startsWith('\\ce{')) { tex = raw; }
  else if (raw.startsWith('$$')) { tex = raw.slice(2, -2); display = true; }
  else if (raw.startsWith('\\[')) { tex = raw.slice(2, -2); display = true; }
  else if (raw.startsWith('\\(')) { tex = raw.slice(2, -2); }
  else { tex = raw.slice(1, -1); }
  try {
    return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false });
  } catch { return esc(raw); }
}

export function markdownToHtml(src) {
  const maths = [];
  // Proteger bloques/fragmentos de código para no interpretar $ dentro de ellos
  const parts = String(src || '').split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const protectedSrc = parts.map((p, i) => (i % 2 === 1 ? p : p.replace(MATH_RE, m => {
    maths.push(m);
    return `\uE000${maths.length - 1}\uE001`;
  }))).join('');
  let html = window.marked.parse(protectedSrc, { gfm: true, breaks: false });
  html = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  html = html.replace(/\uE000(\d+)\uE001/g, (_, i) => renderTex(maths[+i]));
  return html;
}

export function renderMarkdown(el, src) {
  const text = String(src || '').trim();
  el.classList.toggle('empty', !text);
  el.innerHTML = text ? markdownToHtml(text) : 'Celda de texto vacía';
  el.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
}

// ─── Salidas de R ────────────────────────────────────────────────────────────
const CLS = { out: 'o-out', err: 'o-err', warn: 'o-warn', msg: 'o-msg' };

export function outputTextHtml(lines = []) {
  return lines.map(l => `<span class="${CLS[l.t] || 'o-out'}">${esc(l.d)}</span>`).join('\n');
}

export function renderOutput(el, output, { execCount = null } = {}) {
  if (!output) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const hasText = output.lines?.length > 0;
  const imgs = output.images || [];
  el.innerHTML = `
    ${hasText ? `<pre class="output-text">${outputTextHtml(output.lines)}</pre>` : ''}
    ${!hasText && !imgs.length ? '<div class="small muted"><i>Sin salida.</i></div>' : ''}
    ${imgs.length ? `<div class="plots">${imgs.map((src, i) => `
      <div class="plot">
        <img src="${src}" alt="Gráfico ${i + 1} generado por R" loading="lazy" data-zoom>
        <div class="plot-actions">
          <button class="btn sm" data-dl="${i}" title="Descargar PNG"><i data-lucide="download"></i></button>
        </div>
      </div>`).join('')}</div>` : ''}
    <div class="output-meta">
      ${execCount ? `<span>Ejecución [${execCount}]</span>` : ''}
      ${Number.isFinite(output.ms) ? `<span>${output.ms < 1000 ? output.ms + ' ms' : (output.ms / 1000).toFixed(1) + ' s'}</span>` : ''}
      ${output.error ? '<span style="color:var(--danger)">con error</span>' : ''}
    </div>`;
  el.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => {
    const a = document.createElement('a');
    a.href = imgs[+b.dataset.dl];
    a.download = `grafico_${execCount || ''}_${+b.dataset.dl + 1}.png`;
    a.click();
  });
  el.querySelectorAll('[data-zoom]').forEach(img => img.onclick = () => {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${img.src}" alt="${esc(img.alt)}">`;
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
  });
  window.lucide?.createIcons({ root: el });
}

export function runningHtml(who) {
  return `<div class="running-note"><span class="spinner"></span>${esc(who)}</div>`;
}

// ─── Sincronización de texto (aplica sólo el fragmento que cambió) ───────────
export function applyText(cm, text) {
  const cur = cm.getValue();
  if (cur === text) return;
  let s = 0;
  const min = Math.min(cur.length, text.length);
  while (s < min && cur[s] === text[s]) s++;
  let e = 0;
  while (e < min - s && cur[cur.length - 1 - e] === text[text.length - 1 - e]) e++;
  const from = cm.posFromIndex(s);
  const to = cm.posFromIndex(cur.length - e);
  cm.replaceRange(text.slice(s, text.length - e), from, to, 'remote');
}

// ─── Exportación ─────────────────────────────────────────────────────────────
export function toJSON(cells, title, withOutputs = false) {
  return JSON.stringify({
    version: 2, title, savedAt: new Date().toISOString(),
    cells: cells.map(c => withOutputs
      ? { id: c.id, type: c.type, code: c.code, output: c.output, execCount: c.execCount }
      : { id: c.id, type: c.type, code: c.code }),
  }, null, 2);
}

/** Script R en formato knitr::spin (#' para texto) — reimportable */
export function toR(cells, title) {
  const head = `#' ---\n#' title: "${String(title).replace(/"/g, "'")}"\n#' date: "${new Date().toLocaleDateString('es-PA')}"\n#' ---\n`;
  return head + cells.map(c => c.type === 'markdown'
    ? c.code.split('\n').map(l => `#' ${l}`.trimEnd()).join('\n')
    : `#+ celda-${c.id}\n${c.code}`).join('\n\n') + '\n';
}

export async function toHTML(cells, title) {
  let katexCss = '';
  try { katexCss = await (await fetch('/vendor/katex/katex.min.css')).text(); } catch { /* sin estilos KaTeX */ }
  const body = cells.map(c => {
    if (c.type === 'markdown') return `<section class="md">${markdownToHtml(c.code)}</section>`;
    const out = c.output;
    return `<section class="cell">
      <div class="tag">[${c.execCount ?? ' '}]</div>
      <pre class="code">${esc(c.code)}</pre>
      ${out?.lines?.length ? `<pre class="out">${outputTextHtml(out.lines)}</pre>` : ''}
      ${(out?.images || []).map(s => `<img src="${s}" alt="Gráfico">`).join('')}
    </section>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${katexCss.replace(/url\(fonts\//g, 'url(/vendor/katex/fonts/')}
body{max-width:920px;margin:32px auto;padding:0 18px;font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;line-height:1.6;background:#f8fafc}
h1.doc{font-size:26px;margin:0 0 4px}.sub{color:#64748b;margin-bottom:26px}
.md{margin:16px 0}.cell{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin:16px 0}
.tag{font:700 12px Consolas,monospace;color:#94a3b8;margin-bottom:6px}
pre{white-space:pre-wrap;word-break:break-word;font:13px/1.55 Consolas,"Courier New",monospace;border-radius:8px;padding:10px 12px;margin:0}
pre.code{background:#282a36;color:#f8f8f2}pre.out{background:#f8fafc;border:1px solid #e2e8f0;margin-top:10px}
.o-err{color:#dc2626;font-weight:600}.o-warn{color:#b45309}.o-msg{color:#1d4ed8}
img{display:block;max-width:100%;margin:12px auto 0;border:1px solid #e2e8f0;border-radius:8px}
code{background:#f1f5f9;padding:1px 5px;border-radius:4px}table{border-collapse:collapse}td,th{border:1px solid #e2e8f0;padding:4px 10px}
@media print{body{background:#fff}.cell{break-inside:avoid}}
</style></head><body>
<h1 class="doc">${esc(title)}</h1><div class="sub">Reporte generado con R Aula Viva · ${esc(new Date().toLocaleString('es-PA'))}</div>
${body}
</body></html>`;
}

// ─── Importación (JSON v1/v2, R/spin, Rmd/Quarto) ────────────────────────────
export function parseNotebookFile(text, filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'json' || /^\s*[[{]/.test(text)) {
    const data = JSON.parse(text);
    const cells = Array.isArray(data) ? data : (data.cells || []);
    return {
      title: data.title || null,
      cells: cells.map(c => ({
        id: uid(),
        type: c.type === 'markdown' || c.cell_type === 'markdown' ? 'markdown' : 'code',
        code: Array.isArray(c.source) ? c.source.join('') : String(c.code ?? c.source ?? ''),
        output: null, execCount: null,
      })),
    };
  }
  if (ext === 'rmd' || ext === 'qmd' || /^```\{r/m.test(text)) return parseRmd(text);
  return parseRScript(text);
}

function parseRmd(text) {
  let title = null;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    const t = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m);
    if (t) title = t[1];
    text = text.slice(fm[0].length);
  }
  const cells = [];
  const re = /^```\{r[^}]*\}[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
  let last = 0, m;
  const pushMd = s => { if (s.trim()) cells.push({ id: uid(), type: 'markdown', code: s.trim(), output: null, execCount: null }); };
  while ((m = re.exec(text))) {
    pushMd(text.slice(last, m.index));
    cells.push({ id: uid(), type: 'code', code: m[1].replace(/\n$/, ''), output: null, execCount: null });
    last = re.lastIndex;
  }
  pushMd(text.slice(last));
  return { title, cells };
}

function parseRScript(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cells = [];
  let buf = [], type = 'code', title = null;
  const flush = () => {
    const src = buf.join('\n').replace(/^\n+|\n+$/g, '');
    if (src.trim()) cells.push({ id: uid(), type, code: src, output: null, execCount: null });
    buf = [];
  };
  // Encabezado YAML en formato spin
  if (lines[0]?.startsWith("#' ---")) {
    let i = 1;
    for (; i < lines.length && !lines[i].startsWith("#' ---"); i++) {
      const t = lines[i].match(/^#'\s*title:\s*["']?(.+?)["']?\s*$/);
      if (t) title = t[1];
    }
    lines.splice(0, i + 1);
  }
  for (const l of lines) {
    if (/^#'( |$)/.test(l)) {
      if (type !== 'markdown') { flush(); type = 'markdown'; }
      buf.push(l.replace(/^#' ?/, ''));
    } else if (/^(#\+|# %%|## ?-{4,}|# ?-{4,}.*-{4,}$)/.test(l)) {
      flush(); type = 'code';
    } else {
      if (type !== 'code') { flush(); type = 'code'; }
      buf.push(l);
    }
  }
  flush();
  return { title, cells };
}
