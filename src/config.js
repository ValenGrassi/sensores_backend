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

function readBoolean(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["true", "1", "on", "yes", "si", "sí"].includes(raw)) return true;
  if (["false", "0", "off", "no"].includes(raw)) return false;

  console.warn(`[config] ${name}="${process.env[name]}" no es true/false. Se usa ${fallback}.`);
  return fallback;
}

/** Cantidad de proxies delante del servidor (Express "trust proxy"). 0 = ninguno. */
function readTrustProxy(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.warn(`[config] ${name}="${raw}" tiene que ser un entero mayor o igual a 0. Se usa ${fallback}.`);
    return fallback;
  }
  return value;
}

/** Nombre de un header HTTP, o null si vale "none" (no usar ningún header). */
function readHeaderName(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["none", "off", "false", "0"].includes(raw)) return null;
  if (/^[a-z0-9-]+$/.test(raw)) return raw;

  console.warn(`[config] ${name}="${process.env[name]}" no es un nombre de header válido. Se usa ${fallback}.`);
  return fallback;
}

function readTimeZone(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  try {
    new Intl.DateTimeFormat("es-AR", { timeZone: raw });
    return raw;
  } catch {
    console.warn(`[config] ${name}="${raw}" no es una zona horaria válida (ej. America/Argentina/Buenos_Aires). Se usa ${fallback}.`);
    return fallback;
  }
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

  /**
   * Header con la IP real de quien llama (la usa el límite de pedidos).
   * En Render es CF-Connecting-IP, que escribe Cloudflare. "none" = no usar
   * ningún header y tomar la IP de TRUST_PROXY. Verificable en GET /api/me → "ip".
   */
  clientIpHeader: readHeaderName("CLIENT_IP_HEADER", "cf-connecting-ip"),

  /** Proxies delante del servidor (Express "trust proxy"). Solo se usa si falta CLIENT_IP_HEADER. */
  trustProxy: readTrustProxy("TRUST_PROXY", 1),

  /** Zona horaria para agrupar el historial por día (series agregadas). */
  timeZone: readTimeZone("TIME_ZONE", "America/Argentina/Buenos_Aires"),

  /**
   * Límites de pedidos. La telemetría del gateway NUNCA se limita.
   * - anonymous: sin clave, contado por IP.
   * - client: con clave de un tercero, contado por clave.
   * - La clave de administrador no tiene límites.
   * "history" son las consultas pesadas: historial de mediciones y de alertas.
   */
  rateLimit: {
    enabled: readBoolean("RATE_LIMIT_ENABLED", true),
    anonymous: {
      perMinute: 120,
      perDay: 30000,
      historyPerMinute: 20,
      historyPerDay: 500,
    },
    client: {
      perMinute: 300,
      perDay: 50000,
      historyPerMinute: 30,
      historyPerDay: 1000,
      writesPerMinute: 30,
    },
    /** Intentos con una clave inválida, por IP, antes de bloquear un rato. */
    authFailures: { limit: 20, windowMinutes: 10 },
  },
};

module.exports = config;
