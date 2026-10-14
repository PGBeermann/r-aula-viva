<?php
/**
 * upload.php  —  Backend completo para R-Notebook / UNACHI
 *
 * POST /upload.php                → sube notebook JSON, devuelve { ok, url, cells, file, savedAt }
 * GET  /upload.php?list=1         → lista todos los notebooks guardados
 * GET  /upload.php?delete=<file>  → elimina un notebook (proteger en producción)
 *
 * El frontend espera exactamente:
 *   POST  → { ok:true, url:"…", cells:N, file:"…", savedAt:"…" }
 *   ERROR → { ok:false, error:"mensaje" }  con código HTTP 4xx/5xx
 */

// ── CORS (necesario para fetch() cross-origin y para "Cargar desde URL") ──────
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

// Responder preflight sin más procesamiento
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ── Configuración ─────────────────────────────────────────────────────────────
define('UPLOAD_DIR', __DIR__ . '/uploads/');
define('MAX_BYTES',  4 * 1024 * 1024);  // 4 MB máximo por notebook

// URL base dinámica (ajustar SUBDIR si el script no está en la raíz del dominio)
$https   = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$baseUrl = rtrim($https . '://' . $_SERVER['HTTP_HOST'] . dirname($_SERVER['SCRIPT_NAME']), '/\\');

// ── Asegurar directorio de uploads ───────────────────────────────────────────
if (!is_dir(UPLOAD_DIR) && !mkdir(UPLOAD_DIR, 0755, true)) {
    jsonError(500, 'No se pudo crear el directorio de uploads en el servidor.');
}

// ── Enrutamiento ──────────────────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'POST') {
    handleUpload($baseUrl);

} elseif ($method === 'GET' && isset($_GET['list'])) {
    handleList($baseUrl);

} elseif (($method === 'GET' || $method === 'DELETE') && isset($_GET['delete'])) {
    handleDelete();

} else {
    jsonError(405, 'Método no soportado. Use POST para subir un notebook.');
}


// ═════════════════════════════════════════════════════════════════════════════
//  HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST → recibe JSON, valida, guarda y devuelve la URL pública.
 */
function handleUpload(string $baseUrl): void
{
    $body = (string) file_get_contents('php://input');

    if ($body === '') {
        jsonError(400, 'El cuerpo de la solicitud está vacío.');
    }

    if (strlen($body) > MAX_BYTES) {
        jsonError(413, sprintf(
            'El notebook supera el tamaño máximo permitido (%d MB).',
            MAX_BYTES / 1048576
        ));
    }

    // Validar JSON
    $data = json_decode($body, true);
    if ($data === null) {
        jsonError(400, 'JSON inválido: ' . json_last_error_msg());
    }

    // El frontend siempre envía un array "cells"
    if (!isset($data['cells']) || !is_array($data['cells'])) {
        jsonError(422, 'Formato incorrecto: falta el array "cells".');
    }

    $cellCount = count($data['cells']);

    // Nombre único: notebook_YYYYMMDD_HHMMSS_<hex>.json
    $slugPart = '';
    if (!empty($data['name']) && is_string($data['name'])) {
        $slugPart = preg_replace('/[^a-zA-Z0-9_-]/', '_', substr($data['name'], 0, 32)) . '_';
    }
    //$filename = 'notebook_' . $slugPart . date('Ymd_His') . '_' . bin2hex(random_bytes(5)) . '.json';
    $filename="notebook.json";
    $filepath = UPLOAD_DIR . $filename;

    if (file_put_contents($filepath, $body, LOCK_EX) === false) {
        jsonError(500, 'No se pudo escribir el archivo en el servidor.');
    }

    http_response_code(200);
    echo json_encode([
        'ok'      => true,
        'url'     => $baseUrl . '/uploads/' . rawurlencode($filename),
        'cells'   => $cellCount,
        'file'    => $filename,
        'savedAt' => date('c'),
    ]);
}

/**
 * GET ?list=1 → array de notebooks guardados, ordenados por fecha (más reciente primero).
 */
function handleList(string $baseUrl): void
{
    $files = glob(UPLOAD_DIR . '*.json');
    if ($files === false) {
        jsonError(500, 'No se pudo leer el directorio de uploads.');
    }

    usort($files, fn($a, $b) => filemtime($b) - filemtime($a));

    $notebooks = array_map(fn(string $path) => [
        'file'     => basename($path),
        'url'      => $baseUrl . '/uploads/' . rawurlencode(basename($path)),
        'size'     => filesize($path),
        'modified' => date('c', (int) filemtime($path)),
    ], $files);

    http_response_code(200);
    echo json_encode(['ok' => true, 'notebooks' => array_values($notebooks)]);
}

/**
 * GET/DELETE ?delete=<filename> → elimina un notebook.
 * ⚠ Proteger con autenticación antes de usar en producción.
 */
function handleDelete(): void
{
    $filename = basename((string) ($_GET['delete'] ?? ''));

    if ($filename === '' || pathinfo($filename, PATHINFO_EXTENSION) !== 'json') {
        jsonError(400, 'Nombre de archivo inválido. Solo se permiten archivos .json.');
    }

    $filepath = UPLOAD_DIR . $filename;

    if (!file_exists($filepath)) {
        jsonError(404, 'Archivo no encontrado: ' . $filename);
    }

    if (!unlink($filepath)) {
        jsonError(500, 'No se pudo eliminar el archivo.');
    }

    http_response_code(200);
    echo json_encode(['ok' => true, 'deleted' => $filename]);
}


// ═════════════════════════════════════════════════════════════════════════════
//  UTILIDADES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Emite una respuesta JSON de error y termina el script.
 */
function jsonError(int $code, string $message): never
{
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $message]);
    exit;
}
