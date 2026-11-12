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
 *       "requestId": "…"                      // para rastrear el caso en los logs
 *     }
 *   }
 */

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
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
