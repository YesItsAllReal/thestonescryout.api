import type { HttpHandler, StructuredLogger } from "./http-types.js";
import { json, requestIdFrom } from "./responses.js";

export function createHealthHandler(logger: StructuredLogger): HttpHandler {
  return async (request) => {
    const requestId = requestIdFrom(request.headers);
    logger.info({ event: "http_request", route: "/health", requestId, status: 200 });
    return json(200, requestId, { status: "ok" });
  };
}
