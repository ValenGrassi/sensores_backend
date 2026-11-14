/**
 * Límite de pedidos por cliente (los valores están en src/config.js → rateLimit).
 *
 * Quién es "el cliente":
 *   - sin clave            → su IP (tier "anonymous")
 *   - clave de un tercero  → la clave (tier "client")
 *   - clave de admin       → sin límites
 *
 * Qué se limita:
 *   - requests: todas las solicitudes, por minuto y por día.
 *   - writes:   escrituras de terceros (POST/PATCH/DELETE), por minuto.
 *   - history:  consultas pesadas (historial de mediciones y de alertas), por minuto y por día.
 *   - auth:     intentos con una clave inválida, por IP.
 *
 * La telemetría del gateway se monta ANTES de todo esto en app.js: nunca se limita.
 *
 * Cada respuesta informa el límite más cercano a agotarse en los headers
 * RateLimit-Limit, RateLimit-Remaining y RateLimit-Reset (segundos).
 * Al superarlo: 429 RATE_LIMITED con el header Retry-After (segundos).
 */

const { FixedWindowStore, ipKey } = require("../lib/rateLimit");
const { errors } = require("../lib/errors");

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function secondsUntil(timestamp, now) {
  return Math.max(1, Math.ceil((timestamp - now) / 1000));
}

/** Deja en los headers el límite con menos pedidos restantes de los que se evaluaron. */
function reportLimit(res, info) {
  const current = res.locals.rateLimit;
  if (current && current.remaining <= info.remaining) return;

  res.locals.rateLimit = info;
  res.set("RateLimit-Limit", String(info.limit));
  res.set("RateLimit-Remaining", String(info.remaining));
  res.set("RateLimit-Reset", String(info.resetSeconds));
}

function createRateLimiter(settings) {
  const enabled = settings.enabled !== false;

  const stores = {
    requestsMinute: new FixedWindowStore(MINUTE_MS),
    requestsDay: new FixedWindowStore(DAY_MS),
    writesMinute: new FixedWindowStore(MINUTE_MS),
    historyMinute: new FixedWindowStore(MINUTE_MS),
    historyDay: new FixedWindowStore(DAY_MS),
    authFailures: new FixedWindowStore(settings.authFailures.windowMinutes * MINUTE_MS),
  };

  function identify(req, { ignoreClient = false } = {}) {
    const client = ignoreClient ? null : req.client;
    if (client?.type === "admin") return { tier: "admin" };
    if (client) return { tier: "client", key: `key:${client.id}`, limits: settings.client };
    return { tier: "anonymous", key: ipKey(req.ip), limits: settings.anonymous };
  }

  function requestRules(who, req) {
    const rules = [
      { scope: "requests", store: stores.requestsMinute, limit: who.limits.perMinute },
      { scope: "requests", store: stores.requestsDay, limit: who.limits.perDay },
    ];
    if (who.tier === "client" && !READ_METHODS.has(req.method) && who.limits.writesPerMinute) {
      rules.push({ scope: "writes", store: stores.writesMinute, limit: who.limits.writesPerMinute });
    }
    return rules;
  }

  function historyRules(who) {
    return [
      { scope: "history", store: stores.historyMinute, limit: who.limits.historyPerMinute },
      { scope: "history", store: stores.historyDay, limit: who.limits.historyPerDay },
    ];
  }

  function reject(res, rule, state, now) {
    const retryAfterSeconds = secondsUntil(state.resetAt, now);
    res.locals.rateLimit = undefined;
    reportLimit(res, { limit: rule.limit, remaining: 0, resetSeconds: retryAfterSeconds });
    res.set("Retry-After", String(retryAfterSeconds));

    throw errors.rateLimited({
      scope: rule.scope,
      limit: rule.limit,
      windowSeconds: rule.store.windowMs / 1000,
      retryAfterSeconds,
    });
  }

  /** Revisa todas las reglas antes de contar: un pedido rechazado no consume cupo. */
  function enforce(res, rules, key) {
    const now = Date.now();

    for (const rule of rules) {
      const state = rule.store.peek(key, now);
      if (state.count >= rule.limit) reject(res, rule, state, now);
    }

    for (const rule of rules) {
      const state = rule.store.increment(key, now);
      reportLimit(res, {
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - state.count),
        resetSeconds: secondsUntil(state.resetAt, now),
      });
    }
  }

  function middleware(buildRules, options) {
    return function rateLimit(req, res, next) {
      if (!enabled) return next();
      const who = identify(req, options);
      if (who.tier === "admin") return next();
      enforce(res, buildRules(who, req), who.key);
      next();
    };
  }

  /** Antes de identifyClient: corta a quien prueba claves inválidas una y otra vez. */
  function authFailures(req, res, next) {
    if (!enabled || !req.get("X-API-Key")) return next();

    const key = ipKey(req.ip);
    const rule = { scope: "auth", store: stores.authFailures, limit: settings.authFailures.limit };
    const now = Date.now();
    const state = rule.store.peek(key, now);
    if (state.count >= rule.limit) reject(res, rule, state, now);

    res.on("finish", () => {
      if (res.statusCode === 401) rule.store.increment(key);
    });
    next();
  }

  /** Estado de los límites del cliente, para GET /api/me. */
  function status(req) {
    if (!enabled) return { enabled: false };

    const who = identify(req);
    if (who.tier === "admin") return { enabled: true, tier: "admin", unlimited: true };

    const now = Date.now();
    const describe = (store, limit) => {
      const state = store.peek(who.key, now);
      return {
        limit,
        remaining: Math.max(0, limit - state.count),
        resetSeconds: secondsUntil(state.resetAt, now),
      };
    };

    const limits = who.limits;
    return {
      enabled: true,
      tier: who.tier,
      requests: {
        perMinute: describe(stores.requestsMinute, limits.perMinute),
        perDay: describe(stores.requestsDay, limits.perDay),
      },
      history: {
        perMinute: describe(stores.historyMinute, limits.historyPerMinute),
        perDay: describe(stores.historyDay, limits.historyPerDay),
      },
      ...(who.tier === "client" && {
        writes: { perMinute: describe(stores.writesMinute, limits.writesPerMinute) },
      }),
    };
  }

  return {
    enabled,
    stores,
    /** Todas las solicitudes de /api (después de identifyClient). */
    requests: middleware(requestRules),
    /** Rutas públicas fuera de la autenticación (/, /health): siempre por IP. */
    anonymous: middleware(requestRules, { ignoreClient: true }),
    /** Consultas pesadas, se suma a `requests`. */
    history: middleware(historyRules),
    authFailures,
    status,
  };
}

/**
 * Para usar en las rutas: aplica el límite de consultas pesadas del limitador
 * que armó createApp (si no hay uno, no hace nada).
 */
function historyLimit(req, res, next) {
  const limiter = req.app.locals.rateLimiter;
  if (!limiter) return next();
  return limiter.history(req, res, next);
}

module.exports = { createRateLimiter, historyLimit };
