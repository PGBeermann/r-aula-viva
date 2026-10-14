# R Aula Viva 2.0

Cuaderno de R colaborativo para clases en línea, en tiempo real. El docente escribe y ejecuta código R en su navegador. Cada estudiante conectado ve, al instante y sin instalar nada:

- el texto de cada celda mientras se escribe, con el cursor y la selección del docente resaltados;
- las salidas de texto (resultados, mensajes, advertencias y errores con sus colores);
- los gráficos (PNG) de R base, `ggplot2` y otros.

**Autor:** Dr. Pedro González Beermann, Escuela de Química, Universidad Autónoma de Chiriquí (UNACHI).

---

## 1. Arquitectura

```
Navegador del DOCENTE ──(Socket.IO / WebSocket)──► Servidor Node.js ──► Navegadores de ESTUDIANTES
  webR (R 4.6 en WebAssembly)                       Express 5 + Socket.IO 4       (vista en vivo)
  ejecuta el código y envía                         • guarda el estado del aula     «Mi espacio»: webR propio
  código + salidas + gráficos                         en /app/data (JSON)           opcional, en su navegador
                                                    • sirve webR, CodeMirror,
                                                      KaTeX, etc. desde el VPS
```

- **El servidor no ejecuta R.** El código corre en el navegador del docente con [webR](https://docs.r-wasm.org/webr/latest/). Por eso un VPS pequeño basta, aunque haya muchos estudiantes conectados.
- El servidor envía las cabeceras `Cross-Origin-Opener-Policy: same-origin` y `Cross-Origin-Embedder-Policy: require-corp`. Con ellas la página queda *cross-origin isolated* y webR usa el canal `SharedArrayBuffer`, que permite **interrumpir** la ejecución (botón «Detener») (ver [webR: Serving Pages with WebR](https://docs.r-wasm.org/webr/latest/serving.html)).
- Todas las librerías del cliente se sirven desde el mismo servidor (no hay CDN): webR 0.6.0, CodeMirror 5, KaTeX con mhchem, marked, DOMPurify y Lucide.
- El estado de cada aula (celdas, salidas, gráficos, preguntas y entregas) se guarda en `DATA_DIR/rooms/*.json`. Un estudiante que entra tarde recibe el cuaderno completo.

## 2. Funciones para la clase

| Docente | Estudiante |
|---|---|
| Celdas R y celdas de texto (Markdown + LaTeX `$…$`, `$$…$$` y química `\ce{H2SO4}`) | Vista en vivo, con el cursor del docente resaltado |
| Ejecutar celda (Ctrl+Enter), ejecutar y avanzar (Mayús+Enter), «Ejecutar todo», «Detener» | **Seguir al docente**: desplazamiento automático hasta la celda activa |
| Paquetes de webR (`ggplot2`, `dplyr`…) que quedan registrados en el aula | **Probar**: copia una celda a «Mi espacio» y la ejecuta en su propio navegador |
| Biblioteca de cuadernos en el servidor (guardar con Ctrl+S, abrir, eliminar) | **Enviar al docente** el código y su salida, con un comentario |
| Importar `.json` (formato anterior incluido), `.R` (knitr::spin), `.Rmd`, `.qmd` e `.ipynb`, o desde una URL | Preguntas privadas al docente, con respuesta individual |
| Panel de participantes con manos levantadas | ✋ Levantar la mano y reacciones rápidas (👍 👏 🤔 😕 🐢 🚀) |
| Preguntas: responder, marcar como resuelta, **proyectar** a toda la clase | Encuestas emergentes |
| Entregas: revisar e **insertar en el cuaderno** para discutirlas | Ampliar y descargar gráficos |
| Encuestas con plantillas («¿Comprendieron?», ritmo, V/F, A-B-C-D) y resultados en vivo | Descargar el cuaderno (HTML con gráficos, `.R` o `.json`) |
| Anuncios, temporizador compartido, invitación con código QR | Tamaño de letra ajustable; funciona en el teléfono |
| Permisos: descargas, preguntas, entregas, ejecución local | |
| Exportar: `.R`, `.json`, reporte HTML con gráficos, PDF (impresión) | |

## 3. Ejecución local (desarrollo)

Requiere Node.js 20 o superior.

```bash
npm install
TEACHER_PASSWORD=una-clave SESSION_SECRET=algo-largo npm start
# Windows PowerShell:
# $env:TEACHER_PASSWORD="una-clave"; $env:SESSION_SECRET="algo-largo"; npm start
```

- Panel docente: http://localhost:3000/docente
- Estudiantes: http://localhost:3000 (con el código del aula)

## 4. Despliegue en un VPS de Hostinger con Dokploy

### 4.1 Requisitos previos

1. Un VPS de Hostinger con Dokploy instalado. Hostinger ofrece una plantilla de VPS con Dokploy preinstalado ([guía de Hostinger](https://support.hostinger.com/en/articles/9822596-how-to-use-the-dokploy-vps-template)); también puede instalarse con el script oficial ([docs.dokploy.com](https://docs.dokploy.com/docs/core/installation)).
2. Un subdominio que apunte al VPS. En el DNS (hPanel → Dominios → DNS) cree un registro **A**, por ejemplo `raula` → `IP del VPS`.
3. Este proyecto en un repositorio de GitHub (por ejemplo `PGBeermann/r-aula-viva`). Puede ser privado y conectarse a Dokploy con la integración de GitHub.

### 4.2 Crear la aplicación (recomendado: tipo *Application* con Dockerfile)

1. En Dokploy: **Projects → Create Project**, luego **Create Service → Application**.
2. **General → Provider:** GitHub → repositorio `r-aula-viva`, rama `main`.
3. **Build Type:** `Dockerfile` (ruta `./Dockerfile`).
4. **Environment:** pegue el contenido de `.env.example` y complete los valores:
   ```env
   TEACHER_PASSWORD=una-frase-larga-y-secreta
   SESSION_SECRET=<salida de: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   PUBLIC_URL=https://raula.sudominio.com
   ```
5. **Advanced → Mounts → Add Volume:** *Volume Mount*, Volume Name `raula-data`, **Mount Path `/app/data`**. Sin este volumen, las aulas y la biblioteca se pierden en cada despliegue.
6. **Domains → Add Domain:** Host `raula.sudominio.com`, Path `/`, **Container Port `3000`**, HTTPS activado y Certificate `letsencrypt`.
7. **Deploy.** Después revise **Logs**. Deben aparecer las líneas `R Aula Viva escuchando en http://0.0.0.0:3000` y `Aulas cargadas: N`.
8. Pruebe `https://raula.sudominio.com/health`. Debe devolver `{"ok":true,…}`.

Traefik, el proxy de Dokploy, transmite WebSockets sin configuración adicional. La aplicación confía en `X-Forwarded-Proto` (`trust proxy`), así que la cookie de sesión docente se marca como `Secure` cuando se entra por HTTPS.

### 4.3 Alternativa: tipo *Docker Compose*

Use el archivo `docker-compose.yml` incluido. Las variables se definen en la pestaña **Environment** y el dominio en **Domains** (servicio `r-aula-viva`, puerto `3000`). Dokploy recomienda volúmenes con nombre, como `raula-data` en este archivo, porque son los únicos que admiten *Volume Backups* ([docs](https://docs.dokploy.com/docs/core/docker-compose)).

### 4.4 Actualizaciones y respaldos

- Con **Autodeploy** activado, cada `git push` a `main` reconstruye y despliega la aplicación. El volumen `/app/data` se conserva.
- Para respaldar, use **Volume Backups** de Dokploy (S3), o copie el contenido del volumen `raula-data`. Cada aula también se puede descargar en `/api/rooms/<CÓDIGO>/export.json` desde el panel docente.

### 4.5 Uso de recursos del VPS

- La primera vez que alguien inicia R (el docente, o un estudiante en «Mi espacio») el navegador descarga unos 20 MB comprimidos de webR. Después quedan en caché por 7 días.
- Si muchos estudiantes usarán «Mi espacio» al mismo tiempo, defina `WEBR_BASE_URL=https://webr.r-wasm.org/v0.6.0/` para que webR se descargue del CDN oficial y no del VPS.
- Los paquetes adicionales siempre se descargan de `https://repo.r-wasm.org/`.

## 5. Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `TEACHER_PASSWORD` | Sí | Contraseña del panel docente. Si falta, el acceso docente queda deshabilitado. |
| `SESSION_SECRET` | Sí | Secreto HMAC de la cookie docente. Si cambia, se cierran las sesiones. |
| `PUBLIC_URL` | No | URL pública que se usa en el código QR. |
| `PORT` | No | Puerto interno (por defecto 3000). |
| `DATA_DIR` | No | Carpeta de datos (por defecto `/app/data` en Docker). |
| `SESSION_HOURS` | No | Duración de la sesión docente (12 h por defecto). |
| `MAX_STUDENTS_PER_ROOM` | No | Máximo de estudiantes por aula (150 por defecto). |
| `DEFAULT_PACKAGES` | No | Paquetes que se registran en cada aula nueva, por ejemplo `ggplot2,dplyr`. |
| `WEBR_BASE_URL` | No | Origen de webR: `/vendor/webr/` (local) o el CDN oficial. |
| `WEBR_REPO_URL` | No | Repositorio de paquetes webR. |

## 6. Seguridad

- La sesión docente usa una cookie `HttpOnly`, `SameSite=Strict`, firmada con HMAC-SHA256 y con vencimiento. Tras 10 intentos fallidos, el inicio de sesión se bloquea 15 minutos por IP.
- Los eventos de edición, ejecución y moderación se aceptan únicamente desde conexiones docentes autenticadas, y el servidor valida tamaños y tipos. Los eventos de estudiantes tienen límite de frecuencia.
- El Markdown se limpia con DOMPurify. Los nombres, preguntas y salidas se escapan antes de mostrarse. Las imágenes sólo se aceptan como `data:image/png;base64`.
- El código de los estudiantes nunca se ejecuta en el servidor ni en el navegador del docente, salvo que el docente lo inserte en el cuaderno y lo ejecute él mismo.

## 7. Estructura

```
server.js              Servidor (Express + Socket.IO), autenticación, persistencia y API
public/index.html      Ingreso de estudiantes
public/docente.html    Inicio de sesión y gestión de aulas
public/aula.html       Aula (docente / estudiante)
public/js/             aula.js · shell.js · teacher.js · student.js · notebook.js · runner.js · render.js · util.js
public/css/app.css     Estilos
seed/notebooks/        Cuadernos de ejemplo que se copian a la biblioteca la primera vez
Dockerfile · docker-compose.yml · .env.example
legacy/                Versión anterior (R.html, index.html, upload.php…)
```

## 8. Referencias

- Stagg, G. y Henry, L. *webR: R in the browser* (v0.6.0), Posit Software. https://docs.r-wasm.org/webr/latest/
- webR — *Serving pages with webR* (COOP/COEP). https://docs.r-wasm.org/webr/latest/serving.html
- Socket.IO v4 — documentación. https://socket.io/docs/v4/
- Dokploy — Applications, Docker Compose, Domains. https://docs.dokploy.com/docs/core
- KaTeX — extensión mhchem. https://katex.org/docs/libs
- Montgomery, D. C. (2017). *Design and Analysis of Experiments* (9th ed.). Wiley. Datos del cuaderno de ejemplo (Ejemplos 4.3 y 4.4).
