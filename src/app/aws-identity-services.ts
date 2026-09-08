import type { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AccountService, type AccountDeletionAuthorizer, type PlayerSessionRevoker } from "../accounts/account-service.js";
import { AppleAccountService } from "../accounts/apple-account-service.js";
import { AppleJwksVerifier } from "../accounts/apple-jwks-verifier.js";
import { GuestSessionService } from "../accounts/guest-session-service.js";
import { Sha256InstallationIdHasher } from "../accounts/sha256-installation-id-hasher.js";
import { AccountCognitoPrincipalResolver } from "../auth/account-cognito-principal-resolver.js";
import { CognitoGatewayAdapter } from "../auth/cognito-gateway-adapter.js";
import { CognitoSessionProvider } from "../auth/cognito-session-provider.js";
import { CognitoTokenVerifier } from "../auth/cognito-token-verifier.js";
import { DynamoRefreshRegistry } from "../auth/dynamo-refresh-registry.js";
import { SessionLifecycleService } from "../auth/session-lifecycle-service.js";
import { SaveService } from "../saves/save-service.js";
import { Sha256SaveDeviceIdHasher } from "../saves/sha256-save-device-id-hasher.js";
import { createAwsPersistence, type AwsPersistenceConfiguration } from "./aws-persistence.js";

export interface AwsIdentityConfiguration extends AwsPersistenceConfiguration {
  readonly tokenIssuer: string;
  readonly tokenAudience: string;
  readonly appleAudience: string | undefined;
  readonly cognitoUserPoolId: string;
  readonly cognitoClientId: string;
  readonly refreshLifetimeSeconds: number;
}

export function createAwsIdentityServices(input: {
  readonly documentClient: DynamoDBDocumentClient;
  readonly cognitoClient: CognitoIdentityProviderClient;
  readonly configuration: AwsIdentityConfiguration;
  readonly deletionAuthorizer: AccountDeletionAuthorizer;
  readonly sessionRevoker: PlayerSessionRevoker;
  readonly now: () => Date;
}) {
  const persistence = createAwsPersistence({
    documentClient: input.documentClient,
    configuration: input.configuration,
  });

  const sessionGateway = new CognitoGatewayAdapter(
    input.cognitoClient,
    input.configuration.cognitoUserPoolId,
    input.configuration.cognitoClientId,
  );

  const sessionProvider = new CognitoSessionProvider(
    sessionGateway,
    // Issue 2: pass the same gateway instance so DynamoRefreshRegistry can
    // best-effort revoke a replacement token if DynamoDB persistence fails.
    new DynamoRefreshRegistry(input.documentClient, input.configuration.playerTableName, sessionGateway),
    input.configuration.refreshLifetimeSeconds,
  );

  return {
    persistence,
    tokenVerifier: new CognitoTokenVerifier(
      input.configuration.tokenIssuer,
      input.configuration.tokenAudience,
      undefined,
      new AccountCognitoPrincipalResolver(persistence.account),
    ),
    guestSession: new GuestSessionService(
      persistence.guestPlayer,
      sessionProvider,
      new Sha256InstallationIdHasher(),
      input.now,
    ),
    // appleAccount is undefined when SCO_APPLE_AUDIENCE is not configured.
    // Apple routes return 503 in that case; the Lambda starts normally.
    appleAccount: input.configuration.appleAudience !== undefined
      ? new AppleAccountService(
          new AppleJwksVerifier(input.configuration.appleAudience),
          persistence.appleAccount,
          sessionProvider,
          input.now,
        )
      : undefined,
    account: new AccountService(
      persistence.account,
      input.deletionAuthorizer,
      input.sessionRevoker,
      input.now,
    ),
    save: new SaveService(persistence.save, new Sha256SaveDeviceIdHasher(), input.now),
    sessionLifecycle: new SessionLifecycleService(sessionProvider, input.now),
  };
}
