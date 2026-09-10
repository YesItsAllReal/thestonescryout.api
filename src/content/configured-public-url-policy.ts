import type { PublicUrlPolicy } from "./content-service.js";

export class ConfiguredPublicUrlPolicy implements PublicUrlPolicy {
  private readonly contentBase: URL;
  private readonly externalOrigins: ReadonlySet<string>;

  public constructor(contentBaseUrl: string, externalLinkOrigins: readonly string[]) {
    this.contentBase = parseHttpsUrl(contentBaseUrl, true);
    if (!this.contentBase.pathname.endsWith("/")) this.contentBase.pathname += "/";
    if (externalLinkOrigins.length > 32) throw new Error("too many external link origins");
    this.externalOrigins = new Set(externalLinkOrigins.map((value) => {
      const url = parseHttpsUrl(value, false);
      if (url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new Error("external link allowlist entries must be origins");
      return url.origin;
    }));
  }

  public allows(value: string, purpose: "content" | "externalLink"): boolean {
    let url: URL;
    try { url = new URL(value); } catch { return false; }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") return false;
    if (purpose === "content") {
      return url.origin === this.contentBase.origin && url.search === "" &&
        url.pathname.startsWith(this.contentBase.pathname) && url.pathname.length > this.contentBase.pathname.length;
    }
    return this.externalOrigins.has(url.origin);
  }
}

function parseHttpsUrl(value: string, allowPath: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("URL policy requires absolute HTTPS URLs"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
      (!allowPath && url.pathname !== "/")) throw new Error("URL policy requires absolute HTTPS URLs");
  return url;
}
