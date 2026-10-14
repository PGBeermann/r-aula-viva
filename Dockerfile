# R Aula Viva — imagen de producción (Dokploy / Docker)
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

# Dependencias (capa cacheable). webR se sirve desde node_modules/webr/dist.
COPY package.json package-lock.json ./
# Se eliminan herramientas de desarrollo que el paquete webr arrastra como dependencias
# (REPL/compilación); en tiempo de ejecución sólo se usan los archivos de webr/dist.
RUN npm ci --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/react-icons node_modules/@esbuild node_modules/esbuild \
           node_modules/lightningcss* node_modules/tsx \
 && npm cache clean --force

# Código de la aplicación
COPY server.js ./
COPY public ./public
COPY seed ./seed

# Carpeta persistente (aulas y biblioteca de cuadernos) con usuario sin privilegios
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
