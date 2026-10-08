import { z } from "zod";

const turnShape = {
    question: z.string(),
    answer: z.string(),
    status: z.enum(["running", "complete", "cancelled", "error", "interrupted"]),
    createdAt: z.number(),
    updatedAt: z.number(),
    error: z.string().optional(),
};
export const BtwRecordSchema = z.object({
    ...turnShape,
    id: z.string(),
    followUps: z.array(z.object(turnShape)).optional(),
}).passthrough();
export const BTW_EVENT_SCHEMAS = [
    z.object({ type: z.literal("btw_record"), record: BtwRecordSchema }),
    z.object({ type: z.literal("btw_delta"), recordId: z.string(), delta: z.string() }),
];
export const BTW_COMMAND_SCHEMAS = [
    z.object({ type: z.literal("btw"), question: z.string(), recordId: z.string().optional() }),
    z.object({ type: z.literal("btw_cancel"), recordId: z.string().optional() }),
    z.object({ type: z.literal("get_btw_history") }),
];
export const BTW_SLASH_COMMAND = {
    name: "btw",
    description: "Ask a side question without interrupting the main task",
    argumentHint: "<question> | --history | --cancel | --continue <topic-id> <question>",
    kind: "command",
};

function turns(record) {
    return [record, ...(record.followUps ?? [])];
}
function timelineItem(record, index) {
    const turn = turns(record)[index];
    const status = turn.status === "running" ? "running"
        : turn.status === "error" ? "failed"
        : turn.status === "complete" ? "completed" : "canceled";
    return {
        type: "tool_call",
        callId: `omp-btw:${record.id}:${index}`,
        name: "btw",
        status,
        error: status === "failed" ? turn.error ?? "Side question failed" : null,
        detail: {
            type: "plain_text",
            label: `BTW · ${turn.question}`,
            text: [`Topic: ${record.id}`, turn.answer, turn.error,
                status === "canceled" ? `[${turn.status}]` : null].filter(Boolean).join("\n\n"),
            icon: "brain",
        },
    };
}

// The main session journal stays untouched. Omp owns execution and sidecar history;
// Paseo receives separate, updatable cards, never main-turn assistant messages.
export class OmpBtwBridge {
    constructor(runtimeSession, emit) {
        this.runtimeSession = runtimeSession;
        this.emit = emit;
        this.records = new Map();
    }
    handleEvent(event) {
        if (event.type === "btw_record") {
            this.records.set(event.record.id, event.record);
            this.emit(timelineItem(event.record, turns(event.record).length - 1));
            return true;
        }
        if (event.type !== "btw_delta") return false;
        const record = this.records.get(event.recordId);
        if (!record) return true;
        const index = turns(record).length - 1;
        const latest = turns(record)[index];
        if (latest.status !== "running") return true;
        const updated = { ...latest, answer: latest.answer + event.delta };
        const next = index === 0 ? { ...record, ...updated } : {
            ...record, followUps: [...record.followUps.slice(0, -1), updated],
        };
        this.records.set(record.id, next);
        this.emit(timelineItem(next, index));
        return true;
    }
    async history() {
        const result = await this.runtimeSession.request({ type: "get_btw_history" });
        const records = z.array(BtwRecordSchema).parse(result.records);
        return records.flatMap(record => turns(record).map((_, index) => ({
            createdAt: turns(record)[index].createdAt,
            item: timelineItem(record, index),
        }))).sort((a, b) => a.createdAt - b.createdAt).map(entry => entry.item);
    }
    command(args) {
        return { run: async ({ emit }) => {
            // Session subscribers inherit the foreground turn id. Use the manager's
            // out-of-band dispatcher so a side card keeps one identity across main-turn end.
            this.emit = item => emit({ type: "timeline", provider: "omp", item });
            const input = args?.trim() ?? "";
            if (!input || input === "--history") {
                const items = await this.history();
                for (const item of items) emit({ type: "timeline", provider: "omp", item });
                if (!items.length) emit({ type: "timeline", provider: "omp", item: {
                    type: "notification", level: "info", message: "No BTW topics yet. Use /btw <question>.",
                } });
                return;
            }
            if (input === "--cancel") {
                const result = await this.runtimeSession.request({ type: "btw_cancel" });
                if (!result.cancelled) emit({ type: "timeline", provider: "omp", item: {
                    type: "notification", level: "info", message: "No BTW question is running.",
                } });
                return;
            }
            const continuation = /^--continue\s+(\S+)\s+([\s\S]+)$/.exec(input);
            if (input.startsWith("--") && !continuation) {
                throw new Error("Usage: /btw <question> | --history | --cancel | --continue <topic-id> <question>");
            }
            await this.runtimeSession.request({
                type: "btw",
                question: continuation ? continuation[2] : input,
                ...(continuation ? { recordId: continuation[1] } : {}),
            });
        } };
    }
}
