/**
 * Errores de la API.
 *
 * Todas las respuestas de error tienen la misma forma:
 *
 *   {
 *     "error": {
 *       "code": "SENSOR_NOT_FOUND",          // estable: para programar contra él
 *       "message": "No existe un sensor…",   // para mostrarle a una persona
 *       "details": [ { "field", "message" } ], // solo en errores de validación
 *       "retryAfterSeconds": 45, "limit": {…}, // solo en 429 RATE_LIMITED
 *       "requestId": "…"                      // para rastrear el caso en los logs
 *     }
 *   }
 */

class ApiError extends Error {
  /** `extra`: campos adicionales para el cuerpo del error (p. ej. retryAfterSeconds en un 429). */
  constructor(status, code, message, details, extra) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.extra = extra;
  }
}

const RATE_LIMIT_MESSAGES = {
  requests: (limit, wait) =>
    `Hiciste demasiadas solicitudes (límite: ${limit}). Esperá ${wait} y volvé a intentar.`,
  history: (limit, wait) =>
    `Hiciste demasiadas consultas de historial (límite: ${limit}). Esperá ${wait} y volvé a intentar.`,
  writes: (limit, wait) =>
    `Hiciste demasiadas modificaciones (límite: ${limit}). Esperá ${wait} y volvé a intentar.`,
  auth: (limit, wait) =>
    `Hubo demasiados intentos con una clave de API inválida desde tu conexión (límite: ${limit}). ` +
    `Revisá la clave y esperá ${wait} antes de volver a intentar.`,
};

function formatCount(value) {
  return value.toLocaleString("es-AR");
}

function formatWindow(seconds) {
  if (seconds === 60) return "por minuto";
  if (seconds === 86400) return "por día";
  if (seconds % 60 === 0) return `cada ${seconds / 60} minutos`;
  return `cada ${seconds} segundos`;
}

/** "45 segundos", "3 minutos", "5 h 12 min". */
function formatWait(seconds) {
  if (seconds < 60) return seconds === 1 ? "1 segundo" : `${seconds} segundos`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minuto" : `${minutes} minutos`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * 429: se superó un límite de pedidos.
 * scope: "requests" | "history" | "writes" | "auth".
 */
function rateLimited({ scope, limit, windowSeconds, retryAfterSeconds }) {
  const limitText = `${formatCount(limit)} ${formatWindow(windowSeconds)}`;
  const message = RATE_LIMIT_MESSAGES[scope](limitText, formatWait(retryAfterSeconds));

  return new ApiError(429, "RATE_LIMITED", message, undefined, {
    retryAfterSeconds,
    limit: { scope, max: limit, windowSeconds },
  });
}

/** 400 con la lista de campos inválidos. */
function validationError(details) {
  const message =
    details.length === 1
      ? `${details[0].field}: ${details[0].message}`
      : `Hay ${details.length} datos inválidos: ${details.map((d) => d.field).join(", ")}.`;

  return new ApiError(400, "VALIDATION_ERROR", message, details);
}

function notFound(code, message) {
  return new ApiError(404, code, message);
}

const errors = {
  validation: validationError,

  rateLimited,

  invalidJson: () =>
    new ApiError(400, "INVALID_JSON", "El cuerpo de la solicitud no es un JSON válido."),

  bodyRequired: () =>
    new ApiError(
      400,
      "BODY_REQUIRED",
      "Falta el cuerpo de la solicitud. Enviá un objeto JSON con el header Content-Type: application/json."
    ),

  unsupportedMediaType: () =>
    new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "El cuerpo tiene que enviarse como JSON, con el header Content-Type: application/json."
    ),

  payloadTooLarge: () =>
    new ApiError(413, "PAYLOAD_TOO_LARGE", "El cuerpo de la solicitud es demasiado grande."),

  apiKeyRequired: () =>
    new ApiError(
      401,
      "API_KEY_REQUIRED",
      "Esta operación necesita una clave de API. Enviala en el header X-API-Key."
    ),

  invalidApiKey: () =>
    new ApiError(401, "INVALID_API_KEY", "La clave de API no es válida o fue revocada."),

  forbidden: (permission) =>
    new ApiError(
      403,
      "FORBIDDEN",
      `Tu clave de API no tiene permiso para esta operación (se necesita "${permission}").`
    ),

  routeNotFound: (method, path) =>
    new ApiError(404, "ROUTE_NOT_FOUND", `No existe la ruta ${method} ${path}.`),

  sensorNotFound: (devEui) =>
    notFound("SENSOR_NOT_FOUND", `No existe un sensor con devEui "${devEui}".`),

  profileNotFound: (id) => notFound("PROFILE_NOT_FOUND", `No existe un perfil con id "${id}".`),

  cinemaNotFound: (id) => notFound("CINEMA_NOT_FOUND", `No existe un cine con id "${id}".`),

  roomNotFound: (id) => notFound("ROOM_NOT_FOUND", `No existe una sala con id "${id}".`),

  alertCursorNotFound: (id) =>
    validationError([
      {
        field: "cursor",
        message: `No existe una alerta con id "${id}" en este listado. Usá el id de la última alerta que recibiste.`,
      },
    ]),

  profileInUse: (roomCount) =>
    new ApiError(
      409,
      "PROFILE_IN_USE",
      `No se puede eliminar el perfil porque lo ${
        roomCount === 1 ? "usa 1 sala" : `usan ${roomCount} salas`
      }. Asigná otro perfil a esas salas primero.`
    ),

  conflict: () =>
    new ApiError(
      409,
      "CONFLICT",
      "La operación entra en conflicto con otros datos. Revisá que lo que referenciás exista y no esté en uso."
    ),

  databaseUnavailable: () =>
    new ApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "El servicio no puede acceder a la base de datos en este momento. Probá de nuevo en unos segundos."
    ),

  internal: () =>
    new ApiError(
      500,
      "INTERNAL_ERROR",
      "Ocurrió un error inesperado. Si se repite, informá el requestId de esta respuesta."
    ),
};

module.exports = { ApiError, errors };
