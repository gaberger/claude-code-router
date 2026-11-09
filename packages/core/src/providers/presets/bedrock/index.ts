import { defaultProviderAccountConfig, type ProviderPreset } from "@ccr/core/providers/presets/types";

export const bedrockProviderPresetId = "bedrock";
export const bedrockDefaultRegion = "us-east-1";

/** Runtime endpoint for a region. Requests are SigV4-signed by the Bedrock gateway hook. */
export function bedrockRuntimeBaseUrl(region: string): string {
  return `https://bedrock-runtime.${region.trim() || bedrockDefaultRegion}.amazonaws.com`;
}

export const bedrockProviderPreset: ProviderPreset = {
  account: defaultProviderAccountConfig,
  aliases: ["bedrock", "aws", "amazon-bedrock", "amazon bedrock"],
  // Cross-region inference profile ids. The `us.` prefix is geography-specific; use `eu.` or `apac.` outside the US.
  defaultModels: [
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.anthropic.claude-opus-4-1-20250805-v1:0"
  ],
  endpoints: [
    {
      baseUrl: bedrockRuntimeBaseUrl(bedrockDefaultRegion),
      protocols: ["anthropic_messages"]
    }
  ],
  id: bedrockProviderPresetId,
  name: "Amazon Bedrock",
  websiteUrl: "https://aws.amazon.com/bedrock/"
};
