/**
 * Validación de entrada sin dependencias externas.
 * Junta todos los problemas y responde un único 400 con el detalle por campo,
 * en lugar de cortar en el primero o dejar pasar valores como NaN.
 */

const { errors } = require("./errors");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Devuelve el body de un POST/PATCH o lanza el error que corresponde:
 * sin body, body que no es JSON, o JSON que no es un objeto.
 */
function requireJsonBody(req) {
  if (req.body === undefined) {
    const contentType = req.headers["content-type"];
    if (contentType && !req.is("application/json")) {
      throw errors.unsupportedMediaType();
    }
    throw errors.bodyRequired();
  }

  if (!isPlainObject(req.body)) {
    throw errors.validation([
      { field: "body", message: 'Tiene que ser un objeto JSON, por ejemplo { "name": "…" }.' },
    ]);
  }

  return req.body;
}

class Validator {
  constructor(source) {
    this.source = source ?? {};
    this.details = [];
  }

  issue(field, message) {
    this.details.push({ field, message });
  }

  has(field) {
    return this.source[field] !== undefined;
  }

  /** Texto. `nullable`: acepta null o "" y devuelve null. */
  string(field, { required = false, nullable = false, maxLength = 100 } = {}) {
    const raw = this.source[field];

    if (raw === undefined) {
      if (required) this.issue(field, "Es obligatorio.");
      return undefined;
    }

    if (raw === null) {
      if (nullable) return null;
      this.issue(field, "Es obligatorio y no puede ser null.");
      return undefined;
    }

    if (typeof raw !== "string") {
      this.issue(field, "Tiene que ser un texto.");
      return undefined;
    }

    const value = raw.trim();

    if (value === "") {
      if (nullable) return null;
      this.issue(field, "No puede estar vacío.");
      return undefined;
    }

    if (value.length > maxLength) {
      this.issue(field, `Puede tener como máximo ${maxLength} caracteres.`);
      return undefined;
    }

    return value;
  }

  /** Número finito. Acepta también texto numérico ("18.5"), como antes. */
  number(field, { required = false } = {}) {
    const raw = this.source[field];

    if (raw === undefined) {
      if (required) this.issue(field, "Es obligatorio.");
      return undefined;
    }

    const value =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : NaN;

    if (!Number.isFinite(value)) {
      this.issue(field, "Tiene que ser un número, por ejemplo 18.5.");
      return undefined;
    }

    return value;
  }

  /** Número opcional que también puede venir como null (lecturas del gateway). */
  nullableNumber(field) {
    const raw = this.source[field];
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    return this.number(field);
  }

  /** Entero dentro de un rango (parámetros de query como page). */
  integer(field, { defaultValue, min = 1, max } = {}) {
    const raw = this.source[field];
    if (raw === undefined || raw === "") return defaultValue;

    const value = Number(raw);

    if (!Number.isInteger(value)) {
      this.issue(field, "Tiene que ser un número entero.");
      return undefined;
    }

    if (value < min) {
      this.issue(field, `Tiene que ser mayor o igual a ${min}.`);
      return undefined;
    }

    if (max !== undefined && value > max) {
      this.issue(field, `Tiene que ser menor o igual a ${max}.`);
      return undefined;
    }

    return value;
  }

  /** Uno de varios valores permitidos. */
  oneOf(field, allowed, { defaultValue } = {}) {
    const raw = this.source[field];
    if (raw === undefined || raw === "") return defaultValue;

    if (typeof raw !== "string" || !allowed.includes(raw)) {
      this.issue(field, `Valores permitidos: ${allowed.join(", ")}.`);
      return undefined;
    }

    return raw;
  }

  /** "true" / "false" en la query. */
  boolean(field) {
    const raw = this.source[field];
    if (raw === undefined || raw === "") return undefined;
    if (raw === "true") return true;
    if (raw === "false") return false;

    this.issue(field, 'Tiene que ser "true" o "false".');
    return undefined;
  }

  /** Lanza un 400 con todos los problemas encontrados, si hubo alguno. */
  done() {
    if (this.details.length > 0) {
      throw errors.validation(this.details);
    }
  }
}

function validator(source) {
  return new Validator(source);
}

module.exports = { validator, requireJsonBody, isPlainObject };
