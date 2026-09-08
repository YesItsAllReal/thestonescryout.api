import {
  ContentCatalogService,
  ContentIntegrityError,
  ContentPolicyError,
  ContentRequestValidationError,
  ContentUnavailableError,
  RemoteConfigurationService,
  type ClientPlatform,
  type ContentChannel,
} from "../content/content-service.js";
import type { AuthenticatedHandlerDependencies, HttpHandler } from "./http-types.js";
import { limitPublicRequest, loggedProblem, logSuccess } from "./handler-support.js";
import { json } from "./responses.js";

export function createContentCatalogHandler(
  service: ContentCatalogService,
  dependencies: Pick<AuthenticatedHandlerDependencies, "rateLimiter" | "logger" | "now">,
): HttpHandler {
  return async (request) => {
    const route = "/v1/content/catalog";
    const context = await limitPublicRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const query = request.queryStringParameters;
      const platform = parsePlatform(query?.platform);
      const channel = parseChannel(query?.channel);
      const appBuild = parseAppBuild(query?.appBuild);
      const locale = required(query?.locale, "locale");
      const catalog = await service.get({ platform, channel, appBuild, locale });
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, catalog);
    } catch (error: unknown) {
      return mapContentError(error, route, context.requestId, dependencies);
    }
  };
}

export function createRemoteConfigurationHandler(
  service: RemoteConfigurationService,
  dependencies: Pick<AuthenticatedHandlerDependencies, "rateLimiter" | "logger" | "now">,
): HttpHandler {
  return async (request) => {
    const route = "/v1/config";
    const context = await limitPublicRequest(request, route, dependencies);
    if (context.kind === "response") return context.response;
    try {
      const query = request.queryStringParameters;
      const config = await service.get({
        platform: parsePlatform(query?.platform),
        appBuild: parseAppBuild(query?.appBuild),
        locale: required(query?.locale, "locale"),
      });
      logSuccess(dependencies.logger, route, context.requestId, 200);
      return json(200, context.requestId, config);
    } catch (error: unknown) {
      return mapContentError(error, route, context.requestId, dependencies);
    }
  };
}

function mapContentError(
  error: unknown,
  route: string,
  requestId: string,
  dependencies: Pick<AuthenticatedHandlerDependencies, "logger">,
) {
  if (error instanceof SyntaxError || error instanceof ContentRequestValidationError) {
    return loggedProblem(dependencies.logger, route, requestId, 400, "Request validation failed", "/problems/validation");
  }
  if (error instanceof ContentUnavailableError || error instanceof ContentIntegrityError || error instanceof ContentPolicyError) {
    return loggedProblem(dependencies.logger, route, requestId, 503, "Signed configuration unavailable", "/problems/service-unavailable");
  }
  return loggedProblem(dependencies.logger, route, requestId, 500, "Service failure", "/problems/server-error");
}

function parsePlatform(value: string | undefined): ClientPlatform {
  if (value !== "ios" && value !== "android") throw new SyntaxError("platform is invalid");
  return value;
}

function parseChannel(value: string | undefined): ContentChannel {
  if (value !== "development" && value !== "staging" && value !== "production") throw new SyntaxError("channel is invalid");
  return value;
}

function parseAppBuild(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) throw new SyntaxError("appBuild is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new SyntaxError("appBuild is invalid");
  return parsed;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw new SyntaxError(`${name} is required`);
  return value;
}
