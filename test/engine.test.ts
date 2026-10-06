import test from "node:test";
import assert from "node:assert/strict";
import { agentEnv, extractResultText } from "../src/engine.ts";

test("agent env never inherits GITLAB_TOKEN or other secrets", () => {
  const env = agentEnv({ PATH: "/bin", HOME: "/h", GITLAB_TOKEN: "secret", ANTHROPIC_API_KEY: "k", AWS_SECRET: "s" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
});

test("extractResultText", () => {
  assert.equal(extractResultText('{"type":"result","is_error":false,"result":"hi"}'), "hi");
  assert.throws(() => extractResultText('{"type":"result","is_error":true,"result":"boom"}'));
  assert.throws(() => extractResultText("garbage"));
});
