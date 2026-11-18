/**
 * IP real de quien llama (la usan el límite de pedidos y GET /api/me).
 *
 * En Render el pedido pasa por Cloudflare y por el proxy de Render antes de
 * llegar al servidor, y la cantidad de saltos en X-Forwarded-For no es fija.
 * Cloudflare escribe la IP del cliente en el header CF-Connecting-IP y pisa
 * el que mande el cliente, así que ese header es la fuente confiable.
 *
 * Si el header no está o no es una IP válida (por ejemplo en local, sin
 * Cloudflare), se usa req.ip, que depende de TRUST_PROXY.
 */

const net = require("node:net");

/** header: nombre del header con la IP (en minúsculas), o null para usar solo req.ip. */
function resolveClientIp(req, header) {
  if (header) {
    const value = req.get(header)?.trim();
    if (value && net.isIP(value)) return value;
  }
  return req.ip;
}

/** Middleware: deja la IP en req.clientIp. */
function clientIp(header) {
  return function setClientIp(req, res, next) {
    req.clientIp = resolveClientIp(req, header);
    next();
  };
}

module.exports = { clientIp, resolveClientIp };
