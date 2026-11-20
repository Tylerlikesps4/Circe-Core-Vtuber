import { spawn } from "node:child_process";

export interface ProcResult {
  ok: boolean;
  detail?: string;
}

/** Run a command to completion, capturing only its exit status. */
export function runProcess(cmd: string, args: string[], stdin?: string): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", (err) => {
      resolve({ ok: false, detail: err.message });
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, detail: code === 0 ? undefined : `exit ${code}` });
    });
    if (stdin !== undefined) child.stdin?.write(stdin);
    child.stdin?.end();
  });
}
