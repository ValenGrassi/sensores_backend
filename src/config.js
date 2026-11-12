/**
 * Configuración leída de variables de entorno.
 * Cada valor tiene un default igual al comportamiento anterior,
 * así el backend funciona igual aunque no se defina ninguna variable nueva.
 */

const DEFAULT_CORS_ORIGINS = ["https://sensorescinemark.netlify.app"];

function readList(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function readPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.warn(`[config] ${name}="${raw}" no es un entero positivo. Se usa ${fallback}.`);
    return fallback;
  }
  return value;
}

const corsOrigins = readList("CORS_ORIGINS", DEFAULT_CORS_ORIGINS);

const config = {
  /** Render define PORT automáticamente; en local se mantiene el 5000 de siempre. */
  port: readPositiveInt("PORT", 5000),

  /** Dominios que pueden llamar a la API desde un navegador. "*" = cualquiera. */
  corsOrigins,
  corsAllowAll: corsOrigins.includes("*"),

  /** Minutos sin datos para considerar un sensor "offline". */
  sensorOfflineMinutes: readPositiveInt("SENSOR_OFFLINE_MINUTES", 30),

  /** Clave con todos los permisos (la tuya). Sin definir = nadie puede escribir salvo clientes creados con el script. */
  adminApiKey: process.env.ADMIN_API_KEY?.trim() || null,
};

module.exports = config;
