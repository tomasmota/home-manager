import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const provider = join(process.env.PASEO_TEST_RUNTIME,
    "node_modules/@getpaseo/server/dist/server/server/agent/providers/omp");
const { OmpBtwBridge } = await import(pathToFileURL(join(provider, "btw.js")));
const { OmpAgentSession } = await import(pathToFileURL(join(provider, "agent.js")));
const record = overrides => ({
    id: "topic-one", question: "Explain the current approach", answer: "",
    status: "running", createdAt: 1, updatedAt: 1, ...overrides,
});

function bridge() {
    const items = [];
    const runtime = { request: async () => { throw new Error("Unexpected request"); } };
    return { items, runtime, btw: new OmpBtwBridge(runtime, item => items.push(item)) };
}

test("streamed answers update one side card without altering prior snapshots", () => {
    const { btw, items } = bridge();
    btw.handleEvent({ type: "btw_record", record: record({}) });
    btw.handleEvent({ type: "btw_delta", recordId: "topic-one", delta: "First " });
    btw.handleEvent({ type: "btw_delta", recordId: "topic-one", delta: "answer" });
    assert.equal(items[0].detail.text, "Topic: topic-one");
    assert.equal(items[1].detail.text, "Topic: topic-one\n\nFirst ");
    assert.equal(items[2].detail.text, "Topic: topic-one\n\nFirst answer");
    assert.deepEqual(items.map(item => item.callId), Array(3).fill("omp-btw:topic-one:0"));
    btw.handleEvent({ type: "btw_record", record: record({ answer: "First answer", status: "complete" }) });
    assert.equal(items.at(-1).status, "completed");
    btw.handleEvent({ type: "btw_delta", recordId: "topic-one", delta: "late" });
    assert.equal(items.length, 4);
});

test("follow-ups keep the original answer and use a distinct card", async () => {
    const { btw, items, runtime } = bridge();
    const topic = record({ answer: "Original", status: "complete", followUps: [{
        question: "Why?", answer: "Because", status: "running", createdAt: 2, updatedAt: 2,
    }] });
    btw.handleEvent({ type: "btw_record", record: topic });
    btw.handleEvent({ type: "btw_delta", recordId: topic.id, delta: " it is isolated" });
    assert.equal(items.at(-1).callId, "omp-btw:topic-one:1");
    assert.equal(items.at(-1).detail.text, "Topic: topic-one\n\nBecause it is isolated");
    runtime.request = async () => ({ records: [topic] });
    const history = await btw.history();
    assert.equal(history[0].detail.text, "Topic: topic-one\n\nOriginal");
    assert.equal(history[0].status, "completed");
    assert.equal(history[1].callId, "omp-btw:topic-one:1");
});

test("cancellation and errors preserve partial answers and terminal status", () => {
    const { btw, items } = bridge();
    btw.handleEvent({ type: "btw_record", record: record({ answer: "Partial", status: "cancelled" }) });
    assert.equal(items.at(-1).status, "canceled");
    assert.equal(items.at(-1).detail.text, "Topic: topic-one\n\nPartial\n\n[cancelled]");
    btw.handleEvent({ type: "btw_record", record: record({ answer: "Partial", status: "error", error: "Provider failed" }) });
    assert.equal(items.at(-1).status, "failed");
    assert.equal(items.at(-1).error, "Provider failed");
    assert.equal(items.at(-1).detail.text, "Topic: topic-one\n\nPartial\n\nProvider failed");
});

test("side frames leave a running foreground turn untouched", () => {
    const { btw, items } = bridge();
    const session = Object.create(OmpAgentSession.prototype);
    Object.assign(session, { btw, activeTurnId: "main-turn", activeAssistantMessageId: "main-message" });
    session.handleExtraRuntimeEvent({ type: "btw_record", record: record({}) });
    session.handleExtraRuntimeEvent({ type: "btw_delta", recordId: "topic-one", delta: "Side answer" });
    assert.equal(session.activeTurnId, "main-turn");
    assert.equal(session.activeAssistantMessageId, "main-message");
    assert.equal(items.at(-1).type, "tool_call");
    assert.equal(items.at(-1).detail.text, "Topic: topic-one\n\nSide answer");
});

test("invalid BTW options fail instead of asking an unintended side question", async () => {
    const { btw } = bridge();
    await assert.rejects(btw.command("--continue topic-one").run({ emit() {} }), /Usage:/);
    await assert.rejects(btw.command("--unknown").run({ emit() {} }), /Usage:/);
});
