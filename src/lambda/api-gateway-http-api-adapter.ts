import type { HttpHandler } from "../http/http-types.js";

export interface ApiGatewayHttpApiV2Event {
  readonly version: "2.0";
  readonly rawPath: string;
  readonly headers?: Readonly<Record<string, string | undefined>> | undefined;
  readonly cookies?: readonly string[] | undefined;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | undefined;
  readonly requestContext: {
    readonly http: {
      readonly method: string;
      readonly sourceIp?: string | undefined;
    };
  };
  readonly body?: string | undefined;
  readonly isBase64Encoded?: boolean | undefined;
}

export interface ApiGatewayHttpApiV2Response {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly isBase64Encoded: false;
}

export function adaptApiGatewayHttpApi(handler: HttpHandler) {
  return async (event: ApiGatewayHttpApiV2Event): Promise<ApiGatewayHttpApiV2Response> => {
    const headers = {
      ...(event.headers ?? {}),
      ...(event.cookies === undefined || findHeader(event.headers, "cookie") !== undefined
        ? {}
        : { cookie: event.cookies.join("; ") }),
    };
    const response = await handler({
      rawPath: event.rawPath,
      headers,
      queryStringParameters: event.queryStringParameters,
      requestContext: { http: event.requestContext.http },
      body: decodeBody(event.body, event.isBase64Encoded ?? false),
    });
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
      isBase64Encoded: false,
    };
  };
}

function decodeBody(body: string | undefined, isBase64Encoded: boolean): string | undefined {
  if (body === undefined || !isBase64Encoded) return body;
  return Buffer.from(body, "base64").toString("utf8");
}

function findHeader(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}
