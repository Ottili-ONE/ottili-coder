import {
  AgentTurnEngine,
  OpenAiCompatibleTurnProvider,
  ProviderFailure,
  ScriptedProvider,
  ToolRegistry,
  createControlledTool,
  createWorkspaceTools,
  resolveCommandTarget,
  retryDelayMs,
} from "@ottili/runtime";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirectory } from "../support/fs-cleanup.js";

import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await removeTempDirectory(directory)),
  );
});

describe("AgentTurnEngine", () => {
  it("continues after tool calls and preserves tool identity", async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [{ id: "call-1", input: { value: "x" }, name: "echo" }],
        type: "tool_calls",
      },
      {
        text: "completed",
        type: "text",
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    ]);
    const tools = new ToolRegistry();
    tools.register(
      createControlledTool({
        execute: async ({ value }) => `echo:${String(value)}`,
        name: "echo",
      }),
    );

    const result = await new AgentTurnEngine(provider, tools).run({
      messages: [{ content: "perform work", role: "user" }],
      model: "test-model",
    });

    expect(result.messages.at(-1)).toEqual({
      content: "completed",
      role: "assistant",
    });
    expect(result.toolExecutions).toEqual([
      {
        call: { id: "call-1", input: { value: "x" }, name: "echo" },
        result: { output: "echo:x" },
        status: "succeeded",
      },
    ]);
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  });

  it("classifies scripted failures and bounds retry delay", async () => {
    const provider = new ScriptedProvider([
      {
        failure: new ProviderFailure("rate_limited", "slow down", 123),
        type: "failure",
      },
    ]);
    await expect(
      new AgentTurnEngine(provider, new ToolRegistry()).run({
        messages: [],
        model: "test",
      }),
    ).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(retryDelayMs(20)).toBe(30_000);
    expect(retryDelayMs(1, 123)).toBe(123);
  });
});

describe("OpenAI-compatible provider", () => {
  it("normalizes function calls and classifies provider errors", async () => {
    const provider = new OpenAiCompatibleTurnProvider({
      endpoint: "https://provider.example/v1",
      fetch: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"path":"src/a.ts"}',
                        name: "edit_file",
                      },
                      id: "provider-call",
                    },
                  ],
                },
              },
            ],
            usage: { completion_tokens: 3, prompt_tokens: 5 },
          }),
          { status: 200 },
        ),
    });
    await expect(
      provider.complete({
        messages: [],
        model: "model",
        tools: [{ description: "Edit", name: "edit_file" }],
      }),
    ).resolves.toEqual({
      toolCalls: [
        { id: "provider-call", input: { path: "src/a.ts" }, name: "edit_file" },
      ],
      usage: { inputTokens: 5, outputTokens: 3 },
    });

    const limited = new OpenAiCompatibleTurnProvider({
      endpoint: "https://provider.example/v1",
      fetch: async () =>
        new Response("rate limited", {
          headers: { "retry-after": "2" },
          status: 429,
        }),
    });
    await expect(
      limited.complete({ messages: [], model: "model", tools: [] }),
    ).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 2_000,
    });
  });
});

describe("workspace tools", () => {
  it("does not spawn a process command when its turn was already aborted", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ottili-runtime-tools-"));
    directories.push(workspace);
    const controller = new AbortController();
    controller.abort("Run was cancelled before process dispatch.");
    const command = process.execPath;
    const tools = createWorkspaceTools({
      allowedCommands: [command],
      workspace,
    });

    await expect(
      tools
        .get("execute_command")
        ?.execute(
          { args: ["-e", "process.exit(0)"], command },
          controller.signal,
        ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("writes atomically below the workspace, reads it, and refuses .git access", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ottili-runtime-tools-"));
    directories.push(workspace);
    await writeFile(join(workspace, "existing.txt"), "before");
    const tools = createWorkspaceTools({ workspace });
    await expect(
      tools
        .get("write_file")
        ?.execute({ content: "after", path: "existing.txt" }),
    ).resolves.toMatchObject({ output: expect.stringContaining("Wrote") });
    await expect(
      readFile(join(workspace, "existing.txt"), "utf8"),
    ).resolves.toBe("after");
    await expect(
      tools.get("read_file")?.execute({ path: ".git/config" }),
    ).rejects.toThrow(".git");
  });
});

describe("cross-platform command targets", () => {
  const windowsPath = "C:\\tools;C:\\tools\\node";

  it("executes directly and without a shell on POSIX hosts", async () => {
    await expect(
      resolveCommandTarget("npm", ["test"], { platform: "linux" }),
    ).resolves.toEqual({ args: ["test"], executable: "npm" });
  });

  it("resolves a Windows command through PATHEXT before spawning", async () => {
    await expect(
      resolveCommandTarget("node", ["--version"], {
        path: windowsPath,
        pathExtensions: ".EXE;.CMD",
        platform: "win32",
        probe: async (candidate) => candidate === "C:\\tools\\node\\node.EXE",
      }),
    ).resolves.toEqual({
      args: ["--version"],
      executable: "C:\\tools\\node\\node.EXE",
    });
  });

  // Node refuses to spawn .cmd/.bat without a shell, so a Windows `npm` has to
  // be routed through cmd.exe explicitly rather than silently failing.
  it("routes a Windows batch command through cmd.exe with quoted argv", async () => {
    await expect(
      resolveCommandTarget("npm", ["run", "test --workspace app"], {
        comspec: "C:\\Windows\\system32\\cmd.exe",
        path: windowsPath,
        pathExtensions: ".EXE;.CMD",
        platform: "win32",
        probe: async (candidate) => candidate === "C:\\tools\\npm.CMD",
      }),
    ).resolves.toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        '"C:\\tools\\npm.CMD run "test --workspace app""',
      ],
      executable: "C:\\Windows\\system32\\cmd.exe",
      windowsVerbatimArguments: true,
    });
  });

  it("refuses to hand cmd.exe an argument it would reinterpret", async () => {
    await expect(
      resolveCommandTarget("npm", ["run", "test & shutdown"], {
        path: windowsPath,
        pathExtensions: ".CMD",
        platform: "win32",
        probe: async (candidate) => candidate === "C:\\tools\\npm.CMD",
      }),
    ).rejects.toThrow(/cmd\.exe metacharacter/u);
  });
});
