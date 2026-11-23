/**
 * Permisos de escritura que se le pueden dar a una clave de API.
 *
 * La lectura (GET) es pública y no necesita clave.
 * Lo estructural no es un permiso que se pueda dar: los sensores se registran
 * con `npm run sensors -- add <devEui>`, y los cines y salas los administra
 * solo la clave de administrador (requireAdmin), desde el frontend.
 */

const PERMISSIONS = {
  "sensors:write": "Cambiar el nombre y la sala de un sensor (PATCH /api/sensors/:devEui).",
  "profiles:write": "Crear, editar y eliminar perfiles de umbrales (POST, PATCH y DELETE /api/profiles).",
};

/** Comodín que solo tiene la clave de administrador. */
const ALL = "*";

function isKnownPermission(permission) {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, permission);
}

function hasPermission(client, permission) {
  return Boolean(client) && (client.permissions.includes(ALL) || client.permissions.includes(permission));
}

/** Lista explícita de permisos de un cliente (expande el comodín). */
function expandPermissions(permissions) {
  return permissions.includes(ALL) ? Object.keys(PERMISSIONS) : permissions.filter(isKnownPermission);
}

module.exports = { PERMISSIONS, ALL, isKnownPermission, hasPermission, expandPermissions };
