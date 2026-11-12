const express = require("express");
const prisma = require("../lib/prisma");
const { errors } = require("../lib/errors");
const { validator } = require("../lib/validation");
const { computeStats, toDashboard } = require("../services/stats");

const router = express.Router();

/** GET /api/stats?cinemaId= — indicadores generales (o de un cine). */
router.get("/stats", async (req, res) => {
  const check = validator(req.query);
  const cinemaId = check.string("cinemaId");
  check.done();

  if (cinemaId) {
    const cinema = await prisma.cinema.findUnique({ where: { id: cinemaId }, select: { id: true } });
    if (!cinema) throw errors.cinemaNotFound(cinemaId);
  }

  res.json(await computeStats({ cinemaId }));
});

/** GET /api/dashboard — mismos datos en la forma plana que usa el frontend. */
router.get("/dashboard", async (req, res) => {
  res.json(toDashboard(await computeStats()));
});

module.exports = router;
