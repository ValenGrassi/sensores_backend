require("dotenv").config({ quiet: true });

const config = require("./config");
const prisma = require("./lib/prisma");
const { createApp } = require("./app");
const { checkMigrations } = require("./lib/migrations");

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`Servidor iniciado en http://localhost:${config.port}`);
  console.log(`CORS permitido para: ${config.corsAllowAll ? "cualquier dominio" : config.corsOrigins.join(", ")}`);

  if (!config.adminApiKey) {
    console.warn("[auth] ADMIN_API_KEY no está definida: solo los clientes creados con el script pueden escribir.");
  }

  checkMigrations();
});

// Render manda SIGTERM al desplegar una versión nueva: se cierran las conexiones ordenadamente.
function shutdown(signal) {
  console.log(`${signal} recibido, cerrando el servidor...`);
  server.close(() => {
    prisma.$disconnect().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
