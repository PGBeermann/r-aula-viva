const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT       = 3737;
const ROOT       = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');

// Crear uploads/ si no existe
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function setCOIHeaders(res) {
  res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
}

function jsonError(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // ── POST /upload ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/upload') {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {       // límite 2 MB
        req.destroy();
        jsonError(res, 413, 'Archivo demasiado grande (máx. 2 MB).');
      }
    });

    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch {
        return jsonError(res, 400, 'JSON inválido.');
      }

      if (!data.cells || !Array.isArray(data.cells)) {
        return jsonError(res, 422, 'El JSON no contiene un array "cells" válido.');
      }

      const ts       = new Date().toISOString().slice(0,19).replace(/[-T:]/g, '').replace('',
                         s => s.slice(0,8) + '_' + s.slice(8));
      const rand     = crypto.randomBytes(4).toString('hex');
      const filename = `nb_${Date.now()}_${rand}.json`;
      const filepath = path.join(UPLOAD_DIR, filename);

      fs.writeFile(filepath, body, err => {
        if (err) return jsonError(res, 500, 'Error al guardar el archivo.');
        const url = `http://localhost:${PORT}/uploads/${filename}`;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, url, filename,
          cells: data.cells.length,
          savedAt: data.savedAt || null,
        }));
      });
    });
    return;
  }

  // ── GET estático ────────────────────────────────────────────────────────────
  setCOIHeaders(res);

  let filePath = path.join(ROOT, urlPath === '/' ? '/R.html' : urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`R-Notebook server → http://localhost:${PORT}`);
  console.log(`Upload endpoint   → POST http://localhost:${PORT}/upload`);
});
