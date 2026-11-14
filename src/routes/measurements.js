const express = require("express");
const prisma = require("../lib/prisma");
const { validator } = require("../lib/validation");
const { historyLimit } = require("../middleware/rateLimit");
const { normalizeDevEui } = require("../services/sensors");

const router = express.Router();

const MAX_PAGE_SIZE = 500;

/**
 * GET /api/measurements — historial paginado, de la más nueva a la más vieja.
 * Filtros: sensorId, devEui, cinemaId. Paginación: page, pageSize (hasta 500).
 * Cuenta como consulta pesada para el límite de pedidos.
 */
router.get("/", historyLimit, async (req, res) => {
  const check = validator(req.query);
  const sensorId = check.string("sensorId");
  const devEuiRaw = check.string("devEui");
  const cinemaId = check.string("cinemaId");
  const page = check.integer("page", { defaultValue: 1, min: 1 });
  const pageSize = check.integer("pageSize", { defaultValue: 20, min: 1, max: MAX_PAGE_SIZE });
  check.done();

  const devEui = devEuiRaw ? normalizeDevEui(devEuiRaw) : undefined;

  const sensorFilter = {
    ...(devEui && { devEui }),
    ...(cinemaId && { room: { cinemaId } }),
  };

  const where = {
    ...(sensorId && { sensorId }),
    ...(Object.keys(sensorFilter).length > 0 && { sensor: sensorFilter }),
  };

  const [measurements, total] = await Promise.all([
    prisma.measurement.findMany({
      where,
      include: { sensor: { include: { room: { include: { cinema: true } } } } },
      orderBy: { timestamp: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.measurement.count({ where }),
  ]);

  const rows = measurements.map((measurement) => ({
    id: measurement.id,
    timestamp: measurement.timestamp,

    temperature: measurement.temperature,
    humidity: measurement.humidity,
    battery: measurement.battery,

    sensorId: measurement.sensorId,
    devEui: measurement.sensor?.devEui ?? null,
    sensorName: measurement.sensor?.name ?? null,
    roomName: measurement.sensor?.room?.name ?? null,
    cinemaName: measurement.sensor?.room?.cinema?.name ?? null,
  }));

  res.json({ rows, total, page, pageSize });
});

module.exports = router;
