// Vista del cuaderno: celdas de código R y de texto (Markdown + LaTeX).
// Se usa en modo editable (docente / espacio personal) o de sólo lectura (estudiante).
import { esc, icons, debounce } from './util.js';
import { renderMarkdown, renderOutput, runningHtml, applyText } from './render.js';

const CM_BASE = {
  theme: 'dracula', lineNumbers: true, lineWrapping: true, matchBrackets: true,
  indentUnit: 2, tabSize: 2, indentWithTabs: false, viewportMargin: Infinity,
};

export class NotebookView {
  /**
   * @param {HTMLElement} root
   * @param {object} o  opciones y callbacks
   *  editable, labels{run}, onRun(id), onChange(id,code), onAdd(afterId,type), onDelete(id),
   *  onMove(id,dir), onType(id,type), onFocus(focus), cellActions(cell) → html extra,
   *  onAction(action, id), showAddBar
   */
  constructor(root, o = {}) {
    this.root = root;
    this.o = o;
    this.editable = !!o.editable;
    this.cells = new Map();   // id → {data, el, cm, md, out, editing}
    this.order = [];
    this.focusMarks = [];
    this.focusId = null;
    if (this.editable && o.showAddBar !== false) {
      this.addBar = document.createElement('div');
      this.addBar.className = 'row';
      this.addBar.style.justifyContent = 'center';
      this.addBar.innerHTML = `
        <button class="btn sm" data-add="code"><i data-lucide="plus"></i> Celda R</button>
        <button class="btn sm" data-add="markdown"><i data-lucide="type"></i> Celda de texto</button>`;
      this.addBar.querySelectorAll('[data-add]').forEach(b => b.onclick = () => o.onAdd?.(this.order.at(-1) || null, b.dataset.add));
      root.appendChild(this.addBar);
      icons(this.addBar);
    }
  }

  get list() { return this.order.map(id => this.cells.get(id).data); }
  has(id) { return this.cells.has(id); }
  get(id) { return this.cells.get(id)?.data; }

  clear() {
    for (const c of this.cells.values()) c.el.remove();
    this.cells.clear();
    this.order = [];
  }

  setAll(list) {
    this.clear();
    list.forEach(c => this.add(c, null, { silent: true }));
  }

  add(data, afterId = null, { silent = false, edit = false } = {}) {
    const cell = { data: { output: null, execCount: null, ...data }, editing: false };
    const el = document.createElement('div');
    el.className = 'cell';
    el.id = `cell-${data.id}`;
    el.dataset.id = data.id;
    cell.el = el;
    this.cells.set(data.id, cell);

    let idx = -1;
    if (afterId === '__top__') idx = 0;
    else if (afterId && this.order.includes(afterId)) idx = this.order.indexOf(afterId) + 1;
    if (idx < 0 || idx > this.order.length) { this.order.push(data.id); this.root.insertBefore(el, this.addBar || null); }
    else {
      const ref = this.order[idx] ? this.cells.get(this.order[idx]).el : (this.addBar || null);
      this.order.splice(idx, 0, data.id);
      this.root.insertBefore(el, ref);
    }
    this.build(cell, { edit });
    return cell;
  }

  build(cell, { edit = false } = {}) {
    const d = cell.data;
    const isMd = d.type === 'markdown';
    cell.el.classList.toggle('md', isMd);
    cell.el.innerHTML = `
      <div class="cell-head">
        <span class="cell-tag">${isMd ? '' : `[${d.execCount ?? ' '}]`}</span>
        <span class="cell-type ${isMd ? 'md' : 'code'}">${isMd ? 'Texto' : 'R'}</span>
        <div class="cell-actions">${this.actionsHtml(d)}</div>
      </div>
      <div class="cell-editor"></div>
      <div class="md-view hidden"></div>
      ${isMd ? '' : '<div class="output hidden"></div>'}
      ${isMd && this.editable ? '<div class="md-edit-hint hidden">Markdown con fórmulas: $x^2$, $$\\bar{x}$$, \\ce{H2SO4}. Mayús+Enter para terminar.</div>' : ''}`;
    cell.md = cell.el.querySelector('.md-view');
    cell.out = cell.el.querySelector('.output');
    cell.cm = null;

    const needsEditor = !isMd || this.editable;
    if (needsEditor) {
      const host = cell.el.querySelector('.cell-editor');
      cell.cm = CodeMirror(host, {
        ...CM_BASE,
        value: d.code,
        mode: isMd ? 'markdown' : 'r',
        readOnly: this.editable ? false : true,
        autoCloseBrackets: this.editable,
        placeholder: isMd ? 'Escriba texto, listas, tablas o fórmulas…' : 'Código R…',
        extraKeys: this.editable ? this.keys(d.id) : {},
      });
      cell.cm.on('change', (cm, ch) => {
        if (ch.origin === 'remote' || ch.origin === 'setValue') return;
        d.code = cm.getValue();
        this.o.onChange?.(d.id, d.code);
        if (isMd) this.previewLater(cell);
      });
      if (this.editable) {
        const sendFocus = () => this.o.onFocus?.({ id: d.id, from: cm2pos(cell.cm.getCursor('from')), to: cm2pos(cell.cm.getCursor('to')) });
        cell.cm.on('cursorActivity', sendFocus);
        cell.cm.on('focus', sendFocus);
      }
      setTimeout(() => cell.cm?.refresh(), 0);
    }
    if (isMd) {
      cell.md.ondblclick = () => this.editable && this.setEditing(d.id, true);
      this.setEditing(d.id, this.editable && (edit || !d.code.trim()), { focus: edit });
    } else if (d.output) {
      renderOutput(cell.out, d.output, { execCount: d.execCount });
    }
    cell.el.querySelectorAll('[data-act]').forEach(b => b.onclick = e => { e.stopPropagation(); this.action(b.dataset.act, d.id); });
    icons(cell.el);
    if (edit && cell.cm && !isMd) cell.cm.focus();
  }

  actionsHtml(d) {
    const isMd = d.type === 'markdown';
    const b = (act, icon, title, cls = '') => `<button class="btn ghost sm ${cls}" data-act="${act}" title="${esc(title)}"><i data-lucide="${icon}"></i></button>`;
    if (!this.editable) return this.o.cellActions?.(d) || '';
    return [
      isMd ? b('toggleEdit', 'pencil', 'Editar / ver texto') : b('run', 'play', 'Ejecutar (Ctrl+Enter)', '') ,
      ...(this.o.extraActions?.(d) || []),
      b('toType', isMd ? 'code' : 'type', isMd ? 'Convertir en celda R' : 'Convertir en texto'),
      this.o.noMove ? '' : b('up', 'arrow-up', 'Subir'),
      this.o.noMove ? '' : b('down', 'arrow-down', 'Bajar'),
      b('addCode', 'plus', 'Insertar celda R debajo'),
      this.o.noMarkdown ? '' : b('addMd', 'text-cursor-input', 'Insertar celda de texto debajo'),
      b('delete', 'trash-2', 'Eliminar celda', 'danger'),
    ].join('');
  }

  action(act, id) {
    const o = this.o;
    switch (act) {
      case 'run': o.onRun?.(id); break;
      case 'toggleEdit': this.setEditing(id, !this.cells.get(id).editing, { focus: true }); break;
      case 'toType': o.onType?.(id, this.get(id).type === 'markdown' ? 'code' : 'markdown'); break;
      case 'up': o.onMove?.(id, 'up'); break;
      case 'down': o.onMove?.(id, 'down'); break;
      case 'addCode': o.onAdd?.(id, 'code'); break;
      case 'addMd': o.onAdd?.(id, 'markdown'); break;
      case 'delete': o.onDelete?.(id); break;
      default: o.onAction?.(act, id);
    }
  }

  keys(id) {
    const run = () => this.o.onRun?.(id);
    const next = () => {
      const i = this.order.indexOf(id);
      const nid = this.order[i + 1];
      if (nid) this.focusCell(nid); else this.o.onAdd?.(id, 'code');
    };
    return {
      'Shift-Enter': () => { if (this.get(id)?.type === 'markdown') this.setEditing(id, false); else run(); next(); },
      'Ctrl-Enter': () => (this.get(id)?.type === 'markdown' ? this.setEditing(id, false) : run()),
      'Cmd-Enter': () => (this.get(id)?.type === 'markdown' ? this.setEditing(id, false) : run()),
      'Alt-Enter': () => { run(); this.o.onAdd?.(id, 'code'); },
      'Ctrl-/': cm => cm.toggleComment(),
      'Cmd-/': cm => cm.toggleComment(),
      Tab: cm => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('  ', 'end')),
      'Shift-Tab': cm => cm.indentSelection('subtract'),
    };
  }

  focusCell(id) {
    const c = this.cells.get(id);
    if (!c) return;
    if (c.data.type === 'markdown' && this.editable && !c.editing) { c.el.scrollIntoView({ block: 'nearest' }); return; }
    c.cm?.focus();
    c.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  previewLater(cell) {
    cell._pv ||= debounce(() => renderMarkdown(cell.md, cell.data.code), 160);
    cell._pv();
  }

  setEditing(id, on, { focus = false } = {}) {
    const c = this.cells.get(id);
    if (!c || c.data.type !== 'markdown') return;
    c.editing = !!on && this.editable;
    const ed = c.el.querySelector('.cell-editor');
    ed.classList.toggle('hidden', !c.editing);
    c.el.querySelector('.md-edit-hint')?.classList.toggle('hidden', !c.editing);
    c.md.classList.remove('hidden');
    renderMarkdown(c.md, c.data.code);
    if (c.editing && c.cm) { c.cm.refresh(); if (focus) c.cm.focus(); }
  }

  // ── Actualizaciones remotas ──
  update(id, code) {
    const c = this.cells.get(id);
    if (!c) return;
    c.data.code = code;
    if (c.cm) applyText(c.cm, code);
    if (c.data.type === 'markdown') this.previewLater(c);
  }

  remove(id) {
    const c = this.cells.get(id);
    if (!c) return;
    c.el.remove();
    this.cells.delete(id);
    this.order = this.order.filter(x => x !== id);
  }

  move(id, dir) {
    const i = this.order.indexOf(id);
    const j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= this.order.length) return false;
    [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    const a = this.cells.get(this.order[Math.min(i, j)]).el;
    const b = this.cells.get(this.order[Math.max(i, j)]).el;
    b.parentNode.insertBefore(b, a);
    this.cells.get(id).cm?.refresh();
    return true;
  }

  setType(id, type) {
    const c = this.cells.get(id);
    if (!c) return;
    c.data.type = type;
    c.data.output = null;
    c.data.execCount = null;
    this.build(c, { edit: type === 'markdown' });
  }

  setRunning(id, text = 'Ejecutando…') {
    const c = this.cells.get(id);
    if (!c || !c.out) return;
    c.el.classList.add('running');
    c.el.querySelector('.cell-tag').textContent = '[*]';
    c.out.classList.remove('hidden');
    c.out.innerHTML = runningHtml(text);
  }

  setOutput(id, output, execCount) {
    const c = this.cells.get(id);
    if (!c || !c.out) return;
    c.data.output = output;
    if (execCount !== undefined) c.data.execCount = execCount;
    c.el.classList.remove('running');
    c.el.querySelector('.cell-tag').textContent = `[${c.data.execCount ?? ' '}]`;
    renderOutput(c.out, output, { execCount: c.data.execCount });
  }

  setExecCount(id, n) {
    const c = this.cells.get(id);
    if (!c) return;
    c.data.execCount = n;
    const tag = c.el.querySelector('.cell-tag');
    if (tag && c.data.type !== 'markdown') tag.textContent = `[${n ?? ' '}]`;
    const meta = c.out?.querySelector('.output-meta span');
    if (meta && n) meta.textContent = `Ejecución [${n}]`;
  }

  clearOutputs() {
    for (const c of this.cells.values()) {
      c.data.output = null; c.data.execCount = null;
      c.el.classList.remove('running');
      if (c.out) { c.out.innerHTML = ''; c.out.classList.add('hidden'); }
      const tag = c.el.querySelector('.cell-tag');
      if (tag && c.data.type !== 'markdown') tag.textContent = '[ ]';
    }
  }

  // ── Foco del docente (vista estudiante) ──
  setFocus(f, { follow = false } = {}) {
    this.focusMarks.forEach(m => m.clear());
    this.focusMarks = [];
    if (this.focusId) this.cells.get(this.focusId)?.el.classList.remove('teacher-focus');
    if (!f || !this.cells.has(f.id)) { this.focusId = null; return; }
    const changed = this.focusId !== f.id;
    this.focusId = f.id;
    const c = this.cells.get(f.id);
    c.el.classList.add('teacher-focus');
    let caretEl = null;
    if (c.cm && f.from) {
      const from = { line: f.from.line, ch: f.from.ch };
      const to = f.to ? { line: f.to.line, ch: f.to.ch } : from;
      if (from.line !== to.line || from.ch !== to.ch) {
        this.focusMarks.push(c.cm.markText(from, to, { className: 'cm-teacher-sel' }));
      }
      caretEl = document.createElement('span');
      caretEl.className = 'teacher-caret';
      this.focusMarks.push(c.cm.setBookmark(to, { widget: caretEl, insertLeft: true }));
    }
    if (follow) {
      const target = caretEl && caretEl.isConnected ? caretEl : c.el;
      const r = target.getBoundingClientRect();
      const top = (document.getElementById('topbar')?.offsetHeight || 0) + 10;
      if (changed || r.top < top || r.bottom > window.innerHeight - 40) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  refreshAll() { for (const c of this.cells.values()) c.cm?.refresh(); }
}

const cm2pos = p => ({ line: p.line, ch: p.ch });
