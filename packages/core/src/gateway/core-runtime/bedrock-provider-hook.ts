/**
 * Gateway plugin that lets an `anthropic_messages` provider talk to Claude on
 * Amazon Bedrock using a named AWS profile.
 *
 * The embedded gateway already speaks Anthropic Messages (request, JSON and
 * SSE parsing), so Bedrock support is a thin translation layer around it:
 *   - request: rewrite the URL to `/model/{id}/invoke[-with-response-stream]`,
 *     move `model`/`stream`/`anthropic-beta` out of the way, add
 *     `anthropic_version`, and SigV4-sign with credentials from the profile.
 *   - response: Bedrock streams binary AWS eventstream frames; convert them
 *     back into the Anthropic SSE events the gateway expects.
 */
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Sha256 } from "@aws-crypto/sha256-js";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";

const bedrockAnthropicVersion = "bedrock-2023-05-31";
const eventStreamContentType = "application/vnd.amazon.eventstream";
const credentialRefreshSkewMs = 5 * 60 * 1000;

export type BedrockProviderSettings = {
  /** Named profile from ~/.aws/config. Omit to use the default credential chain. */
  profile?: string;
  region: string;
};

type HeaderRecord = Record<string, string>;
type AwsCredentials = {
  accessKeyId: string;
  expiration?: Date;
  secretAccessKey: string;
  sessionToken?: string;
};

type UpstreamRequest = {
  body?: unknown;
  bodyEncoding?: "bytes" | "form" | "json" | "none" | "text";
  headers?: HeaderRecord;
  method?: string;
  url: string;
};

type ProviderHookResult = { ok: true; value: UpstreamRequest } | { error: string; ok: false };

export function createGatewayPlugin(input: { config?: Record<string, unknown>; plugin?: { config?: Record<string, unknown> } } = {}) {
  const settings = bedrockSettingsByProvider(input.plugin?.config ?? input.config);
  const providerNames = Object.keys(settings);
  return {
    providerHooks: providerNames.map((providerName) => ({
      key: `module:ccr-bedrock:${providerName}`,
      providerName,
      transformRequest: (hookInput: { upstreamRequest: UpstreamRequest }) =>
        signBedrockRequest(hookInput.upstreamRequest, settings[providerName]!)
    })),
    streamHooks: providerNames.length === 0 ? [] : [{
      key: "module:ccr-bedrock:eventstream",
      transformResponse: (hookInput: { providerName?: string; response: Response }) => {
        // Hooks are not scoped by provider here, so key off the wire format.
        const contentType = hookInput.response.headers.get("content-type") ?? "";
        return contentType.toLowerCase().startsWith(eventStreamContentType)
          ? bedrockEventStreamResponse(hookInput.response)
          : hookInput.response;
      }
    }]
  };
}

export function bedrockSettingsByProvider(config: Record<string, unknown> | undefined): Record<string, BedrockProviderSettings> {
  const raw = config?.providers;
  const result: Record<string, BedrockProviderSettings> = {};
  if (!raw || typeof raw !== "object") {
    return result;
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const record = value as { profile?: unknown; region?: unknown } | null;
    const region = typeof record?.region === "string" ? record.region.trim() : "";
    if (!name || !region) {
      continue;
    }
    const profile = typeof record?.profile === "string" ? record.profile.trim() : "";
    result[name] = { region, ...(profile ? { profile } : {}) };
  }
  return result;
}

export function bedrockInvokeUrl(region: string, modelId: string, streaming: boolean): string {
  const action = streaming ? "invoke-with-response-stream" : "invoke";
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/${action}`;
}

/** Translate an Anthropic Messages body into the body Bedrock InvokeModel expects. */
export function bedrockInvokeBody(body: Record<string, unknown>, anthropicBetaHeader: string | undefined): Record<string, unknown> {
  const { model: _model, stream: _stream, ...rest } = body;
  const betas = new Set<string>(Array.isArray(rest.anthropic_beta) ? rest.anthropic_beta.filter((item): item is string => typeof item === "string") : []);
  for (const beta of (anthropicBetaHeader ?? "").split(",")) {
    if (beta.trim()) betas.add(beta.trim());
  }
  return {
    ...rest,
    anthropic_version: bedrockAnthropicVersion,
    ...(betas.size > 0 ? { anthropic_beta: [...betas] } : {})
  };
}

export async function signBedrockRequest(
  upstreamRequest: UpstreamRequest,
  settings: BedrockProviderSettings,
  now: () => Date = () => new Date()
): Promise<ProviderHookResult> {
  const body = parseBody(upstreamRequest.body);
  const modelId = typeof body?.model === "string" ? body.model : "";
  if (!body || !modelId) {
    return { error: "Bedrock requests need a model id in the request body.", ok: false };
  }
  const streaming = body.stream === true;
  const headerLookup = lowerCaseHeaders(upstreamRequest.headers);
  const payload = JSON.stringify(bedrockInvokeBody(body, headerLookup["anthropic-beta"]));
  const url = new URL(bedrockInvokeUrl(settings.region, modelId, streaming));

  let credentials: AwsCredentials;
  try {
    credentials = await resolveAwsCredentials(settings.profile);
  } catch (error) {
    const profile = settings.profile ? `AWS profile "${settings.profile}"` : "the default AWS credential chain";
    return { error: `Could not resolve credentials from ${profile}: ${error instanceof Error ? error.message : String(error)}`, ok: false };
  }

  const signer = new SignatureV4({
    credentials,
    region: settings.region,
    service: "bedrock",
    sha256: Sha256
  });
  const signed = await signer.sign(new HttpRequest({
    body: payload,
    headers: {
      accept: streaming ? eventStreamContentType : "application/json",
      "content-type": "application/json",
      host: url.host
    },
    hostname: url.hostname,
    method: "POST",
    path: url.pathname,
    protocol: url.protocol
  }), { signingDate: now() });

  const headers: HeaderRecord = {};
  for (const [name, value] of Object.entries(signed.headers)) {
    // fetch sets Host itself; it is signed but must not be forwarded twice.
    if (name.toLowerCase() !== "host") {
      headers[name] = String(value);
    }
  }
  return {
    ok: true,
    value: {
      ...upstreamRequest,
      body: payload,
      bodyEncoding: "text",
      headers,
      method: "POST",
      url: url.toString()
    }
  };
}

const credentialCache = new Map<string, { credentials: AwsCredentials; resolvedAt: number }>();

async function resolveAwsCredentials(profile: string | undefined): Promise<AwsCredentials> {
  const cacheKey = profile ?? "";
  const cached = credentialCache.get(cacheKey);
  const nowMs = Date.now();
  if (cached && (!cached.credentials.expiration || cached.credentials.expiration.getTime() - nowMs > credentialRefreshSkewMs)) {
    return cached.credentials;
  }
  const credentials = await fromNodeProviderChain(profile ? { profile } : {})();
  credentialCache.set(cacheKey, { credentials, resolvedAt: nowMs });
  return credentials;
}

export function clearBedrockCredentialCacheForTest(): void {
  credentialCache.clear();
}

function parseBody(body: unknown): Record<string, unknown> | undefined {
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return parseBody(Buffer.from(body).toString("utf8"));
  }
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
}

function lowerCaseHeaders(headers: HeaderRecord | undefined): HeaderRecord {
  const result: HeaderRecord = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    result[name.toLowerCase()] = value;
  }
  return result;
}

/**
 * Decode a Bedrock `invoke-with-response-stream` body into Anthropic SSE.
 * Each eventstream "chunk" frame wraps `{ "bytes": "<base64 anthropic event>" }`.
 */
export function bedrockEventStreamResponse(response: Response): Response {
  const upstream = response.body;
  if (!upstream) {
    return response;
  }
  const codec = new EventStreamCodec(toUtf8, fromUtf8);
  let pending: Uint8Array = new Uint8Array(0);
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending = concatBytes(pending, chunk);
      while (pending.length >= 4) {
        const frameLength = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(0, false);
        if (frameLength < 16 || pending.length < frameLength) {
          break;
        }
        const frame = pending.slice(0, frameLength);
        pending = pending.slice(frameLength);
        const sse = eventStreamFrameToSse(codec, frame);
        if (sse) {
          controller.enqueue(fromUtf8(sse));
        }
      }
    }
  });
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/event-stream");
  headers.delete("content-length");
  return new Response(upstream.pipeThrough(transform), {
    headers,
    status: response.status,
    statusText: response.statusText
  });
}

function eventStreamFrameToSse(codec: EventStreamCodec, frame: Uint8Array): string | undefined {
  const message = codec.decode(frame);
  const messageType = String(message.headers[":message-type"]?.value ?? "");
  const bodyText = toUtf8(message.body);
  if (messageType === "event") {
    const outer = safeJson(bodyText) as { bytes?: unknown } | undefined;
    if (typeof outer?.bytes !== "string") {
      return undefined;
    }
    const inner = Buffer.from(outer.bytes, "base64").toString("utf8");
    const type = (safeJson(inner) as { type?: unknown } | undefined)?.type;
    return `event: ${typeof type === "string" ? type : "message"}\ndata: ${inner}\n\n`;
  }
  const errorType = String(message.headers[":exception-type"]?.value ?? message.headers[":error-code"]?.value ?? "api_error");
  const errorMessage = (safeJson(bodyText) as { message?: unknown } | undefined)?.message;
  return `event: error\ndata: ${JSON.stringify({
    error: { message: typeof errorMessage === "string" ? errorMessage : bodyText, type: errorType },
    type: "error"
  })}\n\n`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}
