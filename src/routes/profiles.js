const express = require("express");
const prisma = require("../lib/prisma");
const { errors } = require("../lib/errors");
const { validator, requireJsonBody } = require("../lib/validation");
const { requirePermission } = require("../middleware/auth");
const { evaluateSensorAlerts } = require("../services/alerts");
const { toProfileDTO } = require("../services/sensors");

const router = express.Router();

const LIMITS = ["temperatureMin", "temperatureMax", "humidityMin", "humidityMax"];

/** Verifica que cada mínimo sea menor que su máximo. */
function checkRanges(check, values) {
  if (Number.isFinite(values.temperatureMin) && Number.isFinite(values.temperatureMax)) {
    if (values.temperatureMin >= values.temperatureMax) {
      check.issue(
        "temperatureMin",
        `La temperatura mínima (${values.temperatureMin}) tiene que ser menor que la máxima (${values.temperatureMax}).`
      );
    }
  }

  if (Number.isFinite(values.humidityMin) && Number.isFinite(values.humidityMax)) {
    if (values.humidityMin >= values.humidityMax) {
      check.issue(
        "humidityMin",
        `La humedad mínima (${values.humidityMin}) tiene que ser menor que la máxima (${values.humidityMax}).`
      );
    }
  }
}

async function findProfileOrThrow(id) {
  const profile = await prisma.profile.findUnique({ where: { id } });
  if (!profile) throw errors.profileNotFound(id);
  return profile;
}

/** GET /api/profiles */
router.get("/", async (req, res) => {
  const profiles = await prisma.profile.findMany({ orderBy: { name: "asc" } });
  res.json(profiles.map(toProfileDTO));
});

/** GET /api/profiles/:id */
router.get("/:id", async (req, res) => {
  const profile = await findProfileOrThrow(req.params.id);
  res.json(toProfileDTO(profile));
});

/** POST /api/profiles — requiere "profiles:write". */
router.post("/", requirePermission("profiles:write"), async (req, res) => {
  const body = requireJsonBody(req);

  const check = validator(body);
  const name = check.string("name", { required: true, maxLength: 100 });
  const description = check.string("description", { nullable: true, maxLength: 500 });
  const limits = Object.fromEntries(LIMITS.map((field) => [field, check.number(field, { required: true })]));
  checkRanges(check, limits);
  check.done();

  const profile = await prisma.profile.create({
    data: { name, description: description ?? null, ...limits },
  });

  res.status(201).json(toProfileDTO(profile));
});

/** PATCH /api/profiles/:id — cambios parciales; requiere "profiles:write". */
router.patch("/:id", requirePermission("profiles:write"), async (req, res) => {
  const id = req.params.id;
  const body = requireJsonBody(req);

  const check = validator(body);
  const name = check.string("name", { maxLength: 100 });
  const description = check.string("description", { nullable: true, maxLength: 500 });
  const changes = Object.fromEntries(LIMITS.map((field) => [field, check.number(field)]));
  check.done();

  const current = await findProfileOrThrow(id);

  const final = Object.fromEntries(LIMITS.map((field) => [field, changes[field] ?? current[field]]));
  checkRanges(check, final);
  check.done();

  const profile = await prisma.profile.update({
    where: { id },
    data: {
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...final,
    },
  });

  // Los umbrales cambiaron: se reevalúan ya los sensores que usan este perfil.
  const sensors = await prisma.sensor.findMany({
    where: { room: { profileId: id } },
    select: { id: true },
  });

  for (const sensor of sensors) {
    try {
      await evaluateSensorAlerts(sensor.id);
    } catch (error) {
      console.error(`[alertas] No se pudieron reevaluar las alertas del sensor ${sensor.id}:`, error);
    }
  }

  res.json(toProfileDTO(profile));
});

/** DELETE /api/profiles/:id — requiere "profiles:write". No se puede borrar un perfil en uso. */
router.delete("/:id", requirePermission("profiles:write"), async (req, res) => {
  const id = req.params.id;

  await findProfileOrThrow(id);

  const roomCount = await prisma.room.count({ where: { profileId: id } });
  if (roomCount > 0) throw errors.profileInUse(roomCount);

  await prisma.profile.delete({ where: { id } });

  res.sendStatus(204);
});

module.exports = router;
