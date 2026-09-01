import { randomUUID } from "node:crypto";

import type { HttpResponse } from "./http-types.js";

export function requestIdFrom(headers: Readonly<Record<string, string | undefined>> | undefined): string {
  const supplied = header(headers, "x-request-id");
  return supplied !== undefined && isUuid(supplied) ? supplied : randomUUID();
}

export function header(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

export function json(statusCode: number, requestId: string, value: unknown): HttpResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
    body: JSON.stringify(value),
  };
}

export function problem(
  statusCode: number,
  requestId: string,
  title: string,
  type: string,
  detail?: string,
  retryAfterSeconds?: number,
): HttpResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/problem+json",
      "x-request-id": requestId,
      ...(retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) }),
    },
    body: JSON.stringify({ type, title, status: statusCode, ...(detail === undefined ? {} : { detail }), requestId }),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
