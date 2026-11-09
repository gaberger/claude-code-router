import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseProvidersForTest } from "@ccr/core/config/config.ts";
import { createDefaultAppConfig } from "@ccr/core/config/default-config.ts";
import { compileCoreGatewayConfig } from "@ccr/core/gateway/core-runtime/config-compiler.ts";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import {
  bedrockEventStreamResponse,
  bedrockInvokeBody,
  bedrockInvokeUrl,
  bedrockSettingsByProvider,
  clearBedrockCredentialCacheForTest,
  createGatewayPlugin,
  signBedrockRequest
} from "@ccr/core/gateway/core-runtime/bedrock-provider-hook.ts";

const codec = new EventStreamCodec(toUtf8, fromUtf8);

// Developer machines have real AWS_PROFILE/AWS_* settings and ~/.aws files. Tests must never
// resolve those, so wipe every AWS_* variable and point the SDK at an empty directory.
async function withIsolatedAwsEnv(env, run) {
  const saved = { ...process.env };
  const dir = mkdtempSync(path.join(os.tmpdir(), "ccr-bedrock-test-"));
  for (const key of Object.keys(process.env)) if (key.startsWith("AWS_")) delete process.env[key];
  Object.assign(process.env, {
    AWS_CONFIG_FILE: path.join(dir, "config"),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_SHARED_CREDENTIALS_FILE: path.join(dir, "credentials"),
    ...env
  });
  clearBedrockCredentialCacheForTest();
  try {
    await run();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    clearBedrockCredentialCacheForTest();
    rmSync(dir, { force: true, recursive: true });
  }
}

function eventFrame(anthropicEvent) {
  return codec.encode({
    body: fromUtf8(JSON.stringify({ bytes: Buffer.from(JSON.stringify(anthropicEvent)).toString("base64") })),
    headers: {
      ":content-type": { type: "string", value: "application/json" },
      ":event-type": { type: "string", value: "chunk" },
      ":message-type": { type: "string", value: "event" }
    }
  });
}

function exceptionFrame(type, message) {
  return codec.encode({
    body: fromUtf8(JSON.stringify({ message })),
    headers: {
      ":content-type": { type: "string", value: "application/json" },
      ":exception-type": { type: "string", value: type },
      ":message-type": { type: "string", value: "exception" }
    }
  });
}

function responseFromChunks(chunks) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  }), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

test("bedrock settings only include providers that declare a region", () => {
  assert.deepEqual(bedrockSettingsByProvider({
    providers: {
      "bedrock-a": { profile: "work", region: "us-west-2" },
      "bedrock-b": { region: " eu-west-1 " },
      "no-region": { profile: "x" }
    }
  }), {
    "bedrock-a": { profile: "work", region: "us-west-2" },
    "bedrock-b": { region: "eu-west-1" }
  });
});

test("invoke URL encodes inference profile ids and ARNs as a single path segment", () => {
  assert.equal(
    bedrockInvokeUrl("us-east-1", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", false),
    "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke"
  );
  assert.match(
    bedrockInvokeUrl("us-east-1", "arn:aws:bedrock:us-east-1:123:inference-profile/x", true),
    /\/model\/arn%3Aaws%3Abedrock%3Aus-east-1%3A123%3Ainference-profile%2Fx\/invoke-with-response-stream$/
  );
});

test("invoke body drops model and stream, adds anthropic_version, and folds the beta header into the body", () => {
  const body = bedrockInvokeBody(
    { max_tokens: 10, messages: [], model: "m", stream: true },
    "interleaved-thinking-2025-05-14, context-1m-2025-08-07"
  );
  assert.deepEqual(body, {
    anthropic_beta: ["interleaved-thinking-2025-05-14", "context-1m-2025-08-07"],
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 10,
    messages: []
  });
});

test("signing produces a SigV4 request for bedrock-runtime without leaking Anthropic auth headers", async () => {
  await withIsolatedAwsEnv({ AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "session-token" }, async () => {
    const result = await signBedrockRequest({
      body: { max_tokens: 5, messages: [{ content: "hi", role: "user" }], model: "us.anthropic.claude-haiku-4-5-v1:0", stream: true },
      headers: { "anthropic-beta": "context-1m-2025-08-07", "x-api-key": "should-not-forward" },
      url: "https://api.anthropic.com/v1/messages"
    }, { region: "us-west-2" }, () => new Date("2026-01-02T03:04:05Z"));

    assert.equal(result.ok, true);
    const { value } = result;
    assert.equal(value.url, "https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-haiku-4-5-v1%3A0/invoke-with-response-stream");
    assert.equal(value.bodyEncoding, "text");
    assert.equal(JSON.parse(value.body).anthropic_version, "bedrock-2023-05-31");
    assert.equal(JSON.parse(value.body).stream, undefined);
    assert.equal(value.headers["x-amz-date"], "20260102T030405Z");
    assert.equal(value.headers["x-amz-security-token"], "session-token");
    assert.equal(value.headers.accept, "application/vnd.amazon.eventstream");
    assert.equal(value.headers["x-api-key"], undefined);
    assert.equal(value.headers.host, undefined);
    assert.match(
      value.headers.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/us-west-2\/bedrock\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/
    );
  });
});

test("signing reports a clear error when the named profile cannot be resolved", async () => {
  await withIsolatedAwsEnv({}, async () => {
    const result = await signBedrockRequest(
      { body: { messages: [], model: "m" }, url: "https://x" },
      { profile: "ccr-test-profile-that-does-not-exist", region: "us-east-1" }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /AWS profile "ccr-test-profile-that-does-not-exist"/);
  });
});

test("eventstream frames split across arbitrary chunk boundaries become Anthropic SSE", async () => {
  const start = { message: { id: "msg_1", role: "assistant" }, type: "message_start" };
  const delta = { delta: { text: "hello", type: "text_delta" }, index: 0, type: "content_block_delta" };
  const wire = Buffer.concat([eventFrame(start), eventFrame(delta), exceptionFrame("throttlingException", "slow down")]);
  // Slice mid-frame (including inside the 4-byte length prefix) to exercise buffering.
  const chunks = [wire.subarray(0, 2), wire.subarray(2, 40), wire.subarray(40, wire.length - 5), wire.subarray(wire.length - 5)];

  const converted = bedrockEventStreamResponse(responseFromChunks(chunks));
  assert.equal(converted.headers.get("content-type"), "text/event-stream");
  const text = await converted.text();

  assert.equal(
    text,
    `event: message_start\ndata: ${JSON.stringify(start)}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n` +
    `event: error\ndata: ${JSON.stringify({ error: { message: "slow down", type: "throttlingException" }, type: "error" })}\n\n`
  );
});

test("plugin registers one request hook per bedrock provider and leaves other streams untouched", async () => {
  const plugin = createGatewayPlugin({ config: { providers: { "bedrock-main": { region: "us-east-1" } } } });
  assert.deepEqual(plugin.providerHooks.map((hook) => hook.providerName), ["bedrock-main"]);

  const json = new Response("{}", { headers: { "content-type": "application/json" } });
  assert.equal(plugin.streamHooks[0].transformResponse({ response: json }), json);

  assert.deepEqual(createGatewayPlugin({ config: {} }), { providerHooks: [], streamHooks: [] });
});

test("compiler registers the bedrock hook for providers with a bedrock block and skips it otherwise", async () => {
  const config = createDefaultAppConfig();
  config.Providers = [
    {
      bedrock: { profile: "work", region: "us-west-2" },
      baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
      models: ["us.anthropic.claude-sonnet-4-5-20250929-v1:0"],
      name: "Bedrock Work",
      type: "anthropic_messages"
    },
    { api_key: "k", baseUrl: "https://api.anthropic.com", models: ["claude-x"], name: "Anthropic", type: "anthropic_messages" }
  ];
  const compiled = await compileCoreGatewayConfig(config, "trace", "billing", "auth");
  const plugin = compiled.plugins.find((item) => item.key === "ccr-bedrock-provider-hooks");
  assert.ok(plugin, "bedrock hook plugin should be registered");
  assert.match(plugin.modulePath, /bedrock-provider-hook\.js$/);
  const [hookedName, ...otherHooked] = Object.keys(plugin.config.providers);
  assert.deepEqual(otherHooked, []);
  assert.deepEqual(plugin.config.providers[hookedName], { profile: "work", region: "us-west-2" });
  assert.ok(compiled.providers.some((provider) => provider.name === hookedName),
    "hook must be keyed by the provider name the gateway actually receives");

  config.Providers = config.Providers.slice(1);
  const without = await compileCoreGatewayConfig(config, "trace", "billing", "auth");
  assert.equal(without.plugins.find((item) => item.key === "ccr-bedrock-provider-hooks"), undefined);
});

test("config parsing keeps the bedrock block and drops it when there is no region", () => {
  const [kept, dropped] = parseProvidersForTest([
    { baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com", bedrock: { profile: " sso-dev ", region: " eu-west-1 " }, models: ["m"], name: "kept", type: "anthropic_messages" },
    { baseUrl: "https://api.anthropic.com", bedrock: { profile: "x" }, models: ["m"], name: "dropped", type: "anthropic_messages" }
  ]);
  assert.deepEqual(kept.bedrock, { profile: "sso-dev", region: "eu-west-1" });
  assert.equal(dropped.bedrock, undefined);
});

test("a bedrock provider still gets its hook when a preset adds capabilities that rename it", async () => {
  const config = createDefaultAppConfig();
  config.Providers = parseProvidersForTest([{
    // The preset's own us-east-1 endpoint makes normalizeProviderPresetCapabilities add capabilities.
    api_base_url: "https://bedrock-runtime.us-east-1.amazonaws.com",
    bedrock: { region: "us-east-1" },
    models: ["us.anthropic.claude-sonnet-4-5-20250929-v1:0"],
    name: "Bedrock",
    type: "anthropic_messages"
  }]);
  const compiled = await compileCoreGatewayConfig(config, "trace", "billing", "auth");
  const plugin = compiled.plugins.find((item) => item.key === "ccr-bedrock-provider-hooks");
  assert.ok(plugin);
  const hooked = Object.keys(plugin.config.providers);
  assert.ok(hooked.length > 0);
  for (const provider of compiled.providers.filter((item) => item.baseurl?.includes("bedrock-runtime"))) {
    assert.ok(hooked.includes(provider.name), `provider ${provider.name} reaches the gateway without a Bedrock hook`);
  }
});
