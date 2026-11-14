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

function createApp() {
  const app = express();

  const rateLimiter = createRateLimiter(config.rateLimit);
  app.locals.rateLimiter = rateLimiter;

  app.disable("x-powered-by");
  // Detrás del proxy de Render: req.ip = IP real del cliente (TRUST_PROXY, por defecto 1).
  app.set("trust proxy", config.trustProxy);

  app.use(requestId);
  app.use(cors(corsOptions()));
  app.use(express.json({ limit: "100kb" }));

  app.use("/api/telemetry", telemetryRoutes);

  app.get(["/", "/health", "/api/health"], rateLimiter.anonymous);
  app.use(system.publicRouter);

  app.use("/api", rateLimiter.authFailures);
  app.use("/api", identifyClient);
  app.use(rateLimiter.requests);

  app.use("/api", system.apiRouter);
  app.use("/api", statsRoutes);
  app.use("/api/sensors", sensorRoutes);
  app.use("/api/profiles", profileRoutes);
  app.use("/api/cinemas", cinemaRoutes);
  app.use("/api/rooms", roomRoutes);
  app.use("/api/alerts", alertRoutes);
  app.use("/api/measurements", measurementRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
