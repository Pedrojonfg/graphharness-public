// Test doubles shared by the tests (not exported from index).
import { EventEmitter } from "node:events";
import type { ChildLike } from "./types.ts";

export interface FakeChild extends ChildLike {
  stdinData: string;
  killed: boolean;
  /** Ends the process by emitting stdout and the exit code. */
  finish(stdout: string, code?: number, stderr?: string): void;
}

export function fakeChild(): FakeChild {
  const out = new EventEmitter();
  const err = new EventEmitter();
  const ev = new EventEmitter();
  const child: FakeChild = {
    stdinData: "",
    killed: false,
    stdin: {
      write(chunk: string) {
        child.stdinData += chunk;
        return true;
      },
      end() {
        return undefined;
      },
    },
    stdout: { on: (e, cb) => out.on(e, cb) },
    stderr: { on: (e, cb) => err.on(e, cb) },
    on: ((e: string, cb: (...a: any[]) => void) => ev.on(e, cb)) as ChildLike["on"],
    kill() {
      child.killed = true;
      queueMicrotask(() => ev.emit("close", null));
      return true;
    },
    finish(stdout, code = 0, stderr = "") {
      out.emit("data", Buffer.from(stdout));
      if (stderr) err.emit("data", Buffer.from(stderr));
      ev.emit("close", code);
    },
  };
  return child;
}

export function cliOutput(result: string, usage: { input_tokens: number; output_tokens: number } | null = { input_tokens: 11, output_tokens: 7 }, isError = false): string {
  return JSON.stringify({ type: "result", subtype: isError ? "error" : "success", is_error: isError, result, ...(usage ? { usage } : {}) });
}

export function chatResponse(content: string, usage: { prompt_tokens: number; completion_tokens: number } | null = { prompt_tokens: 5, completion_tokens: 3 }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], ...(usage ? { usage } : {}) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
