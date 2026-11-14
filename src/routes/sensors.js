const express = require("express");
const prisma = require("../lib/prisma");
const { errors } = require("../lib/errors");
const { validator, requireJsonBody } = require("../lib/validation");
const { requirePermission } = require("../middleware/auth");
const { historyLimit } = require("../middleware/rateLimit");
const { evaluateSensorAlerts } = require("../services/alerts");
const { SENSOR_INCLUDE, toSensorDTO, normalizeDevEui } = require("../services/sensors");
const { RESOLUTIONS, chooseResolution, aggregateMeasurements } = require("../services/measurements");

const router = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rangos de tiempo de /api/sensors/:devEui/measurements (en días; null = todo). */
const PRESET_DAYS = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "3m": 91,
  "6m": 182,
  all: null,
};

async function findSensorOrThrow(devEui) {
  const sensor = await prisma.sensor.findUnique({ where: { devEui } });
  if (!sensor) throw errors.sensorNotFound(devEui);
  return sensor;
}

/** GET /api/sensors — todos los sensores con su estado y ubicación. */
router.get("/", async (req, res) => {
  const sensors = await prisma.sensor.findMany({
    include: SENSOR_INCLUDE,
    orderBy: { name: "asc" },
  });

  res.json(sensors.map((sensor) => toSensorDTO(sensor)));
});

/** GET /api/sensors/:devEui */
router.get("/:devEui", async (req, res) => {
  const devEui = normalizeDevEui(req.params.devEui);

  const sensor = await prisma.sensor.findUnique({
    where: { devEui },
    include: SENSOR_INCLUDE,
  });

  if (!sensor) throw errors.sensorNotFound(devEui);

  res.json(toSensorDTO(sensor));
});

/**
 * GET /api/sensors/:devEui/measurements?preset=24h|7d|30d|3m|6m|all&resolution=auto|raw|hour|day
 *
 * Con resolution=auto (por defecto): hasta 7 días devuelve cada medición; hasta
 * 92 días, promedios por hora; más, promedios por día. Con preset=all el rango
 * va desde la primera medición del sensor. El header X-Resolution dice cuál se usó.
 * Cuenta como consulta pesada para el límite de pedidos.
 */
router.get("/:devEui/measurements", historyLimit, async (req, res) => {
  const devEui = normalizeDevEui(req.params.devEui);

  const check = validator(req.query);
  const preset = check.oneOf("preset", Object.keys(PRESET_DAYS), { defaultValue: "24h" });
  const requested = check.oneOf("resolution", RESOLUTIONS, { defaultValue: "auto" });
  check.done();

  const sensor = await findSensorOrThrow(devEui);

  const now = new Date();
  const days = PRESET_DAYS[preset];

  let from;
  if (days === null) {
    const first = await prisma.measurement.findFirst({
      where: { sensorId: sensor.id },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true },
    });
    from = first ? first.timestamp : now;
  } else {
    from = new Date(now.getTime() - days * DAY_MS);
  }

  const { resolution, issue } = chooseResolution(requested, now.getTime() - from.getTime());
  if (issue) {
    check.issue("resolution", issue);
    check.done();
  }

  res.set("X-Resolution", resolution);

  if (resolution !== "raw") {
    res.json(await aggregateMeasurements({ sensorId: sensor.id, from, to: now, resolution }));
    return;
  }

  // Cada medición, igual que siempre.
  const measurements = await prisma.measurement.findMany({
    where: {
      sensorId: sensor.id,
      ...(days !== null && {
        timestamp: { gte: from, lte: now },
      }),
    },
    orderBy: { timestamp: "asc" },
  });

  res.json(measurements);
});

/**
 * PATCH /api/sensors/:devEui — cambiar nombre y sala.
 * Requiere el permiso "sensors:write".
 */
router.patch("/:devEui", requirePermission("sensors:write"), async (req, res) => {
  const devEui = normalizeDevEui(req.params.devEui);
  const body = requireJsonBody(req);

  const check = validator(body);
  const name = check.string("name", { required: true, maxLength: 100 });
  const roomId = check.string("roomId", { required: true });
  check.done();

  await findSensorOrThrow(devEui);

  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) throw errors.roomNotFound(roomId);

  const updated = await prisma.sensor.update({
    where: { devEui },
    data: { name, roomId },
  });

  // La sala nueva puede tener otro perfil: se reevalúan las alertas ya.
  try {
    await evaluateSensorAlerts(updated.id);
  } catch (error) {
    console.error(`[alertas] No se pudieron reevaluar las alertas de ${devEui}:`, error);
  }

  const sensor = await prisma.sensor.findUnique({
    where: { devEui },
    include: SENSOR_INCLUDE,
  });

  res.json(toSensorDTO(sensor));
});

module.exports = router;
