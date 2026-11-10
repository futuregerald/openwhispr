const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");

function handlersWithParticipants(participants) {
  const h = Object.create(IPCHandlers.prototype);
  Object.assign(h, {
    databaseManager: {
      getNote: () => ({
        id: 5,
        participants: participants == null ? null : JSON.stringify(participants),
      }),
      getGoogleAccounts: () => [{ email: "me@example.com" }],
    },
  });
  return h;
}

const expectation = (h, noteId = 5) =>
  h._resolveSpeakerExpectation({ sessionConfig: null, noteId, observedSpeakerIds: new Set() });

test("three other participants cap the system-track speakers at four", () => {
  const h = handlersWithParticipants([
    { displayName: "Me", email: "me@example.com" },
    { displayName: "Self", self: true },
    { displayName: "A" },
    { displayName: "B" },
    { displayName: "C" },
  ]);
  assert.deepEqual(expectation(h), { numSpeakers: -1, cap: 4 });
});

test("one other participant caps at two, leaving room for a stray voice", () => {
  const h = handlersWithParticipants([{ displayName: "A" }]);
  assert.deepEqual(expectation(h), { numSpeakers: -1, cap: 2 });
});

test("no participants means no cap", () => {
  assert.deepEqual(expectation(handlersWithParticipants(null)), { numSpeakers: -1, cap: null });
  assert.deepEqual(expectation(handlersWithParticipants([])), { numSpeakers: -1, cap: null });
});

test("only self participants means no cap", () => {
  const h = handlersWithParticipants([{ displayName: "Me", self: true }]);
  assert.deepEqual(expectation(h), { numSpeakers: -1, cap: null });
});

test("no note means no cap", () => {
  assert.deepEqual(expectation(handlersWithParticipants([{ displayName: "A" }]), null), {
    numSpeakers: -1,
    cap: null,
  });
});
