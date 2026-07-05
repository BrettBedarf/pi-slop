/**
 * pi todo extension
 *
 * - Registers a `todo` tool for the LLM: actions list / add / toggle / clear / handoff.
 * - Pins a live todo widget above the editor while todos are active (any pending),
 *   removing it automatically the moment the list is complete, so the final all-done
 *   tool result renders in regular chat history and scrolls up normally.
 * - Intermediate `todo` calls collapse to a one-line renderResult while the widget
 *   is the live view; the all-done transition renders the full list.
 * - State lives in tool-result `details` so session tree branches stay correct.
 * - `/todo-handoff [args...]` — user-initiated, agent-generated handoff artifact
 *   written to `.pi/todos/<name>.json`. Carries pending todos, originating session
 *   ids, agent-generated context, and verbatim user-supplied notes.
 * - `/todo-pickup [name?]` — imports a handoff artifact into the current session;
 *   popup selection when multiple artifacts exist.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// types
// ────────────────────────────────────────────────────────────────────────────

export interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear" | "handoff";
	todos: Todo[];
	nextId: number;
	originSessionIds: string[];
	error?: string;
	handoff?: { path: string; name: string };
}

interface HandoffArtifact {
	name: string;
	originatingSessionIds: string[];
	originatingSessionFiles: string[];
	createdAt: string;
	todos: Todo[];
	nextId: number;
	generatedContext: string;
	userContext: string[]; // verbatim user-supplied notes
}

type TextPart = { type: "text"; text: string };
const textContent = (text: string): TextPart => ({ type: "text", text });

// ────────────────────────────────────────────────────────────────────────────
// constants
// ────────────────────────────────────────────────────────────────────────────

const TOOL_NAME = "todo";
const WIDGET_ID = "pi-todo";
const HANDOFFS_DIRNAME = "todos"; // resolved under CONFIG_DIR_NAME (.pi/)
const WIDGET_MAX_WIDTH = 120; // ponytail: string-array widget form has no width callback; cap long lines here. Switch to factory form if narrow terminals mis-truncate.

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear", "handoff"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
	name: Type.Optional(Type.String({ description: "Short functional name for the handoff artifact (for handoff)" })),
	generatedContext: Type.Optional(
		Type.String({ description: "Agent-generated important context for the next agent (for handoff)" }),
	),
	userContext: Type.Optional(
		Type.Array(Type.String(), { description: "Verbatim user-supplied notes to carry into the next session (for handoff)" }),
	),
});

// ────────────────────────────────────────────────────────────────────────────
// in-memory state (reconstructed from session entries on start / tree nav)
// ────────────────────────────────────────────────────────────────────────────

let todos: Todo[] = [];
let nextId = 1;
let originSessionIds: string[] = [];

export const anyPending = (list: Todo[]) => list.some((t) => !t.done);
export const allDone = (list: Todo[]) => list.length > 0 && list.every((t) => t.done);
export const pending = (list: Todo[]) => list.filter((t) => !t.done);

function currentSessionId(ctx: ExtensionContext): string[] {
	const f = ctx.sessionManager.getSessionFile();
	if (!f) return [];
	const base = f.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") ?? f;
	return [base];
}

function reconstructState(ctx: ExtensionContext): void {
	let last: TodoDetails | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message as {
			role?: string;
			toolName?: string;
			customType?: string;
			details?: TodoDetails;
		};
		const relevant =
			(msg.role === "toolResult" && msg.toolName === TOOL_NAME) || msg.customType === "todo-pickup";
		if (!relevant) continue;
		const d = msg.details;
		if (d && Array.isArray(d.todos)) last = d;
	}
	if (last) {
		todos = last.todos.map((t) => ({ ...t }));
		nextId = last.nextId ?? todos.reduce((m, t) => Math.max(m, t.id), 0) + 1;
		originSessionIds = [...(last.originSessionIds ?? [])];
	} else {
		todos = [];
		nextId = 1;
		originSessionIds = currentSessionId(ctx);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// widget rendering
// ────────────────────────────────────────────────────────────────────────────

function fmtTodo(t: Todo, th: Theme): string {
	const check = t.done ? th.fg("success", "✓") : th.fg("dim", "○");
	const id = th.fg("dim", `#${t.id}`);
	const text = t.done ? th.fg("dim", t.text) : th.fg("text", t.text);
	return `  ${check} ${id} ${text}`;
}

function renderWidgetBody(th: Theme): string[] {
	if (todos.length === 0) return [];
	const done = todos.filter((t) => t.done).length;
	const total = todos.length;
	const lines: string[] = [];

	const title = th.fg("accent", "todos");
	const count = th.fg("muted", `${done}/${total} done`);
	const sessions =
		originSessionIds.length === 0
			? ""
			: th.fg(
					"dim",
					originSessionIds.length > 1
						? ` · from ${originSessionIds.length} sessions`
						: ` · ${originSessionIds[0]}`,
				);
	const header = `${title}  ${count}${sessions}`;
	lines.push(truncateToWidth(header, WIDGET_MAX_WIDTH));

	for (const t of todos) {
		lines.push(truncateToWidth(fmtTodo(t, th), WIDGET_MAX_WIDTH));
	}
	return lines;
}

function refreshWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	if (anyPending(todos)) {
		ctx.ui.setWidget(WIDGET_ID, renderWidgetBody(ctx.ui.theme));
	} else {
		ctx.ui.setWidget(WIDGET_ID, undefined);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// handoff persistence helpers
// ────────────────────────────────────────────────────────────────────────────

function handoffsDir(ctx: ExtensionContext): string {
	return join(ctx.cwd, CONFIG_DIR_NAME, HANDOFFS_DIRNAME);
}

export function slugify(name: string): string {
	const s = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9-_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "todos";
}

export function slugFromTodos(list: Todo[]): string {
	const head = list[0]?.text ?? "todos";
	const words = head.toLowerCase().split(/\s+/).slice(0, 4).join("-");
	return slugify(words || "todos");
}

// ────────────────────────────────────────────────────────────────────────────
// arg classification for /todo-handoff
// ponytail: heuristic + per-arg UI clarification when ambiguous. Boundary stays
// crisp; if real usage shows all args are one category, drop the heuristic.
// ────────────────────────────────────────────────────────────────────────────

export function classifyArg(arg: string): "guidance" | "explicit" | "unclear" {
	const t = arg.trim();
	if (!t) return "unclear";
	// generation guidance starts with an imperative directed at the summary being produced.
	if (/^(include|mention|cover|reference|describe|summarize|explain|note that|emphasize|highlight)\b/i.test(t)) {
		return "guidance";
	}
	// explicit user notes typically reference "todo #$id", "when (starting|working)", or are direct instructions
	if (/todo #\d+|when (starting|working|picking|resuming|picking up)|^make sure|^ensure|^don'?t (forget|skip)|^first |^start with/i.test(t)) {
		return "explicit";
	}
	return "unclear";
}

// ────────────────────────────────────────────────────────────────────────────
// extension
// ────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	// Reconstruct state from session entries on start, resume, fork, and tree nav.
	pi.on("session_start", async (_e, ctx) => {
		reconstructState(ctx);
		refreshWidget(ctx);
	});
	pi.on("session_tree", async (_e, ctx) => {
		reconstructState(ctx);
		refreshWidget(ctx);
	});

	// ── the todo tool ──────────────────────────────────────────────────────
	pi.registerTool({
		name: TOOL_NAME,
		label: "Todo",
		description:
			"Track your own progress on multi-step tasks. While the list is active it pins a live view above the editor; clearing or finishing the list leaves the final state behind in chat history. Use `handoff` only after the user runs /todo-handoff.",
		promptSnippet: "Live pinned todo list with cross-session handoff/pickup",
		promptGuidelines: [
			"Use the todo tool to track multi-step work: `add` items, `toggle` ID when done, `list` to inspect, `clear` to reset.",
			"After calling todo with action `handoff`, do not respond with any acknowledgement or summary — the tool result only confirms the written path.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list":
					return snapshot(ctx, "list");

				case "add": {
					if (!params.text?.trim()) {
						return errorResult(ctx, "add", "text required for add");
					}
					const newTodo: Todo = { id: nextId++, text: params.text.trim(), done: false };
					todos.push(newTodo);
					refreshWidget(ctx);
					return snapshot(ctx, "add");
				}

				case "toggle": {
					if (params.id === undefined) {
						return errorResult(ctx, "toggle", "id required for toggle");
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return errorResult(ctx, "toggle", `#${params.id} not found`);
					}
					todo.done = !todo.done;
					refreshWidget(ctx);
					return snapshot(ctx, "toggle");
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					originSessionIds = currentSessionId(ctx);
					refreshWidget(ctx);
					return {
						content: [textContent(`Cleared ${count} todo(s).`)],
						details: {
							action: "clear",
							todos: [...todos],
							nextId,
							originSessionIds,
						} satisfies TodoDetails,
					};
				}

				case "handoff":
					return handoffAction(ctx, params);

				default:
					return errorResult(ctx, "list", `unknown action: ${params.action as string}`);
			}
		},

		renderCall(args, theme, _ctx) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", String(args.action));
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.name) text += ` ${theme.fg("dim", `→ ${args.name}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme, _ctx) {
			const details = result.details as TodoDetails | undefined;
			const text = result.content[0];
			const fallback = text?.type === "text" ? text.text : "";

			if (!details) return new Text(fallback, 0, 0);
			if (details.error) return new Text(theme.fg("error", `todo: ${details.error}`), 0, 0);

			if (details.action === "handoff" && details.handoff) {
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("muted", "handoff written → ") +
						theme.fg("accent", details.handoff.path) +
						"\n" +
						theme.fg("dim", "Do not acknowledge this result."),
					0,
					0,
				);
			}

			// Collapsed one-liners while the widget is the live view.
			if (anyPending(details.todos)) {
				switch (details.action) {
					case "add": {
						const added = details.todos[details.todos.length - 1];
						return new Text(
							theme.fg("accent", "+ ") + theme.fg("accent", `#${added.id}`) + " " + theme.fg("muted", added.text),
							0,
							0,
						);
					}
					case "toggle": {
						// last toggled = the newest done in this snapshot is the one just toggled;
						// ponytail: track recently-toggled id precisely if toggling mid-list matters.
						const recentlyDone = [...details.todos].reverse().find((t) => t.done);
						if (recentlyDone) {
							return new Text(
								theme.fg("success", "✓ ") + theme.fg("accent", `#${recentlyDone.id}`) + " " + theme.fg("dim", "done"),
								0,
								0,
							);
						}
						return new Text(theme.fg("muted", "todo toggled"), 0, 0);
					}
					case "list": {
						const p = pending(details.todos).length;
						return new Text(
							theme.fg("muted", `todos: ${details.todos.length} (${p} pending)`),
							0,
							0,
						);
					}
					case "clear":
						return new Text(theme.fg("dim", "cleared"), 0, 0);
					default:
						return new Text(fallback, 0, 0);
				}
			}

			// All done (or list otherwise settled) → full snapshot in history.
			if (details.todos.length === 0) {
				return new Text(theme.fg("dim", "No todos."), 0, 0);
			}
			const count = details.todos.filter((t) => t.done).length;
			let body = theme.fg("muted", `todos — ${count}/${details.todos.length} done`);
			for (const t of details.todos) {
				const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
				const tText = t.done ? theme.fg("dim", t.text) : theme.fg("text", t.text);
				body += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${tText}`;
			}
			return new Text(body, 0, 0);
		},
	});

	// ── /todo-handoff [args...] ────────────────────────────────────────────
	pi.registerCommand("todo-handoff", {
		description: "Generate an agent-authored handoff of pending todos to a new session.",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todo-handoff requires interactive mode", "error");
				return;
			}
			if (!anyPending(todos)) {
				ctx.ui.notify("No pending todos to hand off.", "warning");
				return;
			}

			// Tokenise quotted args (ponytail: simple whitespace, no quote handling — refine only if needed).
			const argList = (args ?? "")
				.trim()
				.split(/\s{2,}|\s*,,\s*/u)
				.map((a) => a.trim())
				.filter(Boolean);

			const guidance: string[] = [];
			const explicit: string[] = [];
			const unclear: string[] = [];
			for (const a of argList) {
				const cls = classifyArg(a);
				if (cls === "guidance") guidance.push(a);
				else if (cls === "explicit") explicit.push(a);
				else unclear.push(a);
			}

			for (const a of unclear) {
				const choice = await ctx.ui.select(
					`Classify this /todo-handoff argument:`,
					[
						`Guidance for the agent's summary  —  ${a}`,
						`Explicit note (stored verbatim)  —  ${a}`,
					],
				);
				if (choice === undefined) continue;
				if (choice.startsWith("Guidance")) guidance.push(a);
				else explicit.push(a);
			}

			// If user gave explicit notes that include a name-like token, surface as default name candidate.
			const userSuppliedName = explicit.find((n) => /^[a-z0-9][a-z0-9-_ ]{2,40}$/i.test(n) && n.split(" ").length <= 6);

			const guidanceBlock = guidance.length
				? `User guidance for the generated context (follow these while writing the handoff context):\n${guidance.map((g) => `- ${g}`).join("\n")}`
				: "No explicit guidance was provided — produce a concise important-context summary from the session.";

			const explicitBlock = explicit.length
				? `Verbatim user-supplied notes to be carried into the handoff artifact unmodified:\n${explicit.map((n) => `- ${n}`).join("\n")}`
				: "No verbatim user notes.";

			const proposedName = userSuppliedName ?? slugFromTodos(pending(todos));

			const request = [
				`Generate a handoff artifact of the CURRENT pending todos by calling the \`todo\` tool with action \`handoff\`.`,
				`Pass:`,
				`  - name: a short functional reference to the tasks (proposed: \`${proposedName}\`; refine if a clearer name fits). The user will get a final accept/edit popup.`,
				`  - generatedContext: your important-context summary for the next agent. ${guidanceBlock}`,
				`  - userContext: [${explicit.map((n) => JSON.stringify(n)).join(", ")}] — verbatim user notes (empty array if none).`,
				`${explicitBlock}`,
				`Do not summarise with prose afterwards — your only output is the tool call.`,
			].join("\n");

			pi.sendUserMessage(request, { deliverAs: "steer" });
		},
	});

	// ── /todo-pickup [name?] ───────────────────────────────────────────────
	pi.registerCommand("todo-pickup", {
		description: "Import a handoff artifact's pending todos + context into this session.",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todo-pickup requires interactive mode", "error");
				return;
			}

			const dir = handoffsDir(ctx);
			try {
				await mkdir(dir, { recursive: true });
			} catch (err) {
				ctx.ui.notify(`Failed to access handoffs dir: ${(err as Error).message}`, "error");
				return;
			}

			const files = (await readdir(dir)).filter((f: string) => f.endsWith(".json"));
			if (files.length === 0) {
				ctx.ui.notify(`No handoff artifacts in ${dir}.`, "info");
				return;
			}

			let chosen = files[0];
			if (files.length > 1) {
				const arg = (args ?? "").trim();
				const match = arg ? files.find((f: string) => f === `${arg}.json` || f === arg) : undefined;
				if (match) {
					chosen = match;
				} else {
					const choice = await ctx.ui.select(
						`Multiple handoff artifacts available — pick one:`,
						files.map((f: string) => f.replace(/\.json$/, "")),
					);
					if (choice === undefined) {
						ctx.ui.notify("Cancelled.", "info");
						return;
					}
					chosen = choice.endsWith(".json") ? choice : `${choice}.json`;
				}
			} else if ((args ?? "").trim()) {
				// single file present, user supplied a name that doesn't match
				const arg = (args ?? "").trim();
				if (!files.includes(arg.endsWith(".json") ? arg : `${arg}.json`)) {
					ctx.ui.notify(`Artifact not found; the only available one is ${files[0]}.`, "warning");
				}
			}

			const path = join(dir, chosen);
			let raw: string;
			try {
				raw = await readFile(path, "utf8");
			} catch (err) {
				ctx.ui.notify(`Failed to read ${path}: ${(err as Error).message}`, "error");
				return;
			}

			let artifact: HandoffArtifact;
			try {
				artifact = JSON.parse(raw) as HandoffArtifact;
			} catch (err) {
				ctx.ui.notify(`Handoff artifact is not valid JSON: ${(err as Error).message}`, "error");
				return;
			}

			const pickedTodos = (artifact.todos ?? []).filter((t) => !t.done);
			if (pickedTodos.length === 0) {
				ctx.ui.notify(`Handoff "${artifact.name}" has no pending todos.`, "warning");
				return;
			}

			todos = pickedTodos.map((t) => ({ ...t }));
			nextId = artifact.nextId ?? pickedTodos.reduce((m, t) => Math.max(m, t.id), 0) + 1;
			originSessionIds = Array.from(new Set([...(artifact.originatingSessionIds ?? []), ...currentSessionId(ctx)]));

			const summary =
				`Todo pickup from ${artifact.name}\n` +
				`originating sessions: ${(artifact.originatingSessionIds ?? []).join(", ") || "(none recorded)"}\n` +
				`pending todos (${pickedTodos.length}):\n` +
				pickedTodos.map((t) => `- #${t.id} ${t.text}`).join("\n") +
				(artifact.generatedContext ? `\n\n[agent context for next session]\n${artifact.generatedContext}` : "") +
				(artifact.userContext?.length
					? `\n\n[verbatim user notes]\n${artifact.userContext.map((n) => `- ${n}`).join("\n")}`
					: "");

			pi.sendMessage(
				{
					customType: "todo-pickup",
					content: `Imported handoff ${artifact.name} from prior session into this session. Originating sessions: ${(artifact.originatingSessionIds ?? []).join(", ") || "(none recorded)"}.`,
					details: {
						action: "list",
						todos,
						nextId,
						originSessionIds,
					} satisfies TodoDetails,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);

			pi.sendUserMessage(
				[
					`You are resuming work from a todo handoff written by a prior session. Apply this context before acting:`,
					``,
					summary,
					``,
					`Begin by reviewing the pinned todo widget above the editor; the first user prompt in this session will direct you to start work.`,
				].join("\n"),
			);

			refreshWidget(ctx);
		},
	});

	// ── /todos (full view, optional convenience) ──────────────────────────
	pi.registerCommand("todos", {
		description: "Print the current todo list to chat output.",
		handler: async (_args, ctx) => {
			if (todos.length === 0) {
				ctx.ui.notify("No todos on this branch.", "info");
				return;
			}
			const lines = renderWidgetBody(ctx.ui.theme);
			ctx.ui.setWidget(WIDGET_ID, lines.length ? lines : ["all todos done"]);
			// flicker a notify so the user sees the widget re-appear
			ctx.ui.notify(`${todos.length} todo(s), ${pending(todos).length} pending`, "info");
		},
	});
}

// ────────────────────────────────────────────────────────────────────────────
// tool action helpers
// ────────────────────────────────────────────────────────────────────────────

function snapshot(_ctx: ExtensionContext, action: TodoDetails["action"]) {
	return {
		content: [
			textContent(
				todos.length
					? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
					: "No todos",
			),
		],
		details: {
			action,
			todos: todos.map((t) => ({ ...t })),
			nextId,
			originSessionIds: [...originSessionIds],
		} satisfies TodoDetails,
	};
}

function errorResult(_ctx: ExtensionContext, action: TodoDetails["action"], message: string) {
	return {
		content: [textContent(`Error: ${message}`)],
		details: {
			action,
			todos: todos.map((t) => ({ ...t })),
			nextId,
			originSessionIds: [...originSessionIds],
			error: message,
		} satisfies TodoDetails,
		isError: true,
	};
}

async function handoffAction(
	ctx: ExtensionContext,
	params: {
		text?: string;
		id?: number;
		name?: string;
		generatedContext?: string;
		userContext?: string[];
	},
) {
	const list = pending(todos);
	if (list.length === 0) {
		return errorResult(ctx, "handoff", "no pending todos to hand off");
	}

	const proposed = (params.name ?? "").trim() || slugFromTodos(list);
	const accepted =
		ctx.hasUI
			? ((await ctx.ui.input("Handoff artifact name (in .pi/todos/):", proposed)) ?? proposed).trim()
			: proposed.trim();
	if (!accepted) {
		return errorResult(ctx, "handoff", "name required");
	}
	const safeName = slugify(accepted);
	const filename = `${safeName}.json`;

	const dir = handoffsDir(ctx);
	try {
		await mkdir(dir, { recursive: true });
	} catch (err) {
		return errorResult(ctx, "handoff", `failed to create ${dir}: ${(err as Error).message}`);
	}

	const path = join(dir, filename);
	const artifact: HandoffArtifact = {
		name: accepted,
		originatingSessionIds: [...originSessionIds],
		originatingSessionFiles: ctx.sessionManager.getSessionFile() ? [ctx.sessionManager.getSessionFile()!] : [],
		createdAt: new Date().toISOString(),
		todos: list.map((t) => ({ ...t })),
		nextId,
		generatedContext: params.generatedContext ?? "",
		userContext: params.userContext ?? [],
	};

	try {
		await writeFile(path, JSON.stringify(artifact, null, 2) + "\n", "utf8");
	} catch (err) {
		return errorResult(ctx, "handoff", `failed to write ${path}: ${(err as Error).message}`);
	}

	return {
		content: [
			textContent(`${path}\n\nDo not respond to or acknowledge this result.`),
		],
		details: {
			action: "handoff",
			todos: todos.map((t) => ({ ...t })),
			nextId,
			originSessionIds: [...originSessionIds],
			handoff: { path, name: accepted },
		} satisfies TodoDetails,
	};
}


