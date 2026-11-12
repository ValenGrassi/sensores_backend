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
2. El backend busca el sensor por su `devEUI`. Si no existe, **lo crea automáticamente**; si existe, actualiza sus valores actuales.
3. Se guarda una fila en `Measurement` (histórico).
4. Se reevalúan las alertas del sensor (ver [6.3](#63-alertas)). Si esa evaluación falla, la lectura igual queda guardada y se responde `200` para que el gateway no la reenvíe.
5. Las lecturas (`GET`) son públicas. Las escrituras exigen una clave de API con el permiso correspondiente.

---

## 3. Estructura del proyecto

```
backend/
├── prisma/
│   ├── schema.prisma              # Modelo de datos (fuente de verdad)
│   └── migrations/                # 8 migraciones SQL versionadas
├── prisma.config.ts               # Config de la CLI de Prisma (usa DIRECT_URL)
├── scripts/
│   └── api-clients.js             # Crear / listar / revocar claves de terceros
├── test/
│   └── alerts.test.js             # Tests de la lógica de alertas (npm test)
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
│   │   └── migrations.js          # Detecta migraciones sin aplicar
│   ├── middleware/
│   │   ├── requestId.js           # Header X-Request-Id
│   │   ├── auth.js                # identifyClient + requirePermission
│   │   └── errorHandler.js        # 404 JSON y manejo central de errores
│   ├── routes/                    # Un archivo por recurso
│   │   ├── telemetry.js  sensors.js  profiles.js  cinemas.js  rooms.js
│   │   ├── alerts.js     measurements.js  stats.js  system.js (health, me)
│   ├── services/
│   │   ├── alerts.js              # Lógica de alertas (planAlertChanges + evaluateSensorAlerts)
│   │   ├── sensors.js             # Estado online/offline y forma pública del sensor
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

Si no definís ninguna variable nueva, el backend se comporta como antes en CORS, puerto y offline. La única diferencia es que **nadie puede escribir** hasta que definas `ADMIN_API_KEY` o crees un cliente.

### 4.2 Scripts

| Script | Para qué |
|---|---|
| `npm start` / `npm run dev` | Levantar el servidor |
| `npm test` | Tests de la lógica de alertas |
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
| Crear sensores, cines o salas | **Nadie por la API.** Los sensores se crean solos con la telemetría; cines y salas se cargan en la base |
| Crear o revocar claves | Solo vos, con el script, desde tu computadora |

- La clave se envía en el header `X-API-Key`.
- En la base solo se guarda el hash SHA-256 de cada clave.
- Una clave inválida o revocada responde `401` en cualquier petición, aunque sea un `GET`. Así quien integra se entera enseguida.
- Tu frontend guarda la clave de administrador en el navegador. Se carga en **Configuración → Acceso de administrador**, y la manda solo en las escrituras.

---

## 6. Reglas de negocio

### 6.1 Alta automática de sensores

- El identificador público del sensor es su **DevEUI** LoRaWAN. Se guarda en minúsculas y es único.
- Cuando llega una lectura de un DevEUI desconocido, se crea el sensor con `name = deviceName` y **sin sala**.
- El nombre solo cambia después con `PATCH /api/sensors/:devEui`.

### 6.2 Estado online / offline

`online` si `lastSeen` existe y tiene menos de `SENSOR_OFFLINE_MINUTES` (30). Si no, `offline`. Se calcula en cada respuesta.

### 6.3 Alertas

Código: [src/services/alerts.js](src/services/alerts.js). Se evalúa en tres momentos:
- con cada lectura de telemetría;
- al cambiar un perfil, para todos los sensores que lo usan;
- al mover un sensor de sala.

Cada métrica (temperatura y humedad) se evalúa **por separado** contra el perfil, y el resultado se *reconcilia* con las alertas activas:

| Valor de la métrica | Resultado |
|---|---|
| mayor que el máximo | Tiene que haber una alerta activa `<métrica>_high`; las demás de esa métrica se resuelven |
| menor que el mínimo | Tiene que haber una alerta activa `<métrica>_low`; las demás de esa métrica se resuelven |
| dentro del rango (límites inclusivos) | Se resuelven las alertas activas de esa métrica |
| sin dato (`null`) | No se toca nada de esa métrica: que falte el dato no significa que esté bien |

- Si el sensor no tiene sala o perfil, no se monitorea y se resuelven sus alertas.
- Las alertas que hay que resolver y las que hay que crear se aplican en una sola transacción.
- Si hubiera duplicados del mismo tipo, se conserva el más viejo.
- La evaluación es idempotente: si una falla, la siguiente deja todo correcto.

### 6.4 Estado de un cine

`attention` si hay algún sensor offline o alguna alerta activa en sus salas. Si no, `ok`.

---

## 7. Despliegue

### 7.1 Orden recomendado para pasar a esta versión sin cortar el servicio

1. **Frontend primero (Netlify).** Funciona con el backend viejo y con el nuevo. Además ya muestra `—` cuando falta un dato. El frontend viejo se rompe si recibe `null` en una alerta.
2. **Migración**, desde tu computadora: `npx prisma migrate deploy`. Es compatible con el backend viejo: está probado que responde igual con la migración aplicada.
3. **Variables en Render:** `ADMIN_API_KEY` (generala con `npm run clients -- admin-key`) y, si hace falta, `CORS_ORIGINS`.
4. **Backend (Render):** subí los cambios. Verificá `GET /api/health`: tiene que decir `"status": "ok"` y `"schema": "ok"`.
5. **En tu frontend:** Configuración → Acceso de administrador → pegá la misma clave.

El gateway no necesita ningún cambio en ningún paso.

### 7.2 Render

- **Build:** tiene que incluir `npx prisma generate` (el cliente no se versiona). Opcional: agregar `npx prisma migrate deploy` al build para no correr las migraciones a mano. Eso requiere `DIRECT_URL` configurada en Render.
- **Start:** `npm start`.
- **Health check path** (opcional): `/api/health`.

---

## 8. Seguridad

- Lectura pública, escritura con clave y permisos ([sección 5](#5-acceso-y-permisos)).
- `POST /api/telemetry` sigue abierto porque el gateway instalado no puede mandar una clave. Ver alternativas en la parte interna del documento de recomendaciones.
- CORS limita solo a los navegadores. No impide llamadas desde `curl`, Postman u otro servidor.
- `.env` contiene las credenciales de la base. **No se comparte ni se versiona.**
- Los errores nunca exponen detalles internos. El detalle queda en los logs, junto con el `requestId` que también recibe el cliente.

---

## 9. Limitaciones conocidas

- **Sin límite de peticiones ni tope de página.** `pageSize` no tiene máximo, y `GET /api/sensors/:devEui/measurements?preset=all` devuelve todo el histórico.
- **Telemetría:** los pasos no son atómicos, y una lectura vieja reenviada pisa el estado actual. `Sensor.battery` es entero: una batería `3.6` se guarda como `3` en el sensor, mientras que en `Measurement` queda bien.
- **Alertas:** dos lecturas simultáneas del mismo sensor pueden crear un duplicado momentáneo, que se corrige en la evaluación siguiente. No hay histéresis: un valor que oscila sobre el límite abre y cierra alertas seguidas.
- `GET /api/measurements` ignora `preset`, `from`, `to` y `roomId`. `GET /api/sensors` ignora filtros.
- No hay endpoints para cines y salas (alta, edición, baja), ni para desasignar un sensor.
