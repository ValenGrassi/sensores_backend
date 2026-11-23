# Backend — Sistema de Monitoreo de Temperatura y Humedad

API REST que recibe la telemetría de sensores LoRaWAN de temperatura y humedad a través de un gateway, guarda el estado actual y el histórico de cada sensor, y genera alertas cuando una lectura sale de los rangos definidos para la sala donde está instalado.

El dominio está organizado así: **Cine → Salas → Sensores**. Cada sala tiene asignado un **Perfil** con los rangos permitidos de temperatura y humedad.

| Documento | Contenido |
|---|---|
| [README.md](README.md) (este archivo) | Arquitectura, instalación, configuración, acceso, despliegue y reglas de negocio |
| [docs/API.md](docs/API.md) | Referencia completa de los endpoints: parámetros, cuerpos, respuestas y errores |
| [docs/DATABASE.md](docs/DATABASE.md) | Modelo de datos, tablas, relaciones, índices, migraciones y SQL útil |

---

## 1. Stack

| Componente | Versión | Uso |
|---|---|---|
| Node.js | `^20.19`, `^22.12` o `>=24` | Requisito de Prisma 7 |
| Express | 5.2 | Servidor HTTP / API REST |
| Prisma ORM | 7.9 | Cliente de base de datos y migraciones |
| `@prisma/adapter-pg` + `pg` | 7.9 / 8.23 | Driver adapter de PostgreSQL que usa Prisma 7 |
| PostgreSQL | — | Base de datos (actualmente alojada en Supabase) |
| `cors`, `dotenv` | — | CORS y carga de variables de entorno |

El proyecto usa **CommonJS** (`require`) y no tiene paso de build. No tiene dependencias nuevas respecto de la versión anterior: validación, claves y tests usan solo módulos de Node.

---

## 2. Arquitectura y flujo de datos

```
 ┌────────────┐ LoRaWAN ┌─────────┐ POST /api/telemetry (sin clave) ┌───────────────────────────────┐
 │ Sensor T/H │ ──────▶ │ Gateway │ ──────────────────────────────▶ │ Backend (Express)             │
 └────────────┘         └─────────┘                                 │  1. upsert Sensor             │
                                                                    │  2. insert Measurement        │──▶ PostgreSQL
 ┌────────────────────┐  GET  /api/*   (público)                     │  3. evaluateSensorAlerts      │    (Prisma)
 │ Tu frontend        │ ─────────────────────────────────────────▶  │                               │
 │ u otra aplicación  │  POST/PATCH/DELETE  (header X-API-Key)       │  Errores: { error: { code,    │
 └────────────────────┘ ─────────────────────────────────────────▶  │    message, requestId } }     │
                                                                    └───────────────────────────────┘
```

1. El gateway envía cada lectura a `POST /api/telemetry`. Ese endpoint **no cambió**: mismo path, sin clave, mismos campos, responde `200 OK`.
2. El backend busca el sensor por su `devEUI`. Si no está registrado, **descarta la lectura** y lo deja en el log (ver [6.1](#61-registro-de-sensores)). Igual responde `200`.
3. Se guarda una fila en `Measurement` (histórico), salvo que sea una **repetición**: misma temperatura y humedad que la última, a menos de 30 s.
4. Si la lectura es **más nueva** que la última del sensor, actualiza su estado actual. Una lectura vieja reenviada va al histórico, pero no pisa el estado.
5. Con la lectura más nueva se reevalúan las alertas del sensor (ver [6.3](#63-alertas)). Si esa evaluación falla, la lectura igual queda guardada y se responde `200` para que el gateway no la reenvíe.
6. Las lecturas (`GET`) son públicas. Las escrituras exigen una clave de API con el permiso correspondiente.

---

## 3. Estructura del proyecto

```
backend/
├── prisma/
│   ├── schema.prisma              # Modelo de datos (fuente de verdad)
│   └── migrations/                # 9 migraciones SQL versionadas
├── prisma.config.ts               # Config de la CLI de Prisma (usa DIRECT_URL)
├── scripts/
│   ├── api-clients.js             # Crear / listar / revocar claves de terceros
│   └── sensors.js                 # Registrar y listar sensores
├── test/                          # npm test (no necesita base de datos)
│   ├── alerts.test.js             # Lógica de alertas
│   ├── rateLimit.test.js          # Límites de pedidos
│   ├── telemetry.test.js          # Fecha del gateway y batería
│   └── measurements.test.js       # Elección de resolución del historial
├── src/
│   ├── server.js                  # Arranque: carga .env, escucha el puerto, apagado ordenado
│   ├── app.js                     # Arma la app: middlewares y rutas, en orden
│   ├── config.js                  # Variables de entorno con sus valores por defecto
│   ├── lib/
│   │   ├── prisma.js              # Instancia única de PrismaClient
│   │   ├── errors.js              # Catálogo de errores (código + mensaje)
│   │   ├── validation.js          # Validación de body y query sin dependencias
│   │   ├── apiKeys.js             # Generar, hashear y resolver claves de API
│   │   ├── permissions.js         # Permisos de escritura disponibles
│   │   ├── rateLimit.js           # Contadores por ventana e IP de cada cliente
│   │   ├── clientIp.js            # IP real de quien llama (CF-Connecting-IP o proxy)
│   │   └── migrations.js          # Detecta migraciones sin aplicar
│   ├── middleware/
│   │   ├── requestId.js           # Header X-Request-Id
│   │   ├── auth.js                # identifyClient + requirePermission
│   │   ├── rateLimit.js           # Límites de pedidos (por IP o por clave)
│   │   └── errorHandler.js        # 404 JSON y manejo central de errores
│   ├── routes/                    # Un archivo por recurso
│   │   ├── telemetry.js  sensors.js  profiles.js  cinemas.js  rooms.js
│   │   ├── alerts.js     measurements.js  stats.js  system.js (health, me)
│   ├── services/
│   │   ├── alerts.js              # Lógica de alertas (planAlertChanges + evaluateSensorAlerts)
│   │   ├── sensors.js             # Estado online/offline y forma pública del sensor
│   │   ├── measurements.js        # Historial agregado (promedios por hora o día)
│   │   └── stats.js               # Indicadores de /api/stats y /api/dashboard
│   └── generated/prisma/          # Cliente Prisma generado — NO se versiona
├── .env.example
└── package.json
```

---

## 4. Puesta en marcha (local)

```bash
cd backend
npm install
cp .env.example .env          # completar DATABASE_URL, DIRECT_URL y ADMIN_API_KEY
npx prisma generate           # obligatorio: src/generated/prisma no se versiona
npx prisma migrate deploy     # crea o actualiza las tablas
npm start                     # http://localhost:5000
npm test                      # tests de la lógica de alertas (no necesitan base)
```

### 4.1 Variables de entorno

| Variable | Obligatoria | Default | Descripción |
|---|---|---|---|
| `DATABASE_URL` | Sí | — | Conexión en tiempo de ejecución. En Supabase, el *transaction pooler* (6543, `?pgbouncer=true`) |
| `DIRECT_URL` | Sí (CLI) | — | Conexión para migraciones. En Supabase, el *session pooler* (5432) |
| `ADMIN_API_KEY` | Recomendada | — | Tu clave con todos los permisos de escritura. Sin ella, solo escriben los clientes creados con el script |
| `CORS_ORIGINS` | No | `https://sensorescinemark.netlify.app` | Dominios que pueden llamar desde un navegador, separados por coma. `*` = cualquiera |
| `PORT` | No | `5000` | Render lo define solo |
| `SENSOR_OFFLINE_MINUTES` | No | `30` | Minutos sin datos para considerar un sensor offline |
| `TELEMETRY_AUTO_CREATE` | No | `false` | `true` = un devEUI desconocido crea un sensor nuevo, como antes. Con `false` hay que registrarlo con `npm run sensors -- add` |
| `RATE_LIMIT_ENABLED` | No | `true` | `false` apaga los límites de pedidos (para emergencias) |
| `CLIENT_IP_HEADER` | No | `cf-connecting-ip` | Header con la IP real de quien llama. En Render lo escribe Cloudflare. `none` = no usar ningún header. Ver [7.3](#73-verificar-la-ip-después-de-desplegar) |
| `TRUST_PROXY` | No | `1` | Solo se usa si el pedido no trae `CLIENT_IP_HEADER` (por ejemplo en local): cantidad de proxies delante del servidor |
| `TIME_ZONE` | No | `America/Argentina/Buenos_Aires` | Zona horaria para agrupar el historial por día |

Si no definís ninguna variable nueva, el backend se comporta como antes en CORS, puerto y offline. La única diferencia es que **nadie puede escribir** hasta que definas `ADMIN_API_KEY` o crees un cliente.

### 4.2 Scripts

| Script | Para qué |
|---|---|
| `npm start` / `npm run dev` | Levantar el servidor |
| `npm test` | Tests de alertas, telemetría, límites de pedidos e historial (no necesitan base) |
| `npm run sensors -- add <devEui> ["Nombre"]` | Registrar un sensor antes de instalarlo |
| `npm run sensors -- list` | Listar sensores, sala, estado y última lectura |
| `npm run clients -- admin-key` | Generar una clave para `ADMIN_API_KEY` |
| `npm run clients -- create --name "App de Juan" --permissions sensors:write` | Crear una clave para un tercero (se muestra **una sola vez**) |
| `npm run clients -- list` | Listar clientes, permisos, estado y último uso |
| `npm run clients -- revoke <id>` | Revocar una clave (deja de funcionar en menos de 1 minuto) |

---

## 5. Acceso y permisos

| Operación | Quién puede |
|---|---|
| Todas las lecturas (`GET`) | Cualquiera, sin clave |
| `POST /api/telemetry` | El gateway (sin clave; no se documenta a terceros) |
| `PATCH /api/sensors/:devEui` (nombre y sala) | Clave con `sensors:write` o la de administrador |
| `POST`, `PATCH`, `DELETE /api/profiles` | Clave con `profiles:write` o la de administrador |
| Crear sensores, cines o salas | **Nadie por la API.** Los sensores se registran con `npm run sensors -- add`; cines y salas se cargan en la base |
| Crear o revocar claves | Solo vos, con el script, desde tu computadora |

- La clave se envía en el header `X-API-Key`.
- En la base solo se guarda el hash SHA-256 de cada clave.
- Una clave inválida o revocada responde `401` en cualquier petición, aunque sea un `GET`. Así quien integra se entera enseguida.
- Tu frontend guarda la clave de administrador en el navegador. Se carga en **Configuración → Acceso de administrador**, y la manda solo en las escrituras.

### 5.1 Límites de pedidos

Protegen la instancia de Render, su ancho de banda y la base de datos de un uso excesivo (por error o a propósito). Los valores están en `src/config.js` → `rateLimit`.

| | Sin clave (por IP) | Clave de tercero (por clave) | Tu clave de admin |
|---|---|---|---|
| Pedidos | 120/min · 30.000/día | 300/min · 50.000/día | Sin límite |
| Consultas de historial | 20/min · 500/día | 30/min · 1.000/día | Sin límite |
| Escrituras | — | 30/min | Sin límite |

- **La telemetría del gateway no tiene ningún límite** y no gasta el cupo de la IP del cine.
- "Historial" = `GET /api/sensors/:devEui/measurements`, `GET /api/measurements` y `GET /api/alerts` (salvo `?active=true`).
- 20 claves inválidas en 10 minutos desde una IP → `429` para los pedidos con clave de esa IP durante esa ventana.
- Al pasarse: `429 RATE_LIMITED` con `Retry-After`. Cada respuesta trae `RateLimit-Limit`, `RateLimit-Remaining` y `RateLimit-Reset`.
- Los contadores viven en memoria: se reinician si el servicio se reinicia. Alcanza porque corre una sola instancia.
- Topes de tamaño: `pageSize` hasta 500; `GET /api/alerts` devuelve 200 por defecto (hasta 500, con paginación por `cursor`); el historial de un sensor usa promedios por hora o por día en rangos de más de 7 días.

Tu frontend hace ~4 pedidos por minuto por pestaña abierta, así que el límite por IP alcanza para ~30 pestañas desde la misma red.

---

## 6. Reglas de negocio

### 6.1 Registro de sensores

- El identificador público del sensor es su **DevEUI** LoRaWAN. Se guarda en minúsculas y es único.
- Un sensor se registra con `npm run sensors -- add <devEui> ["Nombre"]`, desde tu computadora. Queda **sin sala**: se la asignás desde el frontend (Sensores > el sensor > Configurar).
- Si llega una lectura de un DevEUI no registrado, se descarta, se responde `200` igual y el log muestra `Sensor desconocido <devEui>` con el comando para registrarlo.
- Con `TELEMETRY_AUTO_CREATE=true` vuelve el comportamiento anterior: el sensor se crea solo con `name = deviceName`.
- Si `gatewayTime` viene más de 5 minutos en el futuro, se usa la hora del servidor. Si no, el sensor quedaría "congelado" esperando una lectura más nueva.
- `Sensor.battery` es un porcentaje entero (se redondea); en `Measurement` queda el valor recibido.
- Una lectura con la misma temperatura y humedad que la última, recibida menos de 30 s después, es la misma transmisión repetida: se ignora (responde `200`). En ago–sep 2026 hubo 581 así, a 2–3 s. Sin esto, una repetición contaría como "2 lecturas seguidas" para las alertas.

### 6.2 Estado online / offline

`online` si `lastSeen` existe y tiene menos de `SENSOR_OFFLINE_MINUTES` (30). Si no, `offline`. Se calcula en cada respuesta.

### 6.3 Alertas

Código: [src/services/alerts.js](src/services/alerts.js). Se evalúa en tres momentos:
- con cada lectura de telemetría (solo si es la más nueva del sensor);
- al cambiar un perfil, para todos los sensores que lo usan;
- al mover un sensor de sala.

Cada métrica (temperatura y humedad) se evalúa **por separado** contra el perfil, y el resultado se *reconcilia* con las alertas activas:

| Valor de la métrica | Resultado |
|---|---|
| mayor que el máximo | Tiene que haber una alerta activa `<métrica>_high`; las demás de esa métrica se resuelven. Se **abre** solo si la lectura anterior con dato también estaba por encima |
| menor que el mínimo | Tiene que haber una alerta activa `<métrica>_low`; las demás de esa métrica se resuelven. Se **abre** solo si la lectura anterior con dato también estaba por debajo |
| dentro del rango (límites inclusivos) | Se resuelven las alertas activas de esa métrica |
| sin dato (`null`) | No se toca nada de esa métrica: que falte el dato no significa que esté bien |

- Para abrir una alerta hacen falta **2 lecturas seguidas** fuera de rango (`READINGS_TO_OPEN`). Para cerrarla alcanza 1 en rango. Así un valor que oscila sobre el límite no abre y cierra alertas.
- Las lecturas sin ese dato (el gateway manda algunas vacías) no cuentan ni cortan la racha.
- Si el sensor no tiene sala o perfil, no se monitorea y se resuelven sus alertas.
- Las alertas que hay que resolver y las que hay que crear se aplican en una sola transacción.
- **La base garantiza una sola alerta activa por sensor y tipo** (índice único parcial `Alert_sensorId_type_key`). Si dos lecturas simultáneas intentan crear la misma, la base rechaza la segunda y esa evaluación se repite con el estado nuevo.
- Si quedaran duplicados de antes, se conserva el más viejo.
- La evaluación es idempotente: si una falla, la siguiente deja todo correcto.

### 6.4 Estado de un cine

`attention` si hay algún sensor offline o alguna alerta activa en sus salas. Si no, `ok`.

---

## 7. Despliegue

### 7.1 Orden recomendado para pasar a una versión nueva sin cortar el servicio

1. **Frontend primero (Netlify).** Las versiones nuevas del frontend funcionan con el backend anterior y con el nuevo.
2. **Migraciones** (solo si la versión trae alguna nueva), desde tu computadora: `npx prisma migrate deploy`. Se diseñan para ser compatibles con el backend anterior.
3. **Variables en Render**, si la versión agrega alguna obligatoria.
4. **Backend (Render):** subí los cambios. Verificá `GET /api/health`: tiene que decir `"status": "ok"` y `"schema": "ok"`.

El gateway no necesita ningún cambio en ningún paso.

**Límites de pedidos (esta versión):** no trae migraciones ni variables obligatorias. Orden: frontend → backend → [verificar la IP](#73-verificar-la-ip-después-de-desplegar).

### 7.2 Render

- **Build:** tiene que incluir `npx prisma generate` (el cliente no se versiona). Opcional: agregar `npx prisma migrate deploy` al build para no correr las migraciones a mano. Eso requiere `DIRECT_URL` configurada en Render.
- **Start:** `npm start`.
- **Health check path** (opcional): `/api/health`.

### 7.3 Verificar la IP después de desplegar

Los límites sin clave se cuentan por IP, así que el servidor tiene que ver la IP real de cada cliente.

En Render, cada pedido pasa por Cloudflare y por el proxy de Render, y la cantidad de saltos en `X-Forwarded-For` no es fija. Por eso la IP se toma del header `CF-Connecting-IP`, que escribe Cloudflare con la IP real y pisa el que mande el cliente. Si ese header falta, se usa `X-Forwarded-For` según `TRUST_PROXY`.

1. Abrí `https://<tu-backend>/api/me` desde tu computadora y mirá el campo `ip`.
2. Compará con tu IP pública (por ejemplo, https://api.ipify.org). Recargá varias veces: tiene que dar siempre la misma.
3. Desde el celular con datos móviles tiene que dar otra IP.
4. Si da una IP de Cloudflare (empieza con `104.`, `162.158.` o `172.64.` a `172.71.`) y cambia en cada pedido, el header no está llegando: avisá antes de tocar `TRUST_PROXY`.

Si algo falla con los límites en producción, `RATE_LIMIT_ENABLED=false` en Render los apaga sin tocar el código.

---

## 8. Seguridad

- Lectura pública, escritura con clave y permisos ([sección 5](#5-acceso-y-permisos)).
- `POST /api/telemetry` sigue abierto porque el gateway instalado no puede mandar una clave. Ver alternativas en la parte interna del documento de recomendaciones.
- CORS limita solo a los navegadores. No impide llamadas desde `curl`, Postman u otro servidor.
- `.env` contiene las credenciales de la base. **No se comparte ni se versiona.**
- Los errores nunca exponen detalles internos. El detalle queda en los logs, junto con el `requestId` que también recibe el cliente.

---

## 9. Limitaciones conocidas

- **Límites en memoria:** si algún día corren varias instancias del backend, cada una cuenta por separado (habría que pasar los contadores a una base compartida, como Redis). La telemetría no tiene límite a propósito.
- **Telemetría:** no hay índice único en `Measurement(sensorId, timestamp)`: las repeticiones reales llegan con timestamps distintos y no las frenaría. Las 581 repeticiones de ago–sep 2026 siguen en el histórico (no afectan promedios porque tienen los mismos valores).
- No hay endpoints para cines y salas (alta, edición, baja), ni para desasignar un sensor.
