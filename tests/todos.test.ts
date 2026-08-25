import { describe, expect, it } from "vitest";
import { sortTodos, type TodoItem } from "../src/lib/todos.server";

const item = (over: Partial<TodoItem>): TodoItem => ({
  id: "x",
  title: "T",
  detail: "d",
  blocks: "b",
  owner: "you",
  ...over,
});

describe("sortTodos", () => {
  it("puts what the reader can finish at the top", () => {
    // A list opening with three items blocked on a third party reads as "nothing I can do",
    // and the thing that could have been cleared in a minute sits below the fold.
    const sorted = sortTodos([
      item({ id: "a", owner: "time", title: "Year on year" }),
      item({ id: "b", owner: "external", title: "API key" }),
      item({ id: "c", owner: "you", title: "Review queue" }),
      item({ id: "d", owner: "someone-else", title: "Tag links" }),
    ]);
    expect(sorted.map((t) => t.owner)).toEqual(["you", "someone-else", "external", "time"]);
  });

  it("orders alphabetically within a group so the list is stable between loads", () => {
    // The page recomputes on every render. Without a tiebreak, two items with the same owner
    // could swap places at random and the list would look like it changed when it hadn't.
    const sorted = sortTodos([
      item({ id: "1", owner: "you", title: "Zebra" }),
      item({ id: "2", owner: "you", title: "Apple" }),
    ]);
    expect(sorted.map((t) => t.title)).toEqual(["Apple", "Zebra"]);
  });

  it("does not mutate its input", () => {
    const input = [item({ id: "1", owner: "time" }), item({ id: "2", owner: "you" })];
    const before = input.map((i) => i.id);
    sortTodos(input);
    expect(input.map((i) => i.id)).toEqual(before);
  });

  it("handles an empty list", () => {
    expect(sortTodos([])).toEqual([]);
  });
});
