import type { NextApiRequest, NextApiResponse } from "next";
import { jevosHealth } from "@/lib/jevos";

export default async function handler(
  _request: NextApiRequest,
  response: NextApiResponse,
) {
  response.setHeader("Cache-Control", "no-store");
  const health = await jevosHealth();
  return response.status(health.ok ? 200 : 503).json(health);
}
