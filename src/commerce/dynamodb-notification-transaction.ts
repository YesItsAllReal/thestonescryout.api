import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { CommerceNotificationResult, CommerceRepository, StoreEnvironment } from "./commerce-service.js";
import type { Entitlement } from "../economy/entitlement-service.js";

type NotificationOperation = Parameters<CommerceRepository["processNotificationAtomically"]>[0];

export interface StoredPurchaseForNotification {
  readonly playerId: string;
  readonly transactionId: string;
  readonly productId: string;
  readonly productKind: "consumable" | "nonConsumable";
  readonly environment: StoreEnvironment;
  readonly state: "granted" | "refunded" | "revoked";
  readonly stateEffectiveAt: string;
}

export interface StoredEntitlementForNotification extends Entitlement {
  readonly stateEffectiveAt: string;
}

export function buildKnownNotificationTransaction(input: {
  readonly tableName: string;
  readonly operation: NotificationOperation;
  readonly transaction: StoredPurchaseForNotification;
  readonly entitlement?: StoredEntitlementForNotification | undefined;
}): { readonly command: TransactWriteCommand; readonly result: CommerceNotificationResult } {
  validateBase(input.tableName, input.operation);
  const { notification, now } = input.operation;
  const targetState = notification.notificationType === "REFUND" ? "refunded" : "revoked";
  if (input.transaction.transactionId !== notification.transactionId || input.transaction.productId !== notification.productId ||
      input.transaction.environment !== notification.environment || !isUuid(input.transaction.playerId) ||
      !states.has(input.transaction.state) || !instant(input.transaction.stateEffectiveAt) ||
      Date.parse(notification.effectiveAt) <= Date.parse(input.transaction.stateEffectiveAt)) {
    throw new Error("notification transaction does not match verified event ordering");
  }
  if (input.transaction.productKind === "nonConsumable" && input.entitlement === undefined) {
    throw new Error("non-consumable notification is missing its entitlement");
  }
  if (input.transaction.productKind === "consumable" && input.entitlement !== undefined) {
    throw new Error("consumable notification cannot update an entitlement");
  }
  const entitlement = input.entitlement === undefined ? undefined : validateEntitlement(input.entitlement, input.transaction, targetState);
  const result: CommerceNotificationResult = {
    status: "applied", transactionState: targetState,
    ...(entitlement === undefined ? {} : { entitlement }),
  };
  const updatedAt = now.toISOString();
  const transactionKey = `TRANSACTION#${notification.environment}#${notification.transactionId}`;
  const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [{
    Update: {
      TableName: input.tableName, Key: { pk: transactionKey, sk: "GRANT" },
      UpdateExpression: "SET #state = :nextState, stateEffectiveAt = :effectiveAt, updatedAt = :updatedAt",
      ConditionExpression: "entityType = :entityType AND recordVersion = :recordVersion AND playerId = :playerId AND transactionId = :transactionId AND productId = :productId AND environment = :environment AND productKind = :productKind AND #state = :currentState AND stateEffectiveAt = :currentEffectiveAt",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: {
        ":entityType": "PurchaseTransaction", ":recordVersion": 1,
        ":playerId": input.transaction.playerId, ":transactionId": notification.transactionId,
        ":productId": notification.productId, ":environment": notification.environment,
        ":productKind": input.transaction.productKind, ":currentState": input.transaction.state,
        ":currentEffectiveAt": input.transaction.stateEffectiveAt,
        ":nextState": targetState, ":effectiveAt": notification.effectiveAt, ":updatedAt": updatedAt,
      },
    },
  }];
  if (entitlement !== undefined) items.push({ Update: {
    TableName: input.tableName,
    Key: { pk: `PLAYER#${input.transaction.playerId}`, sk: `ENTITLEMENT#${notification.productId}` },
    UpdateExpression: "SET #state = :nextState, stateEffectiveAt = :effectiveAt, updatedAt = :updatedAt",
    ConditionExpression: "entityType = :entityType AND recordVersion = :recordVersion AND playerId = :playerId AND productId = :productId AND environment = :environment AND purchasedAt = :purchasedAt AND #state = :currentState AND stateEffectiveAt = :currentEffectiveAt",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: {
      ":entityType": "Entitlement", ":recordVersion": 1, ":playerId": input.transaction.playerId,
      ":productId": entitlement.productId, ":environment": entitlement.environment,
      ":purchasedAt": entitlement.purchasedAt, ":currentState": input.entitlement!.state,
      ":currentEffectiveAt": input.entitlement!.stateEffectiveAt,
      ":nextState": targetState, ":effectiveAt": notification.effectiveAt, ":updatedAt": updatedAt,
    },
  } });
  items.push(notificationReceipt(input.tableName, input.operation, result));
  return { command: new TransactWriteCommand({ TransactItems: items }), result };
}

export function buildIgnoredNotificationTransaction(input: {
  readonly tableName: string;
  readonly operation: NotificationOperation;
}): { readonly command: TransactWriteCommand; readonly result: CommerceNotificationResult } {
  validateBase(input.tableName, input.operation);
  const transactionState = input.operation.notification.notificationType === "REFUND" ? "refunded" : "revoked";
  const result: CommerceNotificationResult = { status: "ignored", transactionState };
  return { command: new TransactWriteCommand({ TransactItems: [notificationReceipt(input.tableName, input.operation, result)] }), result };
}

function notificationReceipt(tableName: string, operation: NotificationOperation, result: CommerceNotificationResult) {
  const { notification, now } = operation;
  return { Put: { TableName: tableName, Item: {
    pk: `NOTIFICATION#${notification.environment}#${notification.notificationId}`, sk: "RESULT",
    entityType: "AppStoreNotification", recordVersion: 1,
    notificationId: notification.notificationId, notificationType: notification.notificationType,
    transactionId: notification.transactionId, productId: notification.productId,
    environment: notification.environment, effectiveAt: notification.effectiveAt,
    result, status: "completed", createdAt: now.toISOString(),
  }, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } };
}

function validateEntitlement(value: StoredEntitlementForNotification, transaction: StoredPurchaseForNotification, state: "refunded" | "revoked"): Entitlement {
  if (value.productId !== transaction.productId || value.environment !== transaction.environment ||
      !instant(value.purchasedAt) || !instant(value.stateEffectiveAt) ||
      value.stateEffectiveAt !== transaction.stateEffectiveAt ||
      !entitlementStates.has(value.state)) throw new Error("stored notification entitlement is invalid");
  return { productId: value.productId, state, purchasedAt: value.purchasedAt, environment: value.environment };
}
function validateBase(tableName: string, operation: NotificationOperation): void {
  const value = operation.notification;
  if (tableName.trim() === "" || !Number.isFinite(operation.now.getTime()) ||
      (value.notificationType !== "REFUND" && value.notificationType !== "REVOKE") ||
      (value.environment !== "sandbox" && value.environment !== "production") ||
      !safe(value.notificationId, 255) || !safe(value.transactionId, 255) || !safe(value.productId, 255) ||
      !instant(value.effectiveAt)) throw new Error("notification input is invalid");
}
const states = new Set(["granted", "refunded", "revoked"]);
const entitlementStates = new Set(["active", "refunded", "revoked"]);
function safe(value: string, max: number): boolean { return value.length >= 1 && value.length <= max && /^[A-Za-z0-9._:-]+$/.test(value); }
function instant(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
