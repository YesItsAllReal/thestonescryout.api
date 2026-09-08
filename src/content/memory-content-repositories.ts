import type {
  ContentCatalogRepository,
  ContentCatalogRequest,
  RemoteConfigurationRepository,
  SignedContentCatalog,
  SignedRemoteConfiguration,
} from "./content-service.js";

export class MemoryContentCatalogRepository implements ContentCatalogRepository {
  public constructor(private readonly catalog: SignedContentCatalog | undefined) {}
  public async get(_request: ContentCatalogRequest): Promise<SignedContentCatalog | undefined> { return this.catalog; }
}

export class MemoryRemoteConfigurationRepository implements RemoteConfigurationRepository {
  public constructor(private readonly config: SignedRemoteConfiguration | undefined) {}
  public async get(): Promise<SignedRemoteConfiguration | undefined> { return this.config; }
}
