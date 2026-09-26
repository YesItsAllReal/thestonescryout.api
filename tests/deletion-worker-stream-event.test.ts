import assert from "node:assert/strict";
import test from "node:test";
import { readDeletionJobStreamRecords } from "../src/accounts/deletion-worker-stream-event.js";

const playerId = "55555555-5555-4555-8555-555555555555";

test("deletion stream parser accepts only the typed new-image fields needed by the worker", () => {
  const records = readDeletionJobStreamRecords({ Records: [{
    eventID: "event-1",
    dynamodb: { SequenceNumber: "123456789", NewImage: {
      entityType: { S: "DeletionJob" }, playerId: { S: playerId }, state: { S: "requested" },
      providerMappingPk: { S: "sensitive-internal-value" },
    } },
  }] });
  assert.deepEqual(records, [{ itemIdentifier: "123456789", playerId, state: "requested" }]);
  assert.equal(JSON.stringify(records).includes("sensitive-internal-value"), false);
});

test("deletion stream parser acknowledges an expired completion marker removal without reprocessing it", () => {
  const records = readDeletionJobStreamRecords({ Records: [{
    eventID: "event-1",
    eventName: "REMOVE",
    dynamodb: {
      SequenceNumber: "123456790",
      Keys: { pk: { S: `DELETION#${playerId}` }, sk: { S: "REQUEST" } },
    },
  }] });
  assert.deepEqual(records, [{ itemIdentifier: "123456790", playerId, state: "removed" }]);
});

test("deletion stream parser rejects unrelated or malformed removal records", () => {
  for (const dynamodb of [
    { SequenceNumber: "1", Keys: { pk: { S: `PLAYER#${playerId}` }, sk: { S: "REQUEST" } } },
    { SequenceNumber: "1", Keys: { pk: { S: `DELETION#${playerId}` }, sk: { S: "OTHER" } } },
    { SequenceNumber: "1", Keys: { pk: { S: "DELETION#not-a-player" }, sk: { S: "REQUEST" } } },
    { SequenceNumber: "1" },
  ]) assert.throws(() => readDeletionJobStreamRecords({ Records: [{ eventName: "REMOVE", dynamodb }] }));
});

test("deletion stream parser fails closed on malformed or unrelated records", () => {
  for (const event of [
    {},
    { Records: [null] },
    { Records: [{ eventID: "event-1", dynamodb: { SequenceNumber: "1", NewImage: { entityType: { S: "Player" }, playerId: { S: playerId }, state: { S: "requested" } } } }] },
    { Records: [{ eventID: "event-1", dynamodb: { SequenceNumber: "1", NewImage: { entityType: { S: "DeletionJob" }, state: { S: "requested" } } } }] },
    { Records: [{ eventID: "event-1", dynamodb: { NewImage: { entityType: { S: "DeletionJob" }, playerId: { S: playerId }, state: { S: "requested" } } } }] },
  ]) assert.throws(() => readDeletionJobStreamRecords(event));
});
