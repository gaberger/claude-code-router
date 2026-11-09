import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listAwsProfiles } from "@ccr/core/providers/aws-profiles.ts";

function withAwsDir(files, run) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ccr-aws-profiles-"));
  try {
    mkdirSync(path.join(home, ".aws"));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(home, ".aws", name), text);
    return run(home);
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}

test("lists profiles from config and credentials with default first and no secrets", () => {
  withAwsDir({
    config: [
      "# comment",
      "[default]",
      "region = us-east-1",
      "",
      "[profile work-sso]",
      "sso_session = corp",
      "sso_account_id = 123456789012",
      "region = eu-west-1",
      "",
      "[profile admin]",
      "role_arn = arn:aws:iam::123456789012:role/Admin",
      "source_profile = work-sso",
      "",
      "[sso-session corp]",
      "sso_start_url = https://corp.awsapps.com/start",
      "",
      "[services custom]",
      "s3 = \n  endpoint_url = http://localhost"
    ].join("\n"),
    credentials: [
      "[default]",
      "aws_access_key_id = AKIASECRETSECRETSECRET",
      "aws_secret_access_key = very-secret-value",
      "",
      "[ci]",
      "aws_access_key_id = AKIAOTHERKEY",
      "aws_secret_access_key = another-secret",
      "region = ap-southeast-2"
    ].join("\n")
  }, (home) => {
    const profiles = listAwsProfiles({}, home);
    assert.deepEqual(profiles, [
      { kind: "static", name: "default", region: "us-east-1" },
      { kind: "role", name: "admin" },
      { kind: "static", name: "ci", region: "ap-southeast-2" },
      { kind: "sso", name: "work-sso", region: "eu-west-1" }
    ]);
    const serialized = JSON.stringify(profiles);
    for (const secret of ["AKIA", "secret", "arn:aws", "awsapps"]) {
      assert.equal(serialized.includes(secret), false, `profile list leaked ${secret}`);
    }
  });
});

test("honors AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE and tolerates missing files", () => {
  withAwsDir({ "custom-config": "[profile elsewhere]\nregion = us-west-2\n" }, (home) => {
    assert.deepEqual(
      listAwsProfiles({
        AWS_CONFIG_FILE: path.join(home, ".aws", "custom-config"),
        AWS_SHARED_CREDENTIALS_FILE: path.join(home, ".aws", "does-not-exist")
      }, home),
      [{ kind: "other", name: "elsewhere", region: "us-west-2" }]
    );
  });
  assert.deepEqual(listAwsProfiles({}, path.join(os.tmpdir(), "ccr-no-such-home-dir")), []);
});
