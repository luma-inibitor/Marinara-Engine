import type { FastifyInstance } from "fastify";
import { readRequestLog } from "../services/telemetry/request-telemetry.js";

export async function telemetryRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { chatId?: string; since?: string; limit?: string } }>("/requests", async (req, reply) => {
    if (Object.values(req.query).some((value) => typeof value !== "string")) {
      return reply.status(400).send({ error: "Query parameters must each have a single value" });
    }
    const since = req.query.since ? new Date(req.query.since) : undefined;
    if (since && Number.isNaN(since.getTime())) {
      return reply.status(400).send({ error: "since must be an ISO date" });
    }
    const limit = req.query.limit === undefined ? 500 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      return reply.status(400).send({ error: "limit must be a positive integer" });
    }
    const rows = await readRequestLog({ chatId: req.query.chatId || undefined, since, limit: Math.min(limit, 5000) });
    return { rows };
  });
}
