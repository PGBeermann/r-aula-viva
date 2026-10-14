// Punto de entrada de la página del aula (común a docente y estudiante)
import { $, icons, store, clientId } from './util.js';
import { code, params, createPanel, setFontSize, shareModal, showTimer, showAnnounce, fatal, askName } from './shell.js';

// ─── Arranque ────────────────────────────────────────────────────────────────
async function boot() {
  setFontSize(0);
  const [me, ex] = await Promise.all([
    fetch('/api/me').then(r => r.json()).catch(() => ({})),
    fetch(`/api/rooms/${encodeURIComponent(code)}/exists`).then(r => r.json()).catch(() => ({ ok: false })),
  ]);
  if (!ex.ok) return fatal('Aula no encontrada', `No existe un aula con el código ${code}.`);
  document.title = `${ex.title} | R Aula Viva`;

  const asTeacher = !!me.teacher && params.get('vista') !== 'estudiante';
  let name = asTeacher ? (store.get('rav:teacherName') || 'Docente') : store.get('rav:name');
  if (!asTeacher && !name) name = await askName();
  if (!name) return fatal('Se requiere un nombre', 'Vuelva a intentarlo e indique su nombre.');

  const socket = io({
    auth: { room: code, role: asTeacher ? 'teacher' : 'student', name, clientId: clientId() },
    reconnectionDelayMax: 4000,
    autoConnect: false,   // se conecta después de registrar todos los manejadores
  });

  const panel = createPanel();
  const ctx = { code, socket, panel, name, role: asTeacher ? 'teacher' : 'student', state: null };

  const conn = (cls, label) => { $('#conn-chip').className = `chip ${cls}`; $('#conn-label').textContent = label; };
  socket.on('connect', () => conn('ok', 'En línea'));
  socket.on('disconnect', () => conn('bad', 'Sin conexión'));
  socket.io.on('reconnect_attempt', () => conn('busy', 'Reconectando'));
  socket.on('connect_error', err => {
    const map = {
      AULA_NO_EXISTE: ['Aula no encontrada', 'El aula fue eliminada o el código es incorrecto.'],
      NO_AUTORIZADO: ['Sesión docente vencida', 'Inicie sesión nuevamente en /docente.'],
      AULA_LLENA: ['El aula está llena', 'Se alcanzó el máximo de estudiantes conectados.'],
      NOMBRE_REQUERIDO: ['Se requiere un nombre', 'Indique su nombre para entrar.'],
    };
    if (map[err.message]) { socket.disconnect(); fatal(...map[err.message]); }
    else conn('bad', 'Sin conexión');
  });
  socket.on('room:closed', () => fatal('El aula fue cerrada', 'Su docente eliminó esta aula.'));
  socket.on('room:title', t => { ctx.state && (ctx.state.title = t); $('#room-title').textContent = t; document.title = `${t} | R Aula Viva`; });
  socket.on('announce', a => { if (ctx.state) ctx.state.announce = a; showAnnounce(a); });
  socket.on('timer', t => { if (ctx.state) ctx.state.timer = t; showTimer(t); });

  $('#code-chip').textContent = code;
  $('#code-chip').onclick = () => shareModal(code, ctx.state?.title || ex.title);
  $('#people-chip').onclick = () => (asTeacher ? panel.show('people') : null);
  $('#room-title').textContent = ex.title;

  // Estado completo (al entrar y en cada reconexión)
  socket.on('state', s => {
    ctx.state = s;
    $('#room-title').textContent = s.title;
    document.title = `${s.title} | R Aula Viva`;
    showAnnounce(s.announce);
    showTimer(s.timer);
  });
  socket.on('participants:count', n => { $('#people-count').textContent = n; });

  const mod = asTeacher ? await import('./teacher.js') : await import('./student.js');
  mod.setup(ctx);
  icons();
  socket.connect();
}

boot().catch(err => { console.error(err); fatal('No se pudo iniciar el aula', err.message); });
