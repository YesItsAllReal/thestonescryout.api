import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDbAccountRepository } from "../accounts/dynamodb-account-repository.js";
import { DynamoDbAppleLinkRepository } from "../accounts/dynamodb-apple-link-repository.js";
import { DynamoDbAppleSignInRepository } from "../accounts/dynamodb-apple-sign-in-repository.js";
import { DynamoDbGuestPlayerRepository,type GuestStartingBalance } from "../accounts/dynamodb-guest-player-repository.js";
import type { AppleAccountRepository } from "../accounts/apple-account-service.js";
import { DynamoDbSaveRepository } from "../saves/dynamodb-save-repository.js";
import { DynamoDbEconomyRepository } from "../economy/dynamodb-economy-repository.js";
import { DynamoDbOfflineSyncRepository } from "../sync/dynamodb-offline-sync-repository.js";

export interface AwsPersistenceConfiguration {readonly playerTableName:string;readonly guestStartingBalance:GuestStartingBalance}
export class AccountLinkReconciliationNotConfiguredError extends Error {}

export function createAwsPersistence(input:{readonly documentClient:DynamoDBDocumentClient;readonly configuration:AwsPersistenceConfiguration;readonly resolveLinkConflict?:AppleAccountRepository["resolveLinkConflict"]}){
  const {documentClient:client,configuration}=input;
  if(configuration.playerTableName.trim()==="")throw new Error("player table name is required");
  const signIn=new DynamoDbAppleSignInRepository(client,configuration.playerTableName);
  const link=new DynamoDbAppleLinkRepository(client,configuration.playerTableName);
  const appleAccount:AppleAccountRepository={
    signInOrCreate:value=>signIn.signInOrCreate(value),
    linkGuest:value=>link.linkGuest(value),
    resolveLinkConflict:input.resolveLinkConflict??(async()=>{throw new AccountLinkReconciliationNotConfiguredError("account-link reconciliation is not configured");}),
  };
  return{
    guestPlayer:new DynamoDbGuestPlayerRepository(client,configuration.playerTableName,undefined,86_400,configuration.guestStartingBalance),
    account:new DynamoDbAccountRepository(client,configuration.playerTableName),
    appleAccount,
    save:new DynamoDbSaveRepository(client,configuration.playerTableName),
    offlineSync:new DynamoDbOfflineSyncRepository(client,configuration.playerTableName),
    economy:new DynamoDbEconomyRepository(client,configuration.playerTableName),
  };
}
