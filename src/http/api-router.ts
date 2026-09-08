import type { HttpHandler, HttpResponse, StructuredLogger } from "./http-types.js";
import { problem, requestIdFrom } from "./responses.js";

export interface ApiRoute {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly handler: HttpHandler;
}

export function createApiRouter(input: {
  readonly routes: readonly ApiRoute[];
  readonly logger: StructuredLogger;
}): HttpHandler {
  const routes = new Map<string, HttpHandler>();
  const methodsByPath = new Map<string, Set<string>>();
  for (const route of input.routes) {
    const key = routeKey(route.method, route.path);
    if (routes.has(key)) throw new Error(`duplicate API route: ${key}`);
    routes.set(key, route.handler);
    const methods = methodsByPath.get(route.path) ?? new Set<string>();
    methods.add(route.method);
    methodsByPath.set(route.path, methods);
  }

  return async (request) => {
    const requestId = requestIdFrom(request.headers);
    const method = request.requestContext?.http?.method?.toUpperCase() ?? "";
    const path = request.rawPath ?? "";
    const handler = routes.get(routeKey(method, path));
    if (handler !== undefined) {
      try {
        return await handler(request);
      } catch {
        input.logger.error({ event: "unhandled_http_error", route: path || "unknown", requestId, status: 500 });
        return problem(500, requestId, "Service failure", "/problems/server-error");
      }
    }
    const allowed = methodsByPath.get(path);
    if (allowed !== undefined) {
      input.logger.info({ event: "http_request", route: path, requestId, status: 405 });
      return methodNotAllowed(requestId, [...allowed].sort());
    }
    input.logger.info({ event: "http_request", route: path || "unknown", requestId, status: 404 });
    return problem(404, requestId, "Route not found", "/problems/not-found");
  };
}

function routeKey(method: string, path: string): string {
  return `${method}\u0000${path}`;
}

function methodNotAllowed(requestId: string, allowedMethods: readonly string[]): HttpResponse {
  return {
    statusCode: 405,
    headers: {
      allow: allowedMethods.join(", "),
      "content-type": "application/problem+json",
      "x-request-id": requestId,
    },
    body: JSON.stringify({
      type: "/problems/method-not-allowed",
      title: "Method not allowed",
      status: 405,
      requestId,
    }),
  };
}
