import { describe, expect, it } from "vitest";
import {
	allDone,
	anyPending,
	classifyArg,
	pending,
	slugFromTodos,
	slugify,
	type Todo,
} from "../src/index.js";

const todo = (id: number, text: string, done = false): Todo => ({ id, text, done });

describe("anyPending / allDone / pending", () => {
	it("anyPending: true iff some todo is not done", () => {
		expect(anyPending([])).toBe(false);
		expect(anyPending([todo(1, "a", true)])).toBe(false);
		expect(anyPending([todo(1, "a", true), todo(2, "b", false)])).toBe(true);
		expect(anyPending([todo(1, "a", false)])).toBe(true);
	});

	it("allDone: only true when non-empty and every item done", () => {
		expect(allDone([])).toBe(false);
		expect(allDone([todo(1, "a", true)])).toBe(true);
		expect(allDone([todo(1, "a", true), todo(2, "b", false)])).toBe(false);
	});

	it("pending: returns only not-done items, preserving order", () => {
		const list = [todo(1, "a", false), todo(2, "b", true), todo(3, "c", false)];
		expect(pending(list)).toEqual([todo(1, "a", false), todo(3, "c", false)]);
	});
});

describe("slugify", () => {
	it("lowercases, replaces non-[a-z0-9-_] with -, trims edge dashes", () => {
		expect(slugify("Write Tests!")).toBe("write-tests");
		expect(slugify("  multi   word  ")).toBe("multi-word");
		expect(slugify("foo_bar baz-qux")).toBe("foo_bar-baz-qux");
		expect(slugify("---edge---")).toBe("edge");
	});

	it("falls back to 'todos' when empty after normalization", () => {
		expect(slugify("")).toBe("todos");
		expect(slugify("!!!")).toBe("todos");
		expect(slugify("   ")).toBe("todos");
	});

	it("collapses runs of separators", () => {
		expect(slugify("a---b   c")).toBe("a-b-c");
	});
});

describe("slugFromTodos", () => {
	it("derives a slug from the first todo's text (up to 4 words)", () => {
		expect(slugFromTodos([todo(1, "Write integration tests for handoff")])).toBe("write-integration-tests-for");
		expect(slugFromTodos([todo(1, "short task")])).toBe("short-task");
	});

	it("falls back when first todo text is empty/whitespace", () => {
		expect(slugFromTodos([todo(1, "   ")])).toBe("todos");
		expect(slugFromTodos([])).toBe("todos");
	});

	it("uses only the first todo even when others exist", () => {
		const list = [todo(1, "First task here"), todo(2, "Second task here")];
		expect(slugFromTodos(list)).toBe("first-task-here");
	});
});

describe("classifyArg", () => {
	it("guidance: imperative verbs directed at the generated summary", () => {
		expect(classifyArg("include a section about our decision to do X")).toBe("guidance");
		expect(classifyArg("Mention the auth approach")).toBe("guidance");
		expect(classifyArg("Cover the failure modes")).toBe("guidance");
		expect(classifyArg("describe the data layout")).toBe("guidance");
		expect(classifyArg("summarize what's left")).toBe("guidance");
		expect(classifyArg("Emphasize that we skipped caching")).toBe("guidance");
		expect(classifyArg("highlight the open question")).toBe("guidance");
	});

	it("explicit: per-todo instructions, 'when starting', 'make sure', 'don't forget'", () => {
		expect(classifyArg("when starting todo #3 write tests first and pause for review")).toBe("explicit");
		expect(classifyArg("make sure the migration is reversible")).toBe("explicit");
		expect(classifyArg("ensure the typecheck passes before toggling done")).toBe("explicit");
		expect(classifyArg("don't forget to bump the package version")).toBe("explicit");
		expect(classifyArg("Don't skip the lint step")).toBe("explicit");
		expect(classifyArg("start with the test file")).toBe("explicit");
		expect(classifyArg("first add the schema")).toBe("explicit");
	});

	it("unclear: neutral or otherwise ambiguous text", () => {
		expect(classifyArg("auth")).toBe("unclear");
		expect(classifyArg("the caching decision")).toBe("unclear");
		expect(classifyArg("remember to be careful")).toBe("unclear");
		expect(classifyArg("")).toBe("unclear");
		expect(classifyArg("   ")).toBe("unclear");
	});

	it("explicit wins over guidance when a 'when … todo #n' clause also has an imperative", () => {
		// 'when starting todo #3 …' anchors this as a verbatim note rather than summary guidance.
		expect(classifyArg("when starting todo #3 include a section about X")).toBe("explicit");
	});
});