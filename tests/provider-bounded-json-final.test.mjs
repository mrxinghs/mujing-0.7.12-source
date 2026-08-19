import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const providers = require("../desktop/providers.cjs");

function responseFrom(chunks, { contentLength, failAt = -1 } = {}) {
  let reads = 0;
  let cancels = 0;
  let jsonCalls = 0;
  let index = 0;
  const all = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return {
    ok: true,
    status: 200,
    headers: new Headers(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
    body: {
      getReader() {
        return {
          async read() {
            reads += 1;
            if (index === failAt) throw new Error("simulated provider JSON interruption");
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() { cancels += 1; },
          releaseLock() {},
        };
      },
    },
    async json() { jsonCalls += 1; return JSON.parse(all.toString("utf8")); },
    observations() { return { reads, cancels, jsonCalls }; },
  };
}

const branches = [
  {
    name: "testConnection models",
    limit: () => providers.MAX_MODELS_JSON_BYTES,
    normal: { data: [{ id: "fake-model" }] },
    malformedShape: [],
    call: () => providers.testConnection({ apiKey: "fake" }),
  },
  {
    name: "createStoryboard response",
    limit: () => providers.MAX_STORYBOARD_JSON_BYTES,
    normal: { output_text: '[{"narration":"甲","duration":4,"visual":"蓝色画面","shotType":"中景","camera":"固定","imagePrompt":"蓝色","videoPrompt":"固定镜头"}]' },
    malformedShape: { output_text: "{}" },
    call: () => providers.createStoryboard({ apiKey: "fake" }, { ratio: "16:9", style: "test", characters: [], script: "甲" }),
  },
  {
    name: "createCharacterProfile response",
    limit: () => providers.MAX_STORYBOARD_JSON_BYTES,
    normal: { output_text: '{"description":"三十岁的记者，深色短发，固定藏蓝夹克。"}' },
    malformedShape: { output_text: '{"description":123}' },
    call: () => providers.createCharacterProfile({ apiKey: "fake" }, { name: "记者", style: "电影写实", script: "记者走进小镇。" }),
  },
  {
    name: "Seedance submit",
    limit: () => providers.MAX_VIDEO_TASK_JSON_BYTES,
    normal: { id: "seedance-job", status: "queued" },
    malformedShape: { id: { nested: true }, status: "queued" },
    call: () => providers.submitVideoTask({ apiKey: "fake", videoModel: "seedance-fake" }, { provider: "Seedance", prompt: "test", ratio: "16:9", duration: 4 }),
  },
  {
    name: "Seedance poll",
    limit: () => providers.MAX_VIDEO_TASK_JSON_BYTES,
    normal: { id: "seedance-job", status: "running" },
    malformedShape: { status: ["running"] },
    call: () => providers.pollVideoTask({ apiKey: "fake" }, { provider: "Seedance", jobId: "seedance-job" }, "not-used"),
  },
  {
    name: "OpenAI video poll",
    limit: () => providers.MAX_VIDEO_TASK_JSON_BYTES,
    normal: { id: "openai-job", status: "in_progress" },
    malformedShape: { status: { value: "in_progress" } },
    call: () => providers.pollVideoTask({ apiKey: "fake" }, { provider: "OpenAI Video", jobId: "openai-job" }, "not-used"),
  },
];

for (const branch of branches) {
  test(`${branch.name} uses only the bounded JSON reader for every response outcome`, async () => {
    const previousFetch = globalThis.fetch;
    try {
      const limit = branch.limit();
      assert.ok(Number.isSafeInteger(limit) && limit >= 1024 && limit <= 8 * 1024 * 1024, "branch must publish a small explicit limit");

      let response = responseFrom([Buffer.from(JSON.stringify(branch.normal))], { contentLength: limit + 1 });
      globalThis.fetch = async () => response;
      await assert.rejects(branch.call(), /Content-Length.*上限|JSON.*上限/);
      assert.deepEqual(response.observations(), { reads: 0, cancels: 1, jsonCalls: 0 });

      response = responseFrom([Buffer.alloc(limit), Buffer.from("x")]);
      globalThis.fetch = async () => response;
      await assert.rejects(branch.call(), /JSON.*上限/);
      assert.equal(response.observations().reads, 2);
      assert.equal(response.observations().cancels, 1);
      assert.equal(response.observations().jsonCalls, 0);

      const normalBytes = Buffer.from(JSON.stringify(branch.normal));
      response = responseFrom([normalBytes.subarray(0, 3), normalBytes.subarray(3)], { contentLength: normalBytes.length });
      globalThis.fetch = async () => response;
      await branch.call();
      assert.ok(response.observations().reads > 0);
      assert.equal(response.observations().jsonCalls, 0);

      response = responseFrom([Buffer.from("{")], { failAt: 1 });
      globalThis.fetch = async () => response;
      await assert.rejects(branch.call(), /传输中断|interruption/);
      assert.equal(response.observations().jsonCalls, 0);

      response = responseFrom([Buffer.from(JSON.stringify(branch.malformedShape))]);
      globalThis.fetch = async () => response;
      await assert.rejects(branch.call(), /JSON|响应|模型|分镜|角色|外观|任务|状态|ID/);
      assert.ok(response.observations().reads > 0);
      assert.equal(response.observations().jsonCalls, 0);
    } finally { globalThis.fetch = previousFetch; }
  });
}

test("providers.cjs contains no provider response.json call", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../desktop/providers.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /response\s*\.\s*json\s*\(/);
});
