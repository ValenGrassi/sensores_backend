const express = require("express");
const prisma = require("../lib/prisma");
const { expandPermissions } = require("../lib/permissions");
const { checkMigrations, getMigrationState } = require("../lib/migrations");

const DB_CHECK_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * GET /api/health (y /health) — para monitoreo.
 * 200 si responde la base; 503 si no. "schema": "outdated" avisa que falta
 * aplicar migraciones (el servicio funciona, pero no completo).
 */
async function health(req, res) {
  let database = "ok";
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, DB_CHECK_TIMEOUT_MS);
  } catch {
    database = "unreachable";
  }

  let migrations = getMigrationState();
  if (database === "ok" && !migrations.checked) {
    migrations = await checkMigrations();
  }

  const schema = !migrations.checked ? "unknown" : migrations.pending.length > 0 ? "outdated" : "ok";
  const status = database !== "ok" ? "error" : schema === "outdated" ? "degraded" : "ok";

  res.status(database === "ok" ? 200 : 503).json({
    status,
    database,
    schema,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

/**
 * GET /api/me — quién sos según la clave enviada, qué podés escribir y cuánto
 * te queda de los límites de pedidos. "ip" es la IP con la que te ve el
 * servidor (sirve para verificar que detrás del proxy se detecta bien).
 */
function me(req, res) {
  const rateLimit = req.app.locals.rateLimiter?.status(req) ?? { enabled: false };

  if (!req.client) {
    return res.json({ authenticated: false, client: null, permissions: [], ip: req.ip, rateLimit });
  }

  res.json({
    authenticated: true,
    client: { id: req.client.id, name: req.client.name, type: req.client.type },
    permissions: expandPermissions(req.client.permissions),
    ip: req.ip,
    rateLimit,
  });
}

/** GET / — índice mínimo para quien abra la URL base en el navegador. */
function index(req, res) {
  res.json({ name: "API de monitoreo de sensores", status: "ok", health: "/api/health" });
}

const publicRouter = express.Router();
publicRouter.get("/", index);
publicRouter.get("/health", health);
publicRouter.get("/api/health", health);

const apiRouter = express.Router();
apiRouter.get("/me", me);

module.exports = { publicRouter, apiRouter };
