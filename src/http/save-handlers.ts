import {
  SaveIdempotencyConflictError,
  SaveNotFoundError,
  SaveRevisionConflictError,
  SaveService,
  SaveValidationError,
  type JsonValue,
  type SaveWriteRequest,
} from "../saves/save-service.js";
import type { AuthenticatedHandlerDependencies, HttpHandler } from "./http-types.js";
import { authenticateRequest, hasOnlyKeys, loggedProblem, logSuccess, parseJsonObject } from "./handler-support.js";
import { header, json, problemWithFields } from "./responses.js";

const route = "/v1/save";

export function createGetSaveHandler(
  service: SaveService,
  dependencies: AuthenticatedHandlerDependencies,
): HttpHandler {
  return async (request) => {
    const context = await authenticateRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const save = await service.get(context.principal, request.queryStringParameters?.slot ?? "primary");
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, save);
    } catch (error: unknown) {
      if (error instanceof SaveValidationError) {
        return loggedProblem(dependencies.logger, route, context.requestId, 400, "Request validation failed", "/problems/validation");
      }
      if (error instanceof SaveNotFoundError) {
        return loggedProblem(dependencies.logger, route, context.requestId, 404, "Save not found", "/problems/not-found");
      }
      return loggedProblem(dependencies.logger, route, context.requestId, 500, "Service failure", "/problems/server-error");
    }
  };
}

export function createPutSaveHandler(
  service: SaveService,
  dependencies: AuthenticatedHandlerDependencies,
): HttpHandler {
  return async (request) => {
    const context = await authenticateRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const save = await service.put({
        principal: context.principal,
        request: parseSaveWriteRequest(request.body),
        idempotencyKey: header(request.headers, "idempotency-key") ?? "",
      });
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, save);
    } catch (error: unknown) {
      if (error instanceof SyntaxError || error instanceof SaveValidationError) {
        return loggedProblem(dependencies.logger, route, context.requestId, 400, "Request validation failed", "/problems/validation");
      }
      if (error instanceof SaveRevisionConflictError) {
        dependencies.logger.info({ event: "http_request", route, requestId: context.requestId, status: 409 });
        return problemWithFields(
          409,
          context.requestId,
          "Save revision conflict",
          "/problems/save-revision-conflict",
          {
            slot: error.conflict.slot,
            currentRevision: error.conflict.currentRevision,
            ...(error.conflict.currentSchemaVersion === undefined ? {} : { currentSchemaVersion: error.conflict.currentSchemaVersion }),
            ...(error.conflict.currentUpdatedAt === undefined ? {} : { currentUpdatedAt: error.conflict.currentUpdatedAt }),
          },
        );
      }
      if (error instanceof SaveIdempotencyConflictError) {
        return loggedProblem(dependencies.logger, route, context.requestId, 409, "Idempotency key conflict", "/problems/idempotency-conflict");
      }
      return loggedProblem(dependencies.logger, route, context.requestId, 500, "Service failure", "/problems/server-error");
    }
  };
}

function parseSaveWriteRequest(body: string | undefined): SaveWriteRequest {
  const value = parseJsonObject(body);
  if (
    !hasOnlyKeys(value, ["slot", "expectedRevision", "schemaVersion", "snapshot", "deviceId"]) ||
    typeof value.slot !== "string" ||
    typeof value.expectedRevision !== "number" ||
    typeof value.schemaVersion !== "number" ||
    typeof value.deviceId !== "string" ||
    typeof value.snapshot !== "object" || value.snapshot === null || Array.isArray(value.snapshot)
  ) {
    throw new SyntaxError("invalid save write request");
  }
  return {
    slot: value.slot,
    expectedRevision: value.expectedRevision,
    schemaVersion: value.schemaVersion,
    snapshot: value.snapshot as JsonValue,
    deviceId: value.deviceId,
  };
}
