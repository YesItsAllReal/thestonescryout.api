export interface HttpRequest {
  readonly body?: string | undefined;
  readonly headers?: Readonly<Record<string, string | undefined>> | undefined;
  readonly requestContext?: {
    readonly http?: { readonly sourceIp?: string | undefined } | undefined;
  } | undefined;
}

export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type HttpHandler = (request: HttpRequest) => Promise<HttpResponse>;

export interface RateLimiter {
  allow(input: {
    readonly route: string;
    readonly discriminator: string;
    readonly now: Date;
  }): Promise<{ readonly allowed: boolean; readonly retryAfterSeconds?: number }>;
}

export interface StructuredLogger {
  info(event: Readonly<Record<string, string | number | boolean>>): void;
  error(event: Readonly<Record<string, string | number | boolean>>): void;
}
