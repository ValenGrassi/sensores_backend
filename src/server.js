require("dotenv").config();

const cors = require("cors");
const express = require("express");
const prisma = require("./lib/prisma");
const { evaluateSensorAlert } = require("./utils/evaluateSensorAlert");

const app = express();

app.use(
  cors({
    origin: "http://localhost:3000",
  })
);

app.use(express.json());

const SENSOR_OFFLINE_MINUTES = 30;

/**
 * Determina si un sensor está online u offline
 */
function getSensorStatus(lastSeen) {
  if (!lastSeen) {
    return "offline";
  }

  const minutesSinceLastSeen =
    (Date.now() - new Date(lastSeen).getTime()) / (1000 * 60);

  return minutesSinceLastSeen < SENSOR_OFFLINE_MINUTES
    ? "online"
    : "offline";
}

/**
 * =========================================================
 * TELEMETRÍA
 * =========================================================
 */

app.post("/api/telemetry", async (req, res) => {
  try {
    console.log("--------------------------------");
    console.log(new Date().toLocaleString());
    console.log(JSON.stringify(req.body, null, 2));

    const {
      devEUI,
      deviceName,
      gatewayTime,
      temperature,
      humidity,
      battery,
    } = req.body;

    if (!devEUI) {
      return res.status(400).json({
        error: "devEUI es obligatorio",
      });
    }

    const devEui = devEUI.toLowerCase();

    const timestamp = gatewayTime
      ? new Date(gatewayTime)
      : new Date();

    const sensor = await prisma.sensor.upsert({
      where: {
        devEui,
      },

      update: {
        temperature,
        humidity,
        battery: battery ?? undefined,
        lastSeen: timestamp,
      },

      create: {
        devEui,
        name: deviceName,
        temperature,
        humidity,
        battery: battery ?? undefined,
        lastSeen: timestamp,
      },
    });

    /**
     * Guardar histórico de mediciones
     */
    await prisma.measurement.create({
      data: {
        sensorId: sensor.id,
        timestamp,
        temperature: temperature ?? null,
        humidity: humidity ?? null,
        battery: battery ?? null
      },
    });

    /**
     * Evaluar alertas
     */
    await evaluateSensorAlert(sensor.id);

    console.log("Medición guardada correctamente.");

    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudo guardar la medición",
    });
  }
});

/**
 * =========================================================
 * SENSORES
 * =========================================================
 */

app.get("/api/sensors", async (req, res) => {
  try {
    const sensors = await prisma.sensor.findMany({
      include: {
        room: {
          include: {
            cinema: true,
            profile: true,
          },
        },
      },

      orderBy: {
        name: "asc",
      },
    });

    const result = sensors.map((sensor) => {
      const status = getSensorStatus(sensor.lastSeen);

      return {
        id: sensor.id,
        devEui: sensor.devEui,
        name: sensor.name,

        temperature: sensor.temperature,
        humidity: sensor.humidity,
        battery: sensor.battery,
        lastSeen: sensor.lastSeen,

        status,

        room: sensor.room
          ? {
              id: sensor.room.id,
              cinemaId: sensor.room.cinemaId,
              name: sensor.room.name,
              type: sensor.room.type,
              profileId: sensor.room.profileId,
            }
          : null,

        cinema: sensor.room?.cinema
          ? {
              id: sensor.room.cinema.id,
              name: sensor.room.cinema.name,
              address: sensor.room.cinema.address,
            }
          : null,

        profile: sensor.room?.profile
          ? {
              id: sensor.room.profile.id,
              name: sensor.room.profile.name,
              description: sensor.room.profile.description,

              temperatureMin:
                sensor.room.profile.temperatureMin,

              temperatureMax:
                sensor.room.profile.temperatureMax,

              humidityMin:
                sensor.room.profile.humidityMin,

              humidityMax:
                sensor.room.profile.humidityMax,
            }
          : null,
      };
    });

    res.json(result);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudieron obtener los sensores",
    });
  }
});

app.get("/api/sensors/:devEui", async (req, res) => {
  try {
    const devEui = req.params.devEui.toLowerCase();

    const sensor = await prisma.sensor.findUnique({
      where: {
        devEui,
      },

      include: {
        room: {
          include: {
            cinema: true,
            profile: true,
          },
        },
      },
    });

    if (!sensor) {
      return res.status(404).json({
        error: "Sensor no encontrado",
      });
    }

    res.json({
      id: sensor.id,
      devEui: sensor.devEui,
      name: sensor.name,

      temperature: sensor.temperature,
      humidity: sensor.humidity,
      battery: sensor.battery,
      lastSeen: sensor.lastSeen,

      status: getSensorStatus(sensor.lastSeen),

      room: sensor.room
        ? {
            id: sensor.room.id,
            cinemaId: sensor.room.cinemaId,
            name: sensor.room.name,
            type: sensor.room.type,
            profileId: sensor.room.profileId,
          }
        : null,

      cinema: sensor.room?.cinema
        ? {
            id: sensor.room.cinema.id,
            name: sensor.room.cinema.name,
            address: sensor.room.cinema.address,
          }
        : null,

      profile: sensor.room?.profile
        ? {
            id: sensor.room.profile.id,
            name: sensor.room.profile.name,
            description: sensor.room.profile.description,

            temperatureMin:
              sensor.room.profile.temperatureMin,

            temperatureMax:
              sensor.room.profile.temperatureMax,

            humidityMin:
              sensor.room.profile.humidityMin,

            humidityMax:
              sensor.room.profile.humidityMax,
          }
        : null,
    });
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudo obtener el sensor",
    });
  }
});

app.get(
  "/api/sensors/:devEui/measurements",
  async (req, res) => {
    try {
      const devEui = req.params.devEui.toLowerCase();
      const { preset = "24h" } = req.query;

      const sensor = await prisma.sensor.findUnique({
        where: {
          devEui,
        },
      });

      if (!sensor) {
        return res.status(404).json({
          error: "Sensor no encontrado",
        });
      }

      const now = new Date();

      let from = null;

      switch (preset) {
        case "24h":
          from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          break;

        case "7d":
          from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;

        case "30d":
          from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;

        case "3m":
          from = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
          break;

        case "6m":
          from = new Date(now.getTime() - 182 * 24 * 60 * 60 * 1000);
          break;

        case "all":
          from = null;
          break;

        default:
          from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      }

      const measurements = await prisma.measurement.findMany({
        where: {
          sensorId: sensor.id,

          ...(from && {
            timestamp: {
              gte: from,
              lte: now,
            },
          }),
        },

        orderBy: {
          timestamp: "asc",
        },
      });

      res.json(measurements);

    } catch (error) {
      console.error("ERROR:", error);

      res.status(500).json({
        error: "No se pudieron obtener las mediciones",
      });
    }
  }
);

/**
 * Cambiar nombre y sala del sensor
 */
app.patch("/api/sensors/:devEui", async (req, res) => {
  try {
    const devEui = req.params.devEui.toLowerCase();

    const { name, roomId } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: "El nombre es obligatorio",
      });
    }

    if (!roomId) {
      return res.status(400).json({
        error: "La sala es obligatoria",
      });
    }

    const existingSensor =
      await prisma.sensor.findUnique({
        where: {
          devEui,
        },
      });

    if (!existingSensor) {
      return res.status(404).json({
        error: "Sensor no encontrado",
      });
    }

    const room = await prisma.room.findUnique({
      where: {
        id: roomId,
      },
    });

    if (!room) {
      return res.status(404).json({
        error: "Sala no encontrada",
      });
    }

    const sensor = await prisma.sensor.update({
      where: {
        devEui,
      },

      data: {
        name: name.trim(),
        roomId,
      },
    });

    res.json(sensor);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudo actualizar el sensor",
    });
  }
});

/**
 * =========================================================
 * PERFILES
 * =========================================================
 */

app.get("/api/profiles", async (req, res) => {
  try {
    const profiles = await prisma.profile.findMany({
      orderBy: {
        name: "asc",
      },
    });

    res.json(profiles);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudieron obtener los perfiles",
    });
  }
});

app.post("/api/profiles", async (req, res) => {
  try {
    const {
      name,
      description,
      temperatureMin,
      temperatureMax,
      humidityMin,
      humidityMax,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: "El nombre es obligatorio",
      });
    }

    if (
      temperatureMin === undefined ||
      temperatureMax === undefined ||
      humidityMin === undefined ||
      humidityMax === undefined
    ) {
      return res.status(400).json({
        error: "Todos los límites son obligatorios",
      });
    }

    if (
      Number(temperatureMin) >=
      Number(temperatureMax)
    ) {
      return res.status(400).json({
        error:
          "La temperatura mínima debe ser menor que la máxima",
      });
    }

    if (
      Number(humidityMin) >=
      Number(humidityMax)
    ) {
      return res.status(400).json({
        error:
          "La humedad mínima debe ser menor que la máxima",
      });
    }

    const profile = await prisma.profile.create({
      data: {
        name: name.trim(),

        description:
          description?.trim() || null,

        temperatureMin:
          Number(temperatureMin),

        temperatureMax:
          Number(temperatureMax),

        humidityMin:
          Number(humidityMin),

        humidityMax:
          Number(humidityMax),
      },
    });

    res.status(201).json(profile);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudo crear el perfil",
    });
  }
});

app.patch("/api/profiles/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const {
      name,
      description,
      temperatureMin,
      temperatureMax,
      humidityMin,
      humidityMax,
    } = req.body;

    /**
     * Obtener perfil actual
     */
    const currentProfile =
      await prisma.profile.findUnique({
        where: {
          id,
        },
      });

    if (!currentProfile) {
      return res.status(404).json({
        error: "Perfil no encontrado",
      });
    }

    /**
     * Calcular valores finales
     */
    const finalTemperatureMin =
      temperatureMin !== undefined
        ? Number(temperatureMin)
        : currentProfile.temperatureMin;

    const finalTemperatureMax =
      temperatureMax !== undefined
        ? Number(temperatureMax)
        : currentProfile.temperatureMax;

    const finalHumidityMin =
      humidityMin !== undefined
        ? Number(humidityMin)
        : currentProfile.humidityMin;

    const finalHumidityMax =
      humidityMax !== undefined
        ? Number(humidityMax)
        : currentProfile.humidityMax;

    /**
     * Validar rangos
     */
    if (
      finalTemperatureMin >=
      finalTemperatureMax
    ) {
      return res.status(400).json({
        error:
          "La temperatura mínima debe ser menor que la máxima",
      });
    }

    if (
      finalHumidityMin >=
      finalHumidityMax
    ) {
      return res.status(400).json({
        error:
          "La humedad mínima debe ser menor que la máxima",
      });
    }

    /**
     * Actualizar perfil
     */
    const profile = await prisma.profile.update({
      where: {
        id,
      },

      data: {
        ...(name !== undefined && {
          name: name.trim(),
        }),

        ...(description !== undefined && {
          description:
            description?.trim() || null,
        }),

        temperatureMin:
          finalTemperatureMin,

        temperatureMax:
          finalTemperatureMax,

        humidityMin:
          finalHumidityMin,

        humidityMax:
          finalHumidityMax,
      },
    });

    /**
     * Buscar sensores que utilizan este perfil
     */
    const sensors = await prisma.sensor.findMany({
      where: {
        room: {
          profileId: id,
        },
      },

      select: {
        id: true,
      },
    });

    /**
     * Reevaluar alertas inmediatamente
     */
    for (const sensor of sensors) {
      await evaluateSensorAlert(sensor.id);
    }

    res.json(profile);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudo actualizar el perfil",
    });
  }
});

app.delete("/api/profiles/:id", async (req, res) => {
  try {
    const id = req.params.id;

    await prisma.profile.delete({
      where: {
        id,
      },
    });

    res.sendStatus(204);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudo eliminar el perfil",
    });
  }
});

/**
 * =========================================================
 * CINEMAS
 * =========================================================
 */

app.get("/api/cinemas", async (req, res) => {
  try {
    const cinemas = await prisma.cinema.findMany({
      include: {
        rooms: {
          include: {
            sensors: true,
          },
        },
      },

      orderBy: {
        name: "asc",
      },
    });

    const result = await Promise.all(
      cinemas.map(async (cinema) => {
        const sensors =
          cinema.rooms.flatMap(
            (room) => room.sensors
          );

        const sensorsOnline =
          sensors.filter((sensor) => {
            return (
              getSensorStatus(
                sensor.lastSeen
              ) === "online"
            );
          }).length;

        const sensorsOffline =
          sensors.length - sensorsOnline;

        /**
         * Alertas activas de este cine
         */
        const activeAlerts =
          await prisma.alert.count({
            where: {
              active: true,

              sensor: {
                room: {
                  cinemaId: cinema.id,
                },
              },
            },
          });

        return {
          id: cinema.id,
          name: cinema.name,
          address: cinema.address,

          status:
            sensorsOffline > 0 ||
            activeAlerts > 0
              ? "attention"
              : "ok",

          sensorCount: sensors.length,
          sensorsOnline,
          sensorsOffline,

          activeAlerts,
        };
      })
    );

    res.json(result);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudieron obtener los cines",
    });
  }
});

app.get("/api/cinemas/:id", async (req, res) => {
  try {
    const cinema =
      await prisma.cinema.findUnique({
        where: {
          id: req.params.id,
        },

        include: {
          rooms: {
            include: {
              profile: true,
              sensors: true,
            },
          },
        },
      });

    if (!cinema) {
      return res.status(404).json({
        error: "Cine no encontrado",
      });
    }

    const sensors =
      cinema.rooms.flatMap(
        (room) => room.sensors
      );

    const sensorsOnline =
      sensors.filter((sensor) => {
        return (
          getSensorStatus(
            sensor.lastSeen
          ) === "online"
        );
      }).length;

    /**
     * Alertas activas del cine
     */
    const activeAlerts =
      await prisma.alert.count({
        where: {
          active: true,

          sensor: {
            room: {
              cinemaId: cinema.id,
            },
          },
        },
      });

    const result = {
      id: cinema.id,
      name: cinema.name,
      address: cinema.address,

      status:
        sensorsOnline < sensors.length ||
        activeAlerts > 0
          ? "attention"
          : "ok",

      sensorCount: sensors.length,

      sensorsOnline,

      sensorsOffline:
        sensors.length - sensorsOnline,

      activeAlerts,

      rooms: cinema.rooms.map(
        (room) => ({
          id: room.id,
          name: room.name,
          type: room.type,
          profileId: room.profileId,

          sensors: room.sensors.map(
            (sensor) => ({
              ...sensor,

              status:
                getSensorStatus(
                  sensor.lastSeen
                ),

              room: {
                id: room.id,
                cinemaId: cinema.id,
                name: room.name,
                type: room.type,
                profileId:
                  room.profileId,
              },

              cinema: {
                id: cinema.id,
                name: cinema.name,
                address:
                  cinema.address,
              },

              profile: room.profile,
            })
          ),
        })
      ),
    };

    res.json(result);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudo obtener el cine",
    });
  }
});

/**
 * =========================================================
 * SALAS
 * =========================================================
 */

app.get("/api/rooms", async (req, res) => {
  try {
    const { cinemaId } = req.query;

    const rooms =
      await prisma.room.findMany({
        where: cinemaId
          ? {
              cinemaId: String(cinemaId),
            }
          : undefined,

        orderBy: {
          name: "asc",
        },
      });

    res.json(rooms);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudieron obtener las salas",
    });
  }
});

/**
 * =========================================================
 * DASHBOARD
 * =========================================================
 */

app.get("/api/dashboard", async (req, res) => {
  try {
    const sensors =
      await prisma.sensor.findMany({
        include: {
          room: {
            include: {
              cinema: true,
              profile: true,
            },
          },
        },
      });

    const cinemaCount =
      await prisma.cinema.count();

    const sensorsOnline =
      sensors.filter((sensor) => {
        return (
          getSensorStatus(
            sensor.lastSeen
          ) === "online"
        );
      }).length;

    const sensorsOffline =
      sensors.filter((sensor) => {
        return (
          getSensorStatus(
            sensor.lastSeen
          ) === "offline"
        );
      }).length;

    /**
     * Cantidad de alertas activas
     */
    const activeAlerts =
      await prisma.alert.count({
        where: {
          active: true,
        },
      });

    const validTemperatures =
      sensors
        .map(
          (sensor) =>
            sensor.temperature
        )
        .filter(
          (value) => value !== null
        );

    const validHumidity =
      sensors
        .map(
          (sensor) =>
            sensor.humidity
        )
        .filter(
          (value) => value !== null
        );

    const avgTemperature =
      validTemperatures.length > 0
        ? validTemperatures.reduce(
            (sum, value) =>
              sum + value,
            0
          ) /
          validTemperatures.length
        : 0;

    const avgHumidity =
      validHumidity.length > 0
        ? validHumidity.reduce(
            (sum, value) =>
              sum + value,
            0
          ) /
          validHumidity.length
        : 0;

    res.json({
      cinemaCount,

      sensorCount:
        sensors.length,

      sensorsOnline,

      sensorsOffline,

      sensorsAlert: activeAlerts,

      avgTemperature,

      avgHumidity,
    });
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error:
        "No se pudo obtener el dashboard",
    });
  }
});

/**
 * =========================================================
 * ALERTAS
 * =========================================================
 */

app.get("/api/alerts", async (req, res) => {
  try {
    const active =
      req.query.active === undefined
        ? undefined
        : req.query.active === "true";

    const alerts =
      await prisma.alert.findMany({
        where:
          active === undefined
            ? undefined
            : {
                active,
              },

        orderBy: {
          createdAt: "desc",
        },
      });

    res.json(alerts);
  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error:
        "No se pudieron obtener las alertas",
    });
  }
});

app.get("/api/measurements", async (req, res) => {
  try {
    const {
      cinemaId,
      sensorId,
      page = 1,
      pageSize = 20
    } = req.query;

    const pageNumber = Math.max(Number(page), 1);
    const size = Math.max(Number(pageSize), 1);

    const where = {
      ...(sensorId && {
        sensorId: String(sensorId)
      }),

      ...(cinemaId && {
        sensor: {
          room: {
            cinemaId: String(cinemaId)
          }
        }
      })
    };

    const [measurements, total] = await Promise.all([
      prisma.measurement.findMany({
        where,

        include: {
          sensor: {
            include: {
              room: {
                include: {
                  cinema: true
                }
              }
            }
          }
        },

        orderBy: {
          timestamp: "desc"
        },

        skip: (pageNumber - 1) * size,
        take: size
      }),

      prisma.measurement.count({
        where
      })
    ]);

    const rows = measurements.map((measurement) => ({
      id: measurement.id,
      timestamp: measurement.timestamp,

      temperature: measurement.temperature,
      humidity: measurement.humidity,
      battery: measurement.battery,

      sensorId: measurement.sensorId,

      sensorName: measurement.sensor?.name ?? null,

      roomName: measurement.sensor?.room?.name ?? null,

      cinemaName: measurement.sensor?.room?.cinema?.name ?? null
    }));

    res.json({
      rows,
      total,
      page: pageNumber,
      pageSize: size
    });

  } catch (error) {
    console.error("ERROR:", error);

    res.status(500).json({
      error: "No se pudieron obtener las mediciones"
    });
  }
});

/**
 * =========================================================
 * SERVIDOR
 * =========================================================
 */

const PORT = 5000;

app.listen(PORT, () => {
  console.log(
    `Servidor iniciado en http://localhost:${PORT}`
  );
});