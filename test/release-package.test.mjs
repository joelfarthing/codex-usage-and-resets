import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGER = path.join(ROOT, "scripts", "package-release-candidate.py");
const FAKE_CODEX = path.join(ROOT, "test-support", "fake-codex.mjs");
const PACKAGE_ROOT = "codex-usage-and-resets";
const RELEASE_VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;

function packageReleaseCandidate(output) {
  const result = spawnSync("python3", [PACKAGER, "--output", output], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("release-candidate package is deterministic and strictly allowlisted", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "cuar release package "),
  );
  try {
    const firstPath = path.join(temporary, "first.zip");
    const secondPath = path.join(temporary, "second.zip");
    const first = packageReleaseCandidate(firstPath);
    const second = packageReleaseCandidate(secondPath);

    assert.equal(first.version, RELEASE_VERSION);
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(fs.readFileSync(firstPath), fs.readFileSync(secondPath));
    assert.equal(
      first.sha256,
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(firstPath))
        .digest("hex"),
    );

    assert.ok(first.entries.length > 0);
    assert.ok(
      first.entries.every((entry) => entry.startsWith(`${PACKAGE_ROOT}/`)),
    );
    for (const required of [
      ".codex-plugin/plugin.json",
      ".codexignore",
      "LICENSE",
      "PRIVACY.md",
      "README.md",
      "SECURITY.md",
      "SUPPORT.md",
      "assets/icon.png",
      "schema/report.schema.json",
      "scripts/cuar.mjs",
      "scripts/lib/reset-ledger.mjs",
      "skills/cuar/SKILL.md",
      "skills/cuar/agents/openai.yaml",
    ]) {
      assert.ok(first.entries.includes(`${PACKAGE_ROOT}/${required}`));
    }

    for (const excluded of [
      ".git/",
      ".github/",
      "AGENTS.md",
      "CHATGPT-DESKTOP-HANDOFF.md",
      "dist/",
      "docs/",
      "FEASIBILITY.md",
      "FAILURE-PARITY.md",
      "IMPLEMENTATION-BRIEF.md",
      "package.json",
      "package-lock.json",
      "MARKETPLACE-SUBMISSION-DRAFT.md",
      "RELEASE-READINESS.md",
      "scripts/package-release-candidate.py",
      "SPEC.md",
      "test/",
      "test-support/",
      "TEST-MATRIX.md",
    ]) {
      assert.equal(
        first.entries.some((entry) =>
          entry.startsWith(`${PACKAGE_ROOT}/${excluded}`),
        ),
        false,
        `${excluded} must not enter the release ZIP`,
      );
    }

    const extracted = path.join(temporary, "extracted plugin path with spaces");
    const extraction = spawnSync(
      "python3",
      ["-m", "zipfile", "-e", firstPath, extracted],
      { encoding: "utf8" },
    );
    assert.equal(extraction.status, 0, extraction.stderr || extraction.stdout);

    const packagedRoot = path.join(extracted, PACKAGE_ROOT);
    const packagedManifest = JSON.parse(
      fs.readFileSync(
        path.join(packagedRoot, ".codex-plugin", "plugin.json"),
        "utf8",
      ),
    );
    assert.equal(packagedManifest.name, PACKAGE_ROOT);
    assert.equal(packagedManifest.version, RELEASE_VERSION);
    assert.equal(packagedManifest.license, "Apache-2.0");
    assert.ok(packagedManifest.name.length <= 64);
    assert.ok(packagedManifest.version.length <= 64);
    assert.ok(packagedManifest.interface.displayName.length <= 30);
    assert.ok(packagedManifest.interface.shortDescription.length <= 30);
    assert.ok(packagedManifest.interface.longDescription.length <= 4000);
    assert.ok(packagedManifest.interface.developerName.length <= 80);
    assert.deepEqual(packagedManifest.interface.capabilities, [
      "Read",
      "Local storage",
    ]);
    assert.equal(
      packagedManifest.homepage,
      "https://filamentlabs.io/CUAR",
    );
    assert.equal(
      packagedManifest.repository,
      "https://github.com/joelfarthing/codex-usage-and-resets",
    );
    assert.equal(
      packagedManifest.interface.websiteURL,
      "https://filamentlabs.io/CUAR",
    );
    assert.equal(
      packagedManifest.interface.privacyPolicyURL,
      "https://filamentlabs.io/CUAR/privacy",
    );
    assert.equal(
      packagedManifest.interface.termsOfServiceURL,
      "https://filamentlabs.io/CUAR/terms",
    );
    assert.equal(
      packagedManifest.interface.composerIcon,
      "./assets/icon.png",
    );
    assert.equal(packagedManifest.interface.logo, "./assets/icon.png");
    const icon = fs.readFileSync(path.join(packagedRoot, "assets", "icon.png"));
    assert.deepEqual(
      icon.subarray(0, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    assert.equal(icon.readUInt32BE(16), 512);
    assert.equal(icon.readUInt32BE(20), 512);
    assert.ok(icon.length <= 5 * 1024 * 1024);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        JSON.parse(
          fs.readFileSync(
            path.join(packagedRoot, "schema", "report.schema.json"),
            "utf8",
          ),
        ),
        "$id",
      ),
      false,
    );

    const isolatedCodexHome = path.join(temporary, "isolated codex home");
    fs.mkdirSync(isolatedCodexHome, { mode: 0o700 });
    const smoke = spawnSync(
      process.execPath,
      [
        path.join(packagedRoot, "scripts", "cuar.mjs"),
        "report",
        "--json",
        "--timezone",
        "America/Chicago",
      ],
      {
        cwd: temporary,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: isolatedCodexHome,
          CUAR_CODEX_BIN: FAKE_CODEX,
          CUAR_FAKE_MODE: "normal",
          CUAR_FAKE_REQUEST_LOG: "",
          CUAR_TEST_MODE: "1",
          CUAR_TEST_FETCHED_AT: "1785213000",
        },
      },
    );
    assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
    const report = JSON.parse(smoke.stdout);
    assert.equal(report.schema_version, 2);
    assert.equal(report.source.method, "account/rateLimits/read");
    assert.equal(report.usage.limit_id, "codex");
    assert.equal(report.banked_resets.available_count, 2);
    assert.equal(smoke.stdout.includes("opaque-fixture-id"), false);
    assert.deepEqual(fs.readdirSync(isolatedCodexHome), []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
