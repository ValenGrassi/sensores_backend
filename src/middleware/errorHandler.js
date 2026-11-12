/**
 * Manejo central de errores: todo lo que se lanza en una ruta termina acá y
 * sale con la forma { error: { code, message, details?, requestId } }.
 * Los detalles técnicos (stack, SQL) quedan en los logs, nunca en la respuesta.
 */

const { ApiError, errors } = require("../lib/errors");

const DB_UNAVAILABLE_PRISMA_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);
const DB_UNAVAILABLE_SYSTEM_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "57P01", // admin_shutdown (Postgres)
  "53300", // too_many_connections (Postgres)
]);

function isDatabaseUnavailable(error) {
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth++) {
    if (current.name === "PrismaClientInitializationError") return true;
    if (DB_UNAVAILABLE_PRISMA_CODES.has(current.code)) return true;
    if (DB_UNAVAILABLE_SYSTEM_CODES.has(current.code)) return true;
    if (typeof current.kind === "string" && /NotReachable|ConnectionClosed|TooManyConnections|SocketTimeout/i.test(current.kind)) {
      return true;
    }
  }
  return false;
}

/** Traduce errores conocidos (body-parser, Prisma, red) a un ApiError. */
function toApiError(error) {
  if (error instanceof ApiError) return error;

  switch (error?.type) {
    case "entity.parse.failed":
      return errors.invalidJson();
    case "entity.too.large":
      return errors.payloadTooLarge();
    case "encoding.unsupported":
    case "charset.unsupported":
      return errors.unsupportedMediaType();
  }

  if (error?.code === "P2002" || error?.code === "P2003" || error?.code === "P2014") {
    return errors.conflict();
  }

  if (isDatabaseUnavailable(error)) {
    return errors.databaseUnavailable();
  }

  return errors.internal();
}

function notFoundHandler(req, res, next) {
  next(errors.routeNotFound(req.method, req.path));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  const apiError = toApiError(error);

  if (apiError.status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl} requestId=${req.id}`, error);
  }

  if (res.headersSent) return;

  res.status(apiError.status).json({
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details && { details: apiError.details }),
      requestId: req.id,
    },
  });
}

module.exports = { errorHandler, notFoundHandler };
