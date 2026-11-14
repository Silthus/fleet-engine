import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { ModelRow } from "../../base/lib/models.ts";
import { askModel, type Role } from "./proof-models.ts";

const row: ModelRow = { role: "review", work: "Review", provider: "claude", model: "review-model", effort: "high" };

test.each<[Role, string]>([["judge", "FLEET_PROOF_JUDGE"], ["reviewer", "FLEET_PROOF_REVIEWER"], ["arbiter", "FLEET_REVIEW_ARBITER"], ["eval-judge", "FLEET_PROOF_EVAL_JUDGE"]])(
  "a %s session starts without the lane's T3 thread id, and the lane keeps it",
  async (role, command) => {
    const env = { PATH: process.env.PATH, T3CODE_THREAD_ID: "mcp:lane", [command]: 'cat >/dev/null; echo "thread=${T3CODE_THREAD_ID:-none}"' };
    expect(await askModel(role, row, { prompt: "Judge it", cwd: tmpdir() }, env, 10_000)).toMatchObject({ ok: true, text: "thread=none" });
    expect(env.T3CODE_THREAD_ID).toBe("mcp:lane");
  },
);
