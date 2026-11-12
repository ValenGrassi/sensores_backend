const express = require("express");
const prisma = require("../lib/prisma");
const { validator } = require("../lib/validation");
const { toAlertDTO } = require("../services/alerts");

const router = express.Router();

/** GET /api/alerts?active=true|false — de la más nueva a la más vieja. */
router.get("/", async (req, res) => {
  const check = validator(req.query);
  const active = check.boolean("active");
  check.done();

  const alerts = await prisma.alert.findMany({
    where: active === undefined ? undefined : { active },
    include: { sensor: { select: { devEui: true } } },
    orderBy: { createdAt: "desc" },
  });

  res.json(alerts.map(toAlertDTO));
});

module.exports = router;
