const express = require("express");
const prisma = require("../lib/prisma");
const { errors } = require("../lib/errors");
const { validator, requireJsonBody } = require("../lib/validation");
const { requireAdmin } = require("../middleware/auth");
const { isOnline, toSensorDTO, toCinemaRefDTO } = require("../services/sensors");

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

// ─── Alta, edición y baja: solo la clave de administrador ─────────────────────

async function findCinemaOrThrow(id) {
  const cinema = await prisma.cinema.findUnique({ where: { id } });
  if (!cinema) throw errors.cinemaNotFound(id);
  return cinema;
}

/** POST /api/cinemas { name, address } */
router.post("/", requireAdmin, async (req, res) => {
  const check = validator(requireJsonBody(req));
  const name = check.string("name", { required: true, maxLength: 100 });
  const address = check.string("address", { required: true, maxLength: 200 });
  check.done();

  const cinema = await prisma.cinema.create({ data: { name, address } });
  res.status(201).json(toCinemaRefDTO(cinema));
});

/** PATCH /api/cinemas/:id { name?, address? } */
router.patch("/:id", requireAdmin, async (req, res) => {
  const check = validator(requireJsonBody(req));
  const name = check.string("name", { maxLength: 100 });
  const address = check.string("address", { maxLength: 200 });
  check.done();

  await findCinemaOrThrow(req.params.id);
  const cinema = await prisma.cinema.update({
    where: { id: req.params.id },
    data: { ...(name !== undefined && { name }), ...(address !== undefined && { address }) },
  });
  res.json(toCinemaRefDTO(cinema));
});

/** DELETE /api/cinemas/:id — solo si no tiene salas (la base borraría las salas en cascada). */
router.delete("/:id", requireAdmin, async (req, res) => {
  await findCinemaOrThrow(req.params.id);

  const roomCount = await prisma.room.count({ where: { cinemaId: req.params.id } });
  if (roomCount > 0) throw errors.cinemaHasRooms(roomCount);

  await prisma.cinema.delete({ where: { id: req.params.id } });
  res.sendStatus(204);
});

module.exports = router;
