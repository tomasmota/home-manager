import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createTmuxTitleNamer, type TmuxTitleNamer } from "./tmux-title-core.js";

function messageText(message: AgentMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content.trim();
  return message.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
}

export function completedTurn(messages: readonly AgentMessage[]) {
  const userIndex = messages.findLastIndex(message => message.role === "user");
  if (userIndex < 0) return;
  const user = messages[userIndex];
  const assistant = messages.slice(userIndex + 1).findLast(message => message.role === "assistant");
  if (!assistant || assistant.role !== "assistant"
    || (assistant.stopReason !== "stop" && assistant.stopReason !== "length")) return;
  const request = messageText(user);
  const response = messageText(assistant);
  if (!request || !response) return;
  return { key: JSON.stringify([user.timestamp, assistant.timestamp, request, response]), request, response };
}

export default function tmuxTitle(
  pi: ExtensionAPI,
  deps: { namer?: TmuxTitleNamer } = {},
): void {
  if (!process.env.TMUX || !/^%\d+$/.test(process.env.TMUX_PANE ?? "")) return;
  const namer = deps.namer ?? createTmuxTitleNamer();
  let context: ExtensionContext | undefined;
  let timer: Timer | undefined;
  let revision = 0;
  let observedTitle: string | undefined;
  let lastCompleted: string | undefined;
  let work = Promise.resolve();

  const enqueue = (ctx: ExtensionContext, job: (shouldApply: () => boolean) => Promise<unknown>) => {
    const epoch = revision;
    const sessionID = ctx.sessionManager.getSessionId();
    const shouldApply = () => context !== undefined && revision === epoch
      && context.sessionManager.getSessionId() === sessionID;
    work = work.then(async () => {
      if (shouldApply()) await job(shouldApply);
    }).catch(() => ctx.ui.notify("tmux title update failed", "warning"));
  };

  const inspectTitle = () => {
    const ctx = context;
    if (!ctx) return;
    const title = ctx.sessionManager.getSessionName();
    if (title === observedTitle) return;
    observedTitle = title;
    revision++;
    if (!title?.trim()) return;
    const firstUser = ctx.sessionManager.getBranch()
      .flatMap(entry => entry.type === "message" ? [entry.message] : [])
      .find(message => message.role === "user");
    const request = firstUser ? messageText(firstUser) : "";
    const sessionID = ctx.sessionManager.getSessionId();
    enqueue(ctx, shouldApply => namer.rename({ sessionID, title, request, directory: ctx.cwd, shouldApply }));
  };

  const review = (ctx: ExtensionContext, transcript: readonly AgentMessage[]) => {
    const turn = completedTurn(transcript);
    if (!turn || turn.key === lastCompleted) return;
    lastCompleted = turn.key;
    const sessionID = ctx.sessionManager.getSessionId();
    enqueue(ctx, shouldApply => namer.review({ sessionID, ...turn, directory: ctx.cwd, shouldApply }));
  };

  const start = (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.agent.kind !== "main" || ctx.mode !== "tui") return;
    if (timer && context) context.clearTimer(timer);
    context = ctx;
    revision++;
    observedTitle = undefined;
    lastCompleted = undefined;
    inspectTitle();
    if (ctx.isIdle()) review(ctx, ctx.sessionManager.getBranch()
      .flatMap(entry => entry.type === "message" ? [entry.message] : []));
    // Title changes have no public extension event. No Jev calls on unchanged ticks.
    timer = ctx.setInterval(inspectTitle, 500);
  };

  pi.on("session_start", start);
  pi.on("session_switch", start);
  pi.on("session_branch", start);
  pi.on("session_tree", start);
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || !context) return;
    revision++;
    lastCompleted = undefined;
  });
  pi.on("agent_end", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !context || event.willContinue) return;
    context = ctx;
    inspectTitle();
    review(ctx, event.messages);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || !context) return;
    revision++;
    if (timer) context.clearTimer(timer);
    context = undefined;
    return work;
  });
}
