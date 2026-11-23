const express = require("express");
const prisma = require("../lib/prisma");
const { errors } = require("../lib/errors");
const { validator, requireJsonBody } = require("../lib/validation");
const { requireAdmin } = require("../middleware/auth");
const { evaluateSensorAlerts } = require("../services/alerts");
const { toRoomDTO } = require("../services/sensors");

const router = express.Router();

/** Tipos de sala (los mismos que muestra el frontend). */
const ROOM_TYPES = ["projection", "hall", "lobby", "storage", "other"];

/** GET /api/rooms?cinemaId= */
router.get("/", async (req, res) => {
  const check = validator(req.query);
  const cinemaId = check.string("cinemaId");
  check.done();

  const rooms = await prisma.room.findMany({
    where: cinemaId ? { cinemaId } : undefined,
    orderBy: { name: "asc" },
  });

  res.json(rooms.map(toRoomDTO));
});

// ─── Alta, edición y baja: solo la clave de administrador ─────────────────────

async function findRoomOrThrow(id) {
  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) throw errors.roomNotFound(id);
  return room;
}

async function checkProfileExists(profileId) {
  const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { id: true } });
  if (!profile) throw errors.profileNotFound(profileId);
}

/** POST /api/rooms { cinemaId, name, type, profileId } */
router.post("/", requireAdmin, async (req, res) => {
  const check = validator(requireJsonBody(req));
  const cinemaId = check.string("cinemaId", { required: true });
  const name = check.string("name", { required: true, maxLength: 100 });
  const type = check.string("type", { required: true });
  const profileId = check.string("profileId", { required: true });
  if (type !== undefined && !ROOM_TYPES.includes(type)) check.issue("type", `Valores permitidos: ${ROOM_TYPES.join(", ")}.`);
  check.done();

  const cinema = await prisma.cinema.findUnique({ where: { id: cinemaId }, select: { id: true } });
  if (!cinema) throw errors.cinemaNotFound(cinemaId);
  await checkProfileExists(profileId);

  const room = await prisma.room.create({ data: { cinemaId, name, type, profileId } });
  res.status(201).json(toRoomDTO(room));
});

/** PATCH /api/rooms/:id { name?, type?, profileId? } — la sala no cambia de cine. */
router.patch("/:id", requireAdmin, async (req, res) => {
  const check = validator(requireJsonBody(req));
  const name = check.string("name", { maxLength: 100 });
  const type = check.string("type");
  const profileId = check.string("profileId");
  if (type !== undefined && !ROOM_TYPES.includes(type)) check.issue("type", `Valores permitidos: ${ROOM_TYPES.join(", ")}.`);
  check.done();

  const current = await findRoomOrThrow(req.params.id);
  if (profileId !== undefined) await checkProfileExists(profileId);

  const room = await prisma.room.update({
    where: { id: current.id },
    data: {
      ...(name !== undefined && { name }),
      ...(type !== undefined && { type }),
      ...(profileId !== undefined && { profileId }),
    },
  });

  // Otro perfil = otros rangos: se reevalúan ya las alertas de sus sensores.
  if (profileId !== undefined && profileId !== current.profileId) {
    const sensors = await prisma.sensor.findMany({ where: { roomId: room.id }, select: { id: true } });
    for (const sensor of sensors) {
      try {
        await evaluateSensorAlerts(sensor.id);
      } catch (error) {
        console.error(`[alertas] No se pudieron reevaluar las alertas del sensor ${sensor.id}:`, error);
      }
    }
  }

  res.json(toRoomDTO(room));
});

/** DELETE /api/rooms/:id — solo si no tiene sensores (se quedarían sin sala sin aviso). */
router.delete("/:id", requireAdmin, async (req, res) => {
  await findRoomOrThrow(req.params.id);

  const sensorCount = await prisma.sensor.count({ where: { roomId: req.params.id } });
  if (sensorCount > 0) throw errors.roomHasSensors(sensorCount);

  await prisma.room.delete({ where: { id: req.params.id } });
  res.sendStatus(204);
});

module.exports = router;
module.exports.ROOM_TYPES = ROOM_TYPES;
