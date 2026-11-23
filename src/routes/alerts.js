const express = require("express");
const prisma = require("../lib/prisma");
const { errors } = require("../lib/errors");
const { validator } = require("../lib/validation");
const { historyLimit } = require("../middleware/rateLimit");
const { toAlertDTO } = require("../services/alerts");
const { PRESETS, resolveDateRange } = require("../services/measurements");

const router = express.Router();

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/** Las alertas activas son pocas y se consultan seguido; el historial cuenta como consulta pesada. */
function historyUnlessActive(req, res, next) {
  if (req.query.active === "true") return next();
  return historyLimit(req, res, next);
}

/**
 * GET /api/alerts?active=true|false&limit=200&cursor=<id>
 * De la más nueva a la más vieja. Como máximo `limit` alertas (200 por defecto, hasta 500).
 * Para seguir con las más viejas: cursor = id de la última alerta recibida.
 * Si se recibieron menos de `limit`, no hay más.
 * Fechas (según cuándo se abrió la alerta): preset o from/to.
 */
router.get("/", historyUnlessActive, async (req, res) => {
  const check = validator(req.query);
  const active = check.boolean("active");
  const limit = check.integer("limit", { defaultValue: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  const cursor = check.string("cursor", { maxLength: 100 });
  const preset = check.oneOf("preset", PRESETS);
  const from = check.date("from");
  const to = check.date("to");
  check.done();

  const { range, issue } = resolveDateRange({ preset, from, to });
  if (issue) {
    check.issue(issue.field, issue.message);
    check.done();
  }

  const where = {
    ...(active !== undefined && { active }),
    ...(Object.keys(range).length > 0 && { createdAt: range }),
  };

  if (cursor) {
    const exists = await prisma.alert.findFirst({ where: { ...where, id: cursor }, select: { id: true } });
    if (!exists) throw errors.alertCursorNotFound(cursor);
  }

  const alerts = await prisma.alert.findMany({
    where,
    include: { sensor: { select: { devEui: true } } },
    // id desempata alertas creadas en el mismo instante (temperatura y humedad juntas).
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
  });

  res.json(alerts.map(toAlertDTO));
});

module.exports = router;
