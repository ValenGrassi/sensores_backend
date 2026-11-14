/**
 * Historial de un sensor en distintas resoluciones (series agregadas).
 *
 *   raw   cada medición tal como llegó          rangos de hasta 7 días
 *   hour  promedio por hora                     rangos de hasta 92 días
 *   day   promedio por día (zona TIME_ZONE)     cualquier rango
 *
 * "auto" elige la más detallada que permite el rango. Así un gráfico de
 * 6 meses trae ~180 puntos en vez de ~50.000 lecturas.
 */

const prisma = require("../lib/prisma");
const config = require("../config");

const DAY_MS = 24 * 60 * 60 * 1000;

const RESOLUTIONS = ["auto", "raw", "hour", "day"];

/** Rango máximo, en días, de cada resolución. */
const MAX_RANGE_DAYS = { raw: 7, hour: 92, day: Infinity };

const RESOLUTION_LABELS = { raw: "cada medición", hour: "promedio por hora", day: "promedio por día" };

function rangeDays(rangeMs) {
  return Math.max(0, Math.ceil(rangeMs / DAY_MS));
}

/**
 * Resolución a usar para un rango. Devuelve { resolution } o { issue } si la
 * pedida explícitamente no se permite para ese rango.
 */
function chooseResolution(requested, rangeMs) {
  if (requested === "auto" || requested === undefined) {
    const resolution = ["raw", "hour"].find((r) => rangeMs <= MAX_RANGE_DAYS[r] * DAY_MS) ?? "day";
    return { resolution };
  }

  if (rangeMs > MAX_RANGE_DAYS[requested] * DAY_MS) {
    const allowed = ["hour", "day"].filter((r) => rangeMs <= MAX_RANGE_DAYS[r] * DAY_MS);
    return {
      issue:
        `"${requested}" (${RESOLUTION_LABELS[requested]}) se permite para rangos de hasta ` +
        `${MAX_RANGE_DAYS[requested]} días y este abarca ${rangeDays(rangeMs)}. ` +
        `Usá ${allowed.map((r) => `"${r}"`).join(" o ")}, o no mandes resolution.`,
    };
  }

  return { resolution: requested };
}

/**
 * Promedios por hora o por día de un sensor entre `from` y `to`.
 * Cada punto: { sensorId, timestamp (inicio del intervalo), temperature, humidity, battery, samples }.
 *
 * La columna "timestamp" guarda la hora UTC sin zona; se convierte explícitamente
 * y el inicio de cada intervalo sale en milisegundos UTC, para que el resultado
 * no dependa de la zona horaria de la sesión de Postgres.
 */
async function aggregateMeasurements({ sensorId, from, to, resolution }) {
  const unit = resolution === "hour" ? "hour" : "day";
  const timeZone = config.timeZone;

  const rows = await prisma.$queryRaw`
    SELECT
      (extract(epoch FROM (date_trunc(${unit}, ("timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone})) * 1000)::float8 AS "bucketMs",
      round(avg("temperature")::numeric, 2)::float8 AS "temperature",
      round(avg("humidity")::numeric, 2)::float8 AS "humidity",
      round(avg("battery")::numeric, 2)::float8 AS "battery",
      count(*)::int AS "samples"
    FROM "Measurement"
    WHERE "sensorId" = ${sensorId}
      AND "timestamp" >= (${from.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND "timestamp" <= (${to.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    GROUP BY 1
    ORDER BY 1`;

  return rows.map((row) => ({
    sensorId,
    timestamp: new Date(row.bucketMs).toISOString(),
    temperature: row.temperature,
    humidity: row.humidity,
    battery: row.battery,
    samples: row.samples,
  }));
}

module.exports = { RESOLUTIONS, MAX_RANGE_DAYS, chooseResolution, aggregateMeasurements };
