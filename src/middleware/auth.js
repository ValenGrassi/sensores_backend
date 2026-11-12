/**
 * Autenticación por clave de API (header X-API-Key).
 *
 * - Sin clave: la petición sigue como anónima (solo lectura).
 * - Con clave inválida o revocada: 401, aunque sea un GET, para que quien
 *   integra se entere de inmediato de que su clave dejó de servir.
 * - requirePermission(...) protege cada endpoint de escritura.
 */

const { resolveApiKey } = require("../lib/apiKeys");
const { hasPermission } = require("../lib/permissions");
const { errors } = require("../lib/errors");

async function identifyClient(req, res, next) {
  const key = req.get("X-API-Key")?.trim();

  if (!key) {
    req.client = null;
    return next();
  }

  const client = await resolveApiKey(key);
  if (!client) throw errors.invalidApiKey();

  req.client = client;
  next();
}

function requirePermission(permission) {
  return function checkPermission(req, res, next) {
    if (!req.client) throw errors.apiKeyRequired();
    if (!hasPermission(req.client, permission)) throw errors.forbidden(permission);
    next();
  };
}

module.exports = { identifyClient, requirePermission };
