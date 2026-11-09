import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AwsProfileInfo, AwsProfileKind } from "@ccr/core/contracts/app";

type IniSections = Map<string, Map<string, string>>;

/**
 * Lists the named profiles the AWS SDK can resolve, from ~/.aws/config and
 * ~/.aws/credentials (or AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE).
 *
 * Only names, regions and the *kind* of auth are returned. Secret values
 * (access keys, tokens, role ARNs) are never copied out of the files.
 */
export function listAwsProfiles(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): AwsProfileInfo[] {
  const configFile = env.AWS_CONFIG_FILE?.trim() || path.join(homeDir, ".aws", "config");
  const credentialsFile = env.AWS_SHARED_CREDENTIALS_FILE?.trim() || path.join(homeDir, ".aws", "credentials");

  const profiles = new Map<string, { kinds: Set<AwsProfileKind>; region?: string }>();
  const ensure = (name: string) => {
    let profile = profiles.get(name);
    if (!profile) {
      profile = { kinds: new Set() };
      profiles.set(name, profile);
    }
    return profile;
  };

  // config: `[default]` and `[profile name]`. `[sso-session x]` / `[services x]` are not profiles.
  for (const [section, values] of parseIni(readTextIfPresent(configFile))) {
    const name = section === "default" ? "default" : /^profile\s+(.+)$/.exec(section)?.[1]?.trim();
    if (!name) continue;
    const profile = ensure(name);
    profile.region ??= values.get("region");
    profile.kinds.add(profileKind(values));
  }
  // credentials: `[name]` (the "profile " prefix is not used in this file).
  for (const [section, values] of parseIni(readTextIfPresent(credentialsFile))) {
    if (!section) continue;
    const profile = ensure(section);
    profile.region ??= values.get("region");
    profile.kinds.add(profileKind(values));
  }

  return [...profiles.entries()]
    .map(([name, profile]): AwsProfileInfo => ({
      kind: preferredKind(profile.kinds),
      name,
      ...(profile.region ? { region: profile.region } : {})
    }))
    .sort((left, right) => (left.name === "default" ? -1 : right.name === "default" ? 1 : left.name.localeCompare(right.name)));
}

function profileKind(values: Map<string, string>): AwsProfileKind {
  if (values.has("sso_session") || values.has("sso_start_url") || values.has("sso_account_id")) return "sso";
  if (values.has("role_arn")) return "role";
  if (values.has("credential_process")) return "process";
  if (values.has("web_identity_token_file")) return "web-identity";
  if (values.has("aws_access_key_id")) return "static";
  return "other";
}

// A profile can appear in both files (static keys in credentials, region in config).
// Pick the most specific description of how it authenticates.
const kindPriority: AwsProfileKind[] = ["sso", "role", "process", "web-identity", "static", "other"];
function preferredKind(kinds: Set<AwsProfileKind>): AwsProfileKind {
  return kindPriority.find((kind) => kinds.has(kind)) ?? "other";
}

function readTextIfPresent(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

function parseIni(text: string): IniSections {
  const sections: IniSections = new Map();
  let current: Map<string, string> | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      const name = header[1]!.trim();
      current = sections.get(name) ?? new Map();
      sections.set(name, current);
      continue;
    }
    const separator = line.indexOf("=");
    if (!current || separator <= 0) continue;
    current.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return sections;
}
