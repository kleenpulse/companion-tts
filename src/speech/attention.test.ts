import { describe, expect, it } from "vitest";
import { attentionText, isPermissionMessage, toolAttentionText } from "./attention";

describe("attentionText", () => {
  it("phrases permission prompts by tool", () => {
    expect(attentionText("Claude needs your permission to use Bash")).toBe(
      "Claude needs your approval to run a command."
    );
    expect(attentionText("Claude needs your permission to use Edit")).toBe(
      "Claude needs your approval to edit a file."
    );
    expect(attentionText("Claude needs your permission to use WebSearch")).toBe(
      "Claude needs your approval to search the web."
    );
  });

  it("names the server for MCP tools", () => {
    expect(attentionText("Claude needs your permission to use mcp__figma__get_file")).toBe(
      "Claude needs your approval to use figma tools."
    );
  });

  it("falls back to the raw tool name", () => {
    expect(attentionText("Claude needs your permission to use SomeNewTool")).toBe(
      "Claude needs your approval to use SomeNewTool."
    );
  });

  it("speaks idle-input notifications directly", () => {
    expect(attentionText("Claude is waiting for your input")).toBe(
      "Claude is waiting for your input."
    );
  });

  it("passes unknown notifications through with a preamble", () => {
    expect(attentionText("Something unusual happened.")).toBe(
      "Claude needs your attention. Something unusual happened."
    );
  });
});

describe("isPermissionMessage", () => {
  it("detects permission prompts (grace window) vs idle notices (instant)", () => {
    expect(isPermissionMessage("Claude needs your permission to use Bash")).toBe(true);
    expect(isPermissionMessage("Claude is waiting for your input")).toBe(false);
  });
});

describe("toolAttentionText", () => {
  it("announces question and plan prompts, stays silent otherwise", () => {
    expect(toolAttentionText("AskUserQuestion")).toBe("Claude has a question for you.");
    expect(toolAttentionText("ExitPlanMode")).toBe(
      "Claude drafted a plan and awaits your approval."
    );
    expect(toolAttentionText("Bash")).toBeNull();
  });
});
