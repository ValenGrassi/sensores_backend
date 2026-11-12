const crypto = require("crypto");

const VALID_ID = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Asigna un id a cada petición (o respeta el X-Request-Id que mande el cliente)
 * y lo devuelve en el header X-Request-Id. Los errores lo incluyen en el body
 * para poder encontrar el caso exacto en los logs.
 */
function requestId(req, res, next) {
  const incoming = req.get("X-Request-Id");
  req.id = incoming && VALID_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.set("X-Request-Id", req.id);
  next();
}

module.exports = { requestId };
