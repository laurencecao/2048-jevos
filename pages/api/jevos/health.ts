import type { NextApiRequest, NextApiResponse } from "next";
import {
  defaultProviderId,
  engineHealth,
  engineList,
  isProviderId,
} from "@/lib/engine";

export default async function handler(
  request: NextApiRequest,
  response: NextApiResponse,
) {
  response.setHeader("Cache-Control", "no-store");

  const requested = request.query.provider;
  const provider = isProviderId(requested) ? requested : undefined;
  const health = await engineHealth(provider);

  return response.status(health.ok ? 200 : 503).json({
    ...health,
    defaultProvider: defaultProviderId(),
    engines: engineList().map((engine) => ({
      id: engine.id,
      label: engine.label,
      model: engine.model,
      transport: engine.transport,
    })),
  });
}
