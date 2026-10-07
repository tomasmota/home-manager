import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createTmuxStatus, type TmuxStatus } from "./tmux-status-core.js";

export interface TmuxStatusDeps {
  createStatus?: typeof createTmuxStatus;
  env?: NodeJS.ProcessEnv;
}

export default function tmuxStatus(pi: ExtensionAPI, deps: TmuxStatusDeps = {}): void {
  const createStatus = deps.createStatus ?? createTmuxStatus;
  const env = deps.env ?? process.env;
  let status: TmuxStatus | undefined;
  let shutdown = false;
  // Tmux writes must land in event order. Controller methods return once their writes apply, never
  // after remote classification, so this chain cannot stall behind Jev.
  let writes: Promise<unknown> = Promise.resolve();

  // The main TUI session owns the pane. Subagent sessions rebind this extension and RPC/print modes
  // have no pane to report, so their events must never touch tmux state or the prompt timer.
  const dispatch = (
    ctx: ExtensionContext,
    job: (status: TmuxStatus) => Promise<unknown>,
    { create = false } = {},
  ) => {
    if (shutdown || !env.TMUX || !/^%\d+$/.test(env.TMUX_PANE ?? "")) return;
    if (ctx.agent.kind !== "main" || ctx.mode !== "tui") return;
    if (create) status ??= createStatus({ env });
    const current = status;
    if (!current) return;
    writes = writes.then(() => job(current)).catch(() => {
      try {
        ctx.ui.notify("tmux status update failed", "warning");
      } catch {}
    });
    return writes;
  };

  const lifecycle = (_event: unknown, ctx: ExtensionContext) => {
    const sessionID = ctx.sessionManager.getSessionId();
    const working = !ctx.isIdle();
    return dispatch(ctx, current => current.reset(sessionID, working), { create: true });
  };

  pi.on("session_start", lifecycle);
  pi.on("session_switch", lifecycle);
  pi.on("session_branch", lifecycle);
  pi.on("session_tree", lifecycle);
  pi.on("agent_start", (_event, ctx) => {
    const sessionID = ctx.sessionManager.getSessionId();
    return dispatch(ctx, current => current.start(sessionID));
  });
  pi.on("agent_end", (event, ctx) => {
    // willContinue means omp already scheduled an automatic retry/continuation; not a settle.
    if (event.willContinue) return;
    const messages: readonly AgentMessage[] = event.messages;
    return dispatch(ctx, current => current.finish(messages));
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "ask") return;
    return dispatch(ctx, current => current.wait(`ask:${event.toolCallId}`));
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "ask") return;
    return dispatch(ctx, current => current.resume(`ask:${event.toolCallId}`));
  });
  pi.on("tool_approval_requested", (event, ctx) =>
    dispatch(ctx, current => current.wait(`approval:${event.toolCallId}`)));
  pi.on("tool_approval_resolved", (event, ctx) =>
    dispatch(ctx, current => current.resume(`approval:${event.toolCallId}`)));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || ctx.mode !== "tui") return;
    const result = dispatch(ctx, current => current.dispose());
    // A shut-down session never reactivates; late events must not recreate the controller.
    shutdown = true;
    status = undefined;
    return result;
  });
}
