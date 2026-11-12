/**
 * Indicadores agregados: los usa /api/stats (genérico, para terceros)
 * y /api/dashboard (la forma plana que consume tu frontend).
 */

const prisma = require("../lib/prisma");
const { isOnline } = require("./sensors");
const { ALERT_TYPES } = require("./alerts");

function average(values) {
  if (values.length === 0) return null; // sin datos ≠ 0 °C
  const sum = values.reduce((total, value) => total + value, 0);
  return Math.round((sum / values.length) * 10) / 10;
}

function numbersOf(sensors, key) {
  return sensors.map((sensor) => sensor[key]).filter((value) => typeof value === "number");
}

/**
 * @param cinemaId opcional: limita todo a un cine
 */
async function computeStats({ cinemaId } = {}) {
  const sensorWhere = cinemaId ? { room: { cinemaId } } : {};

  const [cinemaCount, roomCount, sensors, activeAlerts] = await Promise.all([
    cinemaId ? Promise.resolve(1) : prisma.cinema.count(),
    prisma.room.count({ where: cinemaId ? { cinemaId } : {} }),
    prisma.sensor.findMany({
      where: sensorWhere,
      select: { id: true, lastSeen: true, temperature: true, humidity: true, roomId: true },
    }),
    prisma.alert.findMany({
      where: { active: true, ...(cinemaId && { sensor: sensorWhere }) },
      select: { sensorId: true, type: true },
    }),
  ]);

  const now = Date.now();
  const online = sensors.filter((sensor) => isOnline(sensor, now));
  const sensorsWithAlerts = new Set(activeAlerts.map((alert) => alert.sensorId)).size;

  const byType = Object.fromEntries(ALERT_TYPES.map((type) => [type, 0]));
  for (const alert of activeAlerts) byType[alert.type] += 1;

  return {
    generatedAt: new Date(now).toISOString(),
    cinemaId: cinemaId ?? null,

    cinemas: cinemaCount,
    rooms: roomCount,

    sensors: {
      total: sensors.length,
      online: online.length,
      offline: sensors.length - online.length,
      withActiveAlerts: sensorsWithAlerts,
      unassigned: sensors.filter((sensor) => !sensor.roomId).length,
    },

    alerts: {
      active: activeAlerts.length,
      byType,
    },

    // Promedio de los sensores online (los offline tienen datos viejos).
    averages: {
      temperature: average(numbersOf(online, "temperature")),
      humidity: average(numbersOf(online, "humidity")),
    },
  };
}

/** Forma plana histórica de /api/dashboard. */
function toDashboard(stats) {
  return {
    cinemaCount: stats.cinemas,
    sensorCount: stats.sensors.total,
    sensorsOnline: stats.sensors.online,
    sensorsOffline: stats.sensors.offline,

    activeAlerts: stats.alerts.active,
    sensorsWithAlerts: stats.sensors.withActiveAlerts,
    /** @deprecated usar sensorsWithAlerts. Se mantiene para no romper clientes viejos. */
    sensorsAlert: stats.sensors.withActiveAlerts,

    avgTemperature: stats.averages.temperature,
    avgHumidity: stats.averages.humidity,
  };
}

module.exports = { computeStats, toDashboard };
