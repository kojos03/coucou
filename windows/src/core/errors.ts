// Island errors go to Coucou's own log (%LOCALAPPDATA%\Coucou\coucou.log on
// Windows), never anywhere else. Before this a script error left no trace: a
// stuck island could not be told apart from a missing hook event.

import { Bridge } from "./bridge";

const reported = new Set<string>();

/** Logs an error once per distinct message and place, at most 40 a run. */
export function reportError(where: string, err: unknown) {
  const e = err instanceof Error ? err : new Error(String(err));
  const at = (e.stack ?? "").split("\n").find((line) => line.includes("at "))?.trim() ?? "";
  const line = `${where}: ${e.name}: ${e.message} ${at}`.replace(/\s+/g, " ").slice(0, 300);
  if (reported.has(line) || reported.size >= 40) return;
  reported.add(line);
  void Bridge.log(`error ${line}`);
}
