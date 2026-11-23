# Referencia de la API

Rutas en [`src/routes/`](../src/routes/), armadas en [`src/app.js`](../src/app.js).

## Índice

- [Convenciones generales](#convenciones-generales)
- [Autenticación y permisos](#autenticación-y-permisos)
- [Límites de pedidos](#límites-de-pedidos)
- [Errores](#errores)
- [Resumen de endpoints](#resumen-de-endpoints)
- [Objetos de respuesta](#objetos-de-respuesta)
- Endpoints
  - Sistema: [`GET /api/health`](#get-apihealth) · [`GET /api/me`](#get-apime)
  - Indicadores: [`GET /api/stats`](#get-apistats) · [`GET /api/dashboard`](#get-apidashboard)
  - Cines: [`GET /api/cinemas`](#get-apicinemas) · [`GET /api/cinemas/:id`](#get-apicinemasid)
  - Salas: [`GET /api/rooms`](#get-apirooms)
  - Sensores: [`GET /api/sensors`](#get-apisensors) · [`GET /api/sensors/:devEui`](#get-apisensorsdeveui) · [`GET /api/sensors/:devEui/measurements`](#get-apisensorsdeveuimeasurements) · [`PATCH /api/sensors/:devEui`](#patch-apisensorsdeveui)
  - Mediciones: [`GET /api/measurements`](#get-apimeasurements)
  - Alertas: [`GET /api/alerts`](#get-apialerts)
  - Perfiles: [`GET /api/profiles`](#get-apiprofiles) · [`GET /api/profiles/:id`](#get-apiprofilesid) · [`POST /api/profiles`](#post-apiprofiles) · [`PATCH /api/profiles/:id`](#patch-apiprofilesid) · [`DELETE /api/profiles/:id`](#delete-apiprofilesid)
  - Telemetría (solo gateway): [`POST /api/telemetry`](#post-apitelemetry)

---

## Convenciones generales

| Tema | Detalle |
|---|---|
| **URL base** | `https://sensores-backend-2fa8.onrender.com` (producción) · `http://localhost:5000` (local). Todas las rutas empiezan con `/api`. |
| **Formato** | JSON. Los `POST` y `PATCH` tienen que enviar `Content-Type: application/json`. |
| **CORS** | Dominios definidos en `CORS_ORIGINS`. No aplica a llamadas desde un servidor. |
| **Identificador de sensor** | El **DevEUI** (16 caracteres hex, ej. `a84041000181c4b1`), sin distinguir mayúsculas. Las respuestas también traen `id` (interno) para relacionar alertas y mediciones; las alertas y mediciones traen además `devEui`. |
| **Otros IDs** | Cines, salas, perfiles y alertas: strings opacos (CUID). |
| **Fechas** | ISO 8601 en UTC (ej. `2026-11-10T14:32:05.123Z`). |
| **Unidades** | `temperature` °C · `humidity` % HR · `battery` % |
| **Nulos** | `null` = **no hay dato**. Nunca se usa `0` para indicar ausencia. |
| **Campos desconocidos** | Se ignoran (en el body y en la query). |
| **Request id** | Cada respuesta trae el header `X-Request-Id` (o respeta el que mande el cliente). |
| **Límites** | Hay un máximo de pedidos por minuto y por día; cada respuesta informa cuánto queda (ver [Límites de pedidos](#límites-de-pedidos)). |
| **Caché** | Los `GET` traen `ETag`: si se reenvía con `If-None-Match` y nada cambió, la respuesta es `304` sin cuerpo (los navegadores lo hacen solos). |

---

## Autenticación y permisos

- **Lectura (`GET`)**: pública, sin clave.
- **Escritura**: header `X-API-Key: <clave>` con el permiso que corresponda:

| Permiso | Habilita |
|---|---|
| `sensors:write` | `PATCH /api/sensors/:devEui` |
| `profiles:write` | `POST`, `PATCH`, `DELETE /api/profiles` |

- La clave de administrador (`ADMIN_API_KEY`) tiene todos los permisos.
- Las demás claves se crean con `npm run clients -- create` (ver [README](../README.md#42-scripts)).
- Orden de controles en una escritura: primero la clave (`401`/`403`), después los datos (`400`), después la existencia de lo referenciado (`404`/`409`).
- Una clave inválida o revocada responde `401 INVALID_API_KEY` en **cualquier** ruta, también en los `GET`.
- `POST /api/telemetry` no pide clave: lo usa el gateway, que no puede enviarla.

---

## Límites de pedidos

Cada cliente tiene un cupo de pedidos. Sin clave, el cliente es la **IP**; con una clave de API, es la **clave** (no importa desde cuántas IPs se use).

| | Sin clave (por IP) | Con clave (por clave) |
|---|---|---|
| **Pedidos** (todas las rutas) | 120 por minuto · 30.000 por día | 300 por minuto · 50.000 por día |
| **Consultas de historial** (se suman a las anteriores) | 20 por minuto · 500 por día | 30 por minuto · 1.000 por día |
| **Escrituras** (`POST`, `PATCH`, `DELETE`) | — (requieren clave) | 30 por minuto |

- **Consultas de historial**: `GET /api/sensors/:devEui/measurements`, `GET /api/measurements` y `GET /api/alerts` (salvo `?active=true`, que es liviana).
- **Claves inválidas**: después de 20 respuestas `401 INVALID_API_KEY` en 10 minutos desde una misma IP, los pedidos **con clave** desde esa IP reciben `429` hasta que pase la ventana. Sin clave se puede seguir leyendo.
- Las ventanas se cuentan desde el primer pedido de cada cliente (un minuto, un día). Un pedido rechazado con `429` no consume cupo.
- `POST /api/telemetry` no tiene límite. La clave de administrador tampoco.

**Headers en cada respuesta** (del límite más cercano a agotarse):

| Header | Significado |
|---|---|
| `RateLimit-Limit` | Máximo de la ventana |
| `RateLimit-Remaining` | Pedidos que quedan |
| `RateLimit-Reset` | Segundos hasta que se renueva |

**Al superarlo**: `429 RATE_LIMITED` con el header `Retry-After` (segundos) y estos campos extra en el error:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Hiciste demasiadas solicitudes (límite: 120 por minuto). Esperá 45 segundos y volvé a intentar.",
    "retryAfterSeconds": 45,
    "limit": { "scope": "requests", "max": 120, "windowSeconds": 60 },
    "requestId": "…"
  }
}
```

`limit.scope`: `requests` · `history` · `writes` · `auth`.

**Cómo integrarse sin chocar con el límite**:

- Ante un `429`, esperar `Retry-After` segundos antes de reintentar (no reintentar en bucle).
- Para datos "en vivo", consultar cada 60 segundos alcanza: los sensores reportan cada ~5 minutos.
- Si muchos usuarios de tu app ven los mismos datos, consultarlos desde tu servidor una vez y repartirlos (caché), en vez de que cada usuario llame a esta API.
- `GET /api/me` muestra tu cupo restante.

---

## Errores

Todas las respuestas de error tienen la misma forma:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "temperatureMin: La temperatura mínima (30) tiene que ser menor que la máxima (10).",
    "details": [
      { "field": "temperatureMin", "message": "La temperatura mínima (30) tiene que ser menor que la máxima (10)." }
    ],
    "requestId": "4f9c2a1e-7d0b-4c38-9a51-2b6f0e1d3c77"
  }
}
```

| Campo | Para qué |
|---|---|
| `code` | Estable, en inglés. **Para programar contra él** (no comparar mensajes). |
| `message` | En español, listo para mostrarle a una persona. Puede cambiar de redacción. |
| `details` | Solo en `VALIDATION_ERROR`: un elemento por campo con problema. |
| `retryAfterSeconds`, `limit` | Solo en `RATE_LIMITED` (ver [Límites de pedidos](#límites-de-pedidos)). |
| `requestId` | Identifica la petición en los logs del servidor. Pedirlo al reportar un problema. |

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Datos faltantes, de tipo incorrecto o fuera de regla (ver `details`) |
| 400 | `INVALID_JSON` | El body no es JSON válido |
| 400 | `BODY_REQUIRED` | `POST`/`PATCH` sin body |
| 401 | `API_KEY_REQUIRED` | Escritura sin header `X-API-Key` |
| 401 | `INVALID_API_KEY` | Clave inexistente o revocada |
| 403 | `FORBIDDEN` | La clave no tiene el permiso necesario (el mensaje dice cuál) |
| 404 | `ROUTE_NOT_FOUND` | La ruta no existe |
| 404 | `SENSOR_NOT_FOUND` · `PROFILE_NOT_FOUND` · `CINEMA_NOT_FOUND` · `ROOM_NOT_FOUND` | El recurso pedido o referenciado no existe |
| 409 | `PROFILE_IN_USE` | Se intenta borrar un perfil asignado a salas |
| 409 | `CONFLICT` | Otro conflicto de integridad de datos |
| 413 | `PAYLOAD_TOO_LARGE` | Body de más de 100 kB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Body enviado sin `Content-Type: application/json` |
| 429 | `RATE_LIMITED` | Se superó un límite de pedidos; esperar `Retry-After` segundos |
| 500 | `INTERNAL_ERROR` | Error inesperado (el detalle queda en el log con el `requestId`) |
| 503 | `SERVICE_UNAVAILABLE` | La base de datos no responde; reintentar en unos segundos |

---

## Resumen de endpoints

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| `GET` | `/api/health` | Público | Estado del servicio y de la base |
| `GET` | `/api/me` | Público | Identidad, permisos y cupo restante |
| `GET` | `/api/stats` | Público | Indicadores generales o de un cine |
| `GET` | `/api/dashboard` | Público | Los mismos indicadores en forma plana (la usa el frontend) |
| `GET` | `/api/cinemas` | Público | Cines con resumen de estado |
| `GET` | `/api/cinemas/:id` | Público | Un cine con sus salas y sensores |
| `GET` | `/api/rooms` | Público | Salas (filtro `cinemaId`) |
| `GET` | `/api/sensors` | Público | Sensores con estado y ubicación (filtros `cinemaId`, `roomId`, `status`) |
| `GET` | `/api/sensors/:devEui` | Público | Un sensor |
| `GET` | `/api/sensors/:devEui/measurements` | Público · historial | Histórico de un sensor por rango (`preset`), con promedios en rangos largos |
| `PATCH` | `/api/sensors/:devEui` | `sensors:write` | Cambiar nombre y sala |
| `GET` | `/api/measurements` | Público · historial | Histórico paginado (hasta 500 por página), con filtros por sensor, sala, cine y fechas |
| `GET` | `/api/alerts` | Público · historial¹ | Alertas, de a 200 (filtros `active` y fechas, paginación con `cursor`) |
| `GET` | `/api/profiles` | Público | Perfiles |
| `GET` | `/api/profiles/:id` | Público | Un perfil |
| `POST` | `/api/profiles` | `profiles:write` | Crear perfil |
| `PATCH` | `/api/profiles/:id` | `profiles:write` | Editar perfil (reevalúa alertas) |
| `DELETE` | `/api/profiles/:id` | `profiles:write` | Borrar perfil sin uso |
| `POST` | `/api/telemetry` | Gateway | Lectura de un sensor |

"historial" = cuenta también para el límite de consultas de historial. ¹ Salvo `?active=true`.

---

## Objetos de respuesta

### Sensor

Misma forma en `GET /api/sensors`, `GET /api/sensors/:devEui`, `PATCH /api/sensors/:devEui` y dentro de `GET /api/cinemas/:id`.

```json
{
  "id": "cmwbh9pn800002ovzsutfk54c",
  "devEui": "a84041000181c4b1",
  "name": "Cabina 1 - A",
  "temperature": 27.3,
  "humidity": 48,
  "battery": 94,
  "lastSeen": "2026-11-11T02:05:19.330Z",
  "status": "online",
  "room":    { "id": "room_1", "cinemaId": "cin_1", "name": "Cabina 1", "type": "projection", "profileId": "prof_proy" },
  "cinema":  { "id": "cin_1", "name": "Cine Centro", "address": "Av. Siempre Viva 123" },
  "profile": { "id": "prof_proy", "name": "Proyección", "description": "Cabinas de proyección",
               "temperatureMin": 18, "temperatureMax": 24, "humidityMin": 30, "humidityMax": 60 }
}
```

- `status`: `online` | `offline`.
- `room`, `cinema` y `profile` son `null` si el sensor no tiene sala.
- `temperature`, `humidity`, `battery`, `lastSeen` y `name` pueden ser `null`.

### Measurement

Cada lectura, tal como llegó:

```json
{ "id": "…", "sensorId": "…", "timestamp": "2026-11-11T02:00:00.000Z",
  "temperature": 22.4, "humidity": 51, "battery": 95, "createdAt": "…" }
```

`timestamp` es la hora de la lectura (del gateway); `createdAt`, cuándo se guardó.

**Punto promediado** (rangos largos de `GET /api/sensors/:devEui/measurements`):

```json
{ "sensorId": "…", "timestamp": "2026-11-10T03:00:00.000Z",
  "temperature": 22.17, "humidity": 50.84, "battery": 94.5, "samples": 288 }
```

- `timestamp`: **inicio** del intervalo (la hora, o el día a las 00:00 hora de Argentina).
- `temperature`, `humidity`, `battery`: promedios del intervalo, con 2 decimales. Las lecturas sin dato no cuentan; `null` si no hubo ninguna.
- `samples`: cuántas lecturas se promediaron.
- No tiene `id` ni `createdAt`.

### Alert

```json
{ "id": "…", "sensorId": "…", "devEui": "a84041000181c4b3", "type": "temperature_high",
  "temperature": 26, "humidity": null, "createdAt": "…", "resolvedAt": null, "active": true }
```

- `type`: `temperature_high` | `temperature_low` | `humidity_high` | `humidity_low`.
- `temperature`/`humidity`: lecturas del sensor al abrirse la alerta. `null` = no había dato.
- Se abre cuando la métrica está fuera de rango en **2 lecturas seguidas** (un valor suelto no la dispara). Se resuelve sola con la primera lectura en rango.
- Hay como máximo una alerta activa por sensor y tipo.

### Profile

```json
{ "id": "…", "name": "Proyección", "description": null,
  "temperatureMin": 18, "temperatureMax": 24, "humidityMin": 30, "humidityMax": 60 }
```

### Room

```json
{ "id": "…", "cinemaId": "…", "name": "Cabina 1", "type": "projection", "profileId": "…" }
```

`type`: texto libre; el frontend usa `projection`, `hall`, `lobby`, `storage`, `other`.

---

## Sistema

### `GET /api/health`

También en `/health`. Para monitoreo (UptimeRobot, health check de Render).

```json
{ "status": "ok", "database": "ok", "schema": "ok", "uptimeSeconds": 3600, "timestamp": "…" }
```

| Campo | Valores |
|---|---|
| `status` | `ok` · `degraded` (faltan migraciones) · `error` (sin base) |
| `database` | `ok` · `unreachable` |
| `schema` | `ok` · `outdated` (hay migraciones sin aplicar) · `unknown` |

HTTP `200` si la base responde; `503` si no.

### `GET /api/me`

Devuelve quién sos según la clave enviada, con qué IP te ve el servidor y cuánto te queda de cada límite.

```json
{
  "authenticated": true,
  "client": { "id": "…", "name": "App de Juan", "type": "client" },
  "permissions": ["sensors:write"],
  "ip": "190.12.34.56",
  "rateLimit": {
    "enabled": true,
    "tier": "client",
    "requests": {
      "perMinute": { "limit": 300, "remaining": 287, "resetSeconds": 41 },
      "perDay": { "limit": 50000, "remaining": 49120, "resetSeconds": 51234 }
    },
    "history": {
      "perMinute": { "limit": 30, "remaining": 30, "resetSeconds": 60 },
      "perDay": { "limit": 1000, "remaining": 982, "resetSeconds": 51234 }
    },
    "writes": { "perMinute": { "limit": 30, "remaining": 30, "resetSeconds": 60 } }
  }
}
```

- Sin clave: `authenticated: false`, `client: null`, `permissions: []` y `rateLimit.tier: "anonymous"` (sin `writes`).
- Clave inválida: `401 INVALID_API_KEY`.
- Administrador: `client.type = "admin"`, con todos los permisos y `rateLimit: { "enabled": true, "tier": "admin", "unlimited": true }`.
- Límites desactivados en el servidor: `rateLimit: { "enabled": false }`.

---

## Indicadores

### `GET /api/stats`

| Query | Tipo | Descripción |
|---|---|---|
| `cinemaId` | string, opcional | Limita todo a un cine (`404 CINEMA_NOT_FOUND` si no existe) |

```json
{
  "generatedAt": "2026-11-11T02:05:45.637Z",
  "cinemaId": null,
  "cinemas": 2,
  "rooms": 3,
  "sensors": { "total": 3, "online": 3, "offline": 0, "withActiveAlerts": 1, "unassigned": 0 },
  "alerts": { "active": 1, "byType": { "temperature_high": 1, "temperature_low": 0, "humidity_high": 0, "humidity_low": 0 } },
  "averages": { "temperature": 24.7, "humidity": 50 }
}
```

- `alerts.active` cuenta **alertas**.
- `sensors.withActiveAlerts` cuenta **sensores** con al menos una alerta.
- `averages` promedia solo los sensores **online**, redondeado a 1 decimal. Es `null` si no hay datos.

### `GET /api/dashboard`

Los mismos datos en la forma plana que usa el frontend:

```json
{ "cinemaCount": 2, "sensorCount": 3, "sensorsOnline": 3, "sensorsOffline": 0,
  "activeAlerts": 2, "sensorsWithAlerts": 1, "sensorsAlert": 1,
  "avgTemperature": 21.7, "avgHumidity": 60 }
```

`sensorsAlert` está **obsoleto** (igual a `sensorsWithAlerts`); se mantiene por compatibilidad.

---

## Cines

### `GET /api/cinemas`

```json
[{ "id": "cin_1", "name": "Cine Centro", "address": "…", "status": "attention",
   "sensorCount": 1, "sensorsOnline": 1, "sensorsOffline": 0,
   "activeAlerts": 2, "sensorsWithAlerts": 1 }]
```

`status`: `attention` si hay algún sensor offline o alguna alerta activa. Si no, `ok`.

### `GET /api/cinemas/:id`

El resumen anterior más `rooms`: cada sala (`id`, `name`, `type`, `profileId`) con su lista de `sensors` en la forma [Sensor](#sensor). `404 CINEMA_NOT_FOUND`.

---

## Salas

### `GET /api/rooms`

Query opcional `cinemaId`. Devuelve un arreglo de [Room](#room) ordenado por nombre.

---

## Sensores

### `GET /api/sensors`

Arreglo de [Sensor](#sensor), ordenado por nombre. Sin filtros devuelve todos.

| Query | Valores |
|---|---|
| `cinemaId` | Solo los sensores de ese cine |
| `roomId` | Solo los de esa sala |
| `status` | `online` · `offline` · `alert` (con al menos una alerta activa) |

Un `cinemaId` o `roomId` que no existe devuelve un arreglo vacío. Un `status` inválido responde `400`.

### `GET /api/sensors/:devEui`

Un [Sensor](#sensor). `404 SENSOR_NOT_FOUND`.

### `GET /api/sensors/:devEui/measurements`

| Query | Valores | Default |
|---|---|---|
| `preset` | `24h` · `7d` · `30d` · `3m` (91 días) · `6m` (182 días) · `all` (desde la primera medición del sensor) | `24h` |
| `resolution` | `auto` · `raw` · `hour` · `day` | `auto` |

Arreglo de la más vieja a la más nueva. Según la resolución:

| `resolution` | Devuelve | Rango máximo |
|---|---|---|
| `raw` | Cada [Measurement](#measurement) | 7 días |
| `hour` | Un [punto promediado](#measurement) por hora | 92 días |
| `day` | Un [punto promediado](#measurement) por día (hora de Argentina) | Sin máximo |
| `auto` | La más detallada que permita el rango: `24h` y `7d` → `raw`; `30d` y `3m` → `hour`; `6m` → `day`; `all` según cuánta historia tenga el sensor | — |

- El header `X-Resolution` dice cuál se usó (`raw`, `hour` o `day`).
- Pedir una resolución más detallada de lo que permite el rango responde `400 VALIDATION_ERROR` explicando cuál usar.
- Un `preset` o `resolution` inválido responde `400`.
- Con lecturas cada 5 minutos: `7d` ≈ 2.000 puntos, `30d` ≈ 720, `3m` ≈ 2.200, `6m` ≈ 180.

### `PATCH /api/sensors/:devEui`

Requiere `sensors:write`.

```json
{ "name": "Cabina 1 - A", "roomId": "room_1" }
```

| Campo | Regla |
|---|---|
| `name` | Texto obligatorio, 1 a 100 caracteres (se recortan espacios) |
| `roomId` | Obligatorio, tiene que existir (`404 ROOM_NOT_FOUND`) |

Devuelve el [Sensor](#sensor) actualizado. Las alertas del sensor se reevalúan con el perfil de la sala nueva.

---

## Mediciones

### `GET /api/measurements`

| Query | Descripción | Default |
|---|---|---|
| `devEui` | Filtrar por sensor (DevEUI) | — |
| `sensorId` | Filtrar por sensor (`id` interno) | — |
| `cinemaId` | Filtrar por cine | — |
| `roomId` | Filtrar por sala | — |
| `page` | Entero ≥ 1 | `1` |
| `pageSize` | Entero de 1 a 500 | `20` |

**Fechas** (opcionales; sin ellas no se filtra por fecha). Se usa una de las dos formas, no las dos:

| Query | Valores |
|---|---|
| `preset` | `24h` · `7d` · `30d` · `3m` (91 días) · `6m` (182 días) · `all` (sin límite) |
| `from`, `to` | Fechas ISO 8601, por ejemplo `2026-11-01` (00:00 UTC) o `2026-11-01T12:00:00-03:00`. Se puede mandar solo una |

Mandar `preset` junto con `from`/`to`, un `from` posterior a `to` o una fecha en otro formato responde `400 VALIDATION_ERROR` explicando qué corregir.

```json
{ "rows": [{ "id": "…", "timestamp": "…", "temperature": 22.4, "humidity": 51, "battery": 95,
             "sensorId": "…", "devEui": "a84041000181c4b1", "sensorName": "Cabina 1 - A",
             "roomName": "Cabina 1", "cinemaName": "Cine Centro" }],
  "total": 1520, "page": 1, "pageSize": 20 }
```

De la más nueva a la más vieja. Un `pageSize` mayor a 500 responde `400`.

---

## Alertas

### `GET /api/alerts`

| Query | Valores | Default |
|---|---|---|
| `active` | `true` · `false` · omitido = todas | — |
| `limit` | Entero de 1 a 500 | `200` |
| `cursor` | `id` de la última alerta recibida, para traer las siguientes (más viejas) | — |

Las mismas fechas que `GET /api/measurements` (`preset`, o `from`/`to`), según cuándo **se abrió** la alerta. Se combinan con `cursor`.

Arreglo de [Alert](#alert), de la más nueva a la más vieja, con como máximo `limit` elementos.

Para recorrer todo el historial: pedir sin `cursor`; si llegaron `limit` alertas, volver a pedir con `cursor=<id de la última>`; cuando lleguen menos de `limit`, no hay más.

```
GET /api/alerts?active=false&limit=100
GET /api/alerts?active=false&limit=100&cursor=cmwbh9pqz000e2ovz3ml0110r
```

- Un `cursor` que no existe (o que no corresponde al filtro `active`) responde `400`.
- Valores inválidos de `active` o `limit` responden `400`.

---

## Perfiles

### `GET /api/profiles`

Arreglo de [Profile](#profile), ordenado por nombre.

### `GET /api/profiles/:id`

Un [Profile](#profile). `404 PROFILE_NOT_FOUND`.

### `POST /api/profiles`

Requiere `profiles:write`.

```json
{ "name": "Depósito", "description": "Opcional",
  "temperatureMin": 5, "temperatureMax": 30, "humidityMin": 10, "humidityMax": 90 }
```

| Campo | Regla |
|---|---|
| `name` | Texto obligatorio, hasta 100 caracteres |
| `description` | Texto opcional, hasta 500. `""` o `null` = sin descripción |
| `temperatureMin/Max`, `humidityMin/Max` | Obligatorios. Número o texto numérico (`"18.5"`); el mínimo tiene que ser **menor** que el máximo |

Responde `201` con el [Profile](#profile).

### `PATCH /api/profiles/:id`

Requiere `profiles:write`. Mismos campos, todos opcionales. El chequeo mínimo < máximo se hace con los valores finales. Las alertas de los sensores que usan el perfil se reevalúan en el momento.

### `DELETE /api/profiles/:id`

Requiere `profiles:write`. Responde `204` sin cuerpo.
- `404 PROFILE_NOT_FOUND` si el perfil no existe.
- `409 PROFILE_IN_USE` si alguna sala lo usa.

---

## Telemetría

### `POST /api/telemetry`

**Uso exclusivo del gateway LoRaWAN.** Sin clave. No se documenta a terceros.

```json
{ "devEUI": "A84041000181C4B1", "deviceName": "Sensor A", "gatewayTime": "2026-11-11T02:00:00Z",
  "temperature": 22.4, "humidity": 51, "battery": 95 }
```

| Campo | Regla |
|---|---|
| `devEUI` | Obligatorio (texto). Se normaliza a minúsculas. Tiene que estar registrado (`npm run sensors -- add`) |
| `deviceName` | Opcional. Solo se usa como nombre si `TELEMETRY_AUTO_CREATE=true` y el sensor no existía |
| `gatewayTime` | Opcional. Si falta, es inválido o está más de 5 minutos en el futuro, se usa la hora del servidor |
| `temperature`, `humidity`, `battery` | Opcionales. Número, texto numérico o `null`. Si un campo no viene, el sensor conserva su último valor |

- Responde `200` con el texto `OK`, igual que antes. También para un sensor no registrado: la lectura se descarta y queda en el log.
- Una lectura más vieja que la última del sensor va al histórico, pero no cambia su estado ni sus alertas.
- Una lectura con la misma temperatura y humedad que la última, recibida menos de 30 s después, se ignora: es la misma transmisión repetida.
- Si falla la evaluación de alertas, igual responde `200`: la lectura ya quedó guardada.
- `400 VALIDATION_ERROR` si falta `devEUI` o un valor no es numérico.
