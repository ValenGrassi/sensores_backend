const express = require("express");
const prisma = require("../lib/prisma");
const { errors } = require("../lib/errors");
const { isOnline, toSensorDTO } = require("../services/sensors");

const router = express.Router();

/**
 * Resumen de un cine. Estado "attention" si hay algún sensor offline
 * o alguna alerta activa; si no, "ok".
 *
 * activeAlerts      = cantidad de alertas activas
 * sensorsWithAlerts = cantidad de sensores con al menos una alerta activa
 */
function summarize(cinema, sensors, alerts) {
  const now = Date.now();
  const sensorsOnline = sensors.filter((sensor) => isOnline(sensor, now)).length;
  const sensorsOffline = sensors.length - sensorsOnline;
  const sensorsWithAlerts = new Set(alerts.map((alert) => alert.sensorId)).size;

  return {
    id: cinema.id,
    name: cinema.name,
    address: cinema.address,

    status: sensorsOffline > 0 || alerts.length > 0 ? "attention" : "ok",

    sensorCount: sensors.length,
    sensorsOnline,
    sensorsOffline,

    activeAlerts: alerts.length,
    sensorsWithAlerts,
  };
}

/** GET /api/cinemas — una sola consulta de alertas para todos los cines. */
router.get("/", async (req, res) => {
  const [cinemas, activeAlerts] = await Promise.all([
    prisma.cinema.findMany({
      include: { rooms: { include: { sensors: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.alert.findMany({
      where: { active: true, sensor: { roomId: { not: null } } },
      select: { sensorId: true, sensor: { select: { room: { select: { cinemaId: true } } } } },
    }),
  ]);

  const alertsByCinema = new Map();
  for (const alert of activeAlerts) {
    const cinemaId = alert.sensor.room?.cinemaId;
    if (!cinemaId) continue;
    if (!alertsByCinema.has(cinemaId)) alertsByCinema.set(cinemaId, []);
    alertsByCinema.get(cinemaId).push(alert);
  }

  res.json(
    cinemas.map((cinema) =>
      summarize(
        cinema,
        cinema.rooms.flatMap((room) => room.sensors),
        alertsByCinema.get(cinema.id) ?? []
      )
    )
  );
});

/** GET /api/cinemas/:id — resumen + salas con sus sensores. */
router.get("/:id", async (req, res) => {
  const cinema = await prisma.cinema.findUnique({
    where: { id: req.params.id },
    include: { rooms: { include: { profile: true, sensors: true } } },
  });

  if (!cinema) throw errors.cinemaNotFound(req.params.id);

  const activeAlerts = await prisma.alert.findMany({
    where: { active: true, sensor: { room: { cinemaId: cinema.id } } },
    select: { sensorId: true },
  });

  const sensors = cinema.rooms.flatMap((room) => room.sensors);

  res.json({
    ...summarize(cinema, sensors, activeAlerts),

    rooms: cinema.rooms.map((room) => ({
      id: room.id,
      name: room.name,
      type: room.type,
      profileId: room.profileId,

      sensors: room.sensors.map((sensor) =>
        toSensorDTO(sensor, { room: { ...room, cinemaId: cinema.id }, cinema, profile: room.profile })
      ),
    })),
  });
});

module.exports = router;
