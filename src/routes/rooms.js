const express = require("express");
const prisma = require("../lib/prisma");
const { validator } = require("../lib/validation");
const { toRoomDTO } = require("../services/sensors");

const router = express.Router();

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

module.exports = router;
