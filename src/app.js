/**
 * Arma la aplicación Express (sin escuchar en un puerto, para poder testearla).
 *
 * Orden de los middlewares:
 *   1. requestId          — id por petición (header X-Request-Id)
 *   2. CORS               — dominios permitidos desde CORS_ORIGINS
 *   3. JSON               — parseo del body (máx. 100 kB)
 *   4. /api/telemetry     — el gateway, ANTES de la autenticación y de los límites:
 *                           nunca se le pide clave ni se le limitan los pedidos
 *   5. /, /health         — públicas, con límite por IP
 *   6. límite de claves inválidas (por IP)
 *   7. identifyClient     — lee X-API-Key (las escrituras exigen permiso)
 *   8. límite de pedidos  — por IP o por clave (el admin no tiene límite)
 *   9. rutas de la API    — las de historial suman su propio límite
 *  10. 404 y manejo central de errores
 */

const cors = require("cors");
const express = require("express");
const config = require("./config");
const { requestId } = require("./middleware/requestId");
const { clientIp } = require("./lib/clientIp");
const { identifyClient } = require("./middleware/auth");
const { createRateLimiter } = require("./middleware/rateLimit");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");

const telemetryRoutes = require("./routes/telemetry");
const sensorRoutes = require("./routes/sensors");
const profileRoutes = require("./routes/profiles");
const cinemaRoutes = require("./routes/cinemas");
const roomRoutes = require("./routes/rooms");
const alertRoutes = require("./routes/alerts");
const measurementRoutes = require("./routes/measurements");
const statsRoutes = require("./routes/stats");
const system = require("./routes/system");

function corsOptions() {
  return {
    origin(origin, callback) {
      // Sin Origin = no es un navegador (gateway, curl, otro backend): CORS no aplica.
      if (!origin || config.corsAllowAll || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    // Headers que el código de un navegador puede leer (además de los básicos).
    exposedHeaders: [
      "X-Request-Id",
      "X-Resolution",
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
      "Retry-After",
    ],
    maxAge: 600, // el navegador recuerda el preflight 10 minutos
  };
}

/** Rutas de la API (sin la telemetría del gateway, que se monta aparte). */
function apiRoutes({ withDashboard }) {
  const router = express.Router();
  router.use(system.apiRouter);
  router.use(statsRoutes);
  if (withDashboard) router.use(statsRoutes.dashboardRouter);
  router.use("/sensors", sensorRoutes);
  router.use("/profiles", profileRoutes);
  router.use("/cinemas", cinemaRoutes);
  router.use("/rooms", roomRoutes);
  router.use("/alerts", alertRoutes);
  router.use("/measurements", measurementRoutes);
  return router;
}

function createApp() {
  const app = express();

  const rateLimiter = createRateLimiter(config.rateLimit);
  app.locals.rateLimiter = rateLimiter;

  app.disable("x-powered-by");
  // Respaldo para la IP del cliente cuando falta CLIENT_IP_HEADER (ver src/lib/clientIp.js).
  app.set("trust proxy", config.trustProxy);

  app.use(requestId);
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: "100kb" }));

  app.use("/api/telemetry", telemetryRoutes);

  app.use(clientIp(config.clientIpHeader));
  app.get(["/", "/health", "/api/health", "/api/v1/health"], rateLimiter.anonymous);
  app.use(system.publicRouter);

  app.use("/api", rateLimiter.authFailures);
  app.use("/api", identifyClient);
  app.use(rateLimiter.requests);

  // /api/v1 es la versión estable para terceros; /api, la de tu frontend.
  // Mismo contenido, salvo /dashboard (interno). Un cambio incompatible
  // futuro iría a /api/v2 sin tocar /api/v1.
  app.use("/api/v1", apiRoutes({ withDashboard: false }));
  app.use("/api", apiRoutes({ withDashboard: true }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
