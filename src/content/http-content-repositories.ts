import {
  ContentUnavailableError,
  type ContentCatalogRepository,
  type ContentCatalogRequest,
  type RemoteConfigurationRepository,
  type SignedContentCatalog,
  type SignedRemoteConfiguration,
} from "./content-service.js";

type Fetch = typeof fetch;

export interface HttpContentRepositoryOptions {
  readonly baseUrl: string;
  readonly environment: "development" | "staging" | "production";
  readonly fetch?: Fetch;
  readonly timeoutMilliseconds?: number;
  readonly maximumResponseBytes?: number;
}

export class HttpContentCatalogRepository implements ContentCatalogRepository {
  private readonly client: StaticJsonClient;
  public constructor(options: HttpContentRepositoryOptions) { this.client = new StaticJsonClient(options); }

  public async get(request: ContentCatalogRequest): Promise<SignedContentCatalog | undefined> {
    const path = `catalogs/${segment(request.channel)}/${segment(request.platform)}/${segment(request.locale)}/latest.json`;
    return this.client.get(path) as Promise<SignedContentCatalog | undefined>;
  }
}

export class HttpRemoteConfigurationRepository implements RemoteConfigurationRepository {
  private readonly client: StaticJsonClient;
  private readonly environment: HttpContentRepositoryOptions["environment"];
  public constructor(options: HttpContentRepositoryOptions) {
    this.client = new StaticJsonClient(options);
    this.environment = options.environment;
  }

  public async get(input: { readonly platform: "ios" | "android"; readonly appBuild: number; readonly locale: string }): Promise<SignedRemoteConfiguration | undefined> {
    const path = `config/${segment(this.environment)}/${segment(input.platform)}/${segment(input.locale)}/latest.json`;
    return this.client.get(path) as Promise<SignedRemoteConfiguration | undefined>;
  }
}

class StaticJsonClient {
  private readonly base: URL;
  private readonly fetch: Fetch;
  private readonly timeoutMilliseconds: number;
  private readonly maximumResponseBytes: number;

  public constructor(options: HttpContentRepositoryOptions) {
    this.base = parseBaseUrl(options.baseUrl);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
    this.maximumResponseBytes = options.maximumResponseBytes ?? 1_048_576;
    if (!Number.isSafeInteger(this.timeoutMilliseconds) || this.timeoutMilliseconds < 100 || this.timeoutMilliseconds > 30_000 ||
        !Number.isSafeInteger(this.maximumResponseBytes) || this.maximumResponseBytes < 1_024 || this.maximumResponseBytes > 5_242_880) {
      throw new Error("content HTTP repository configuration is invalid");
    }
  }

  public async get(path: string): Promise<unknown | undefined> {
    const url = new URL(path, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) throw new ContentUnavailableError("content URL is unavailable");
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(this.timeoutMilliseconds),
        headers: { accept: "application/json" },
      });
    } catch {
      throw new ContentUnavailableError("content origin is unavailable");
    }
    if (response.status === 404) return undefined;
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ContentUnavailableError("content response is unavailable");
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > this.maximumResponseBytes)) {
      throw new ContentUnavailableError("content response is too large");
    }
    let body: string;
    try { body = await response.text(); } catch { throw new ContentUnavailableError("content response is unavailable"); }
    if (new TextEncoder().encode(body).byteLength > this.maximumResponseBytes) throw new ContentUnavailableError("content response is too large");
    try {
      const value: unknown = JSON.parse(body);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
      return value;
    } catch {
      throw new ContentUnavailableError("content response is invalid");
    }
  }
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("content base URL must be absolute HTTPS"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("content base URL must be absolute HTTPS");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function segment(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new ContentUnavailableError("content request path is invalid");
  return encodeURIComponent(value);
}
