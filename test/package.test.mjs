import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CUAR_VERSION } from "../scripts/lib/schema.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("keeps package, plugin, and runtime versions identical", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  const pluginJson = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  );
  assert.equal(packageJson.version, CUAR_VERSION);
  assert.equal(pluginJson.version, CUAR_VERSION);
  assert.equal(packageJson.name, pluginJson.name);
});

test("ships only declared local plugin components", () => {
  const plugin = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  );
  assert.equal(plugin.skills, "./skills/");
  assert.equal(plugin.interface.composerIcon, "./assets/icon.png");
  assert.equal(plugin.interface.logo, "./assets/icon.png");
  assert.equal(Object.hasOwn(plugin, "mcpServers"), false);
  assert.equal(Object.hasOwn(plugin, "apps"), false);
  assert.equal(Object.hasOwn(plugin, "hooks"), false);
  assert.equal(
    fs.existsSync(path.join(ROOT, "skills", "cuar", "SKILL.md")),
    true,
  );
  assert.equal(fs.existsSync(path.join(ROOT, "scripts", "cuar.mjs")), true);
  assert.equal(
    fs.existsSync(path.join(ROOT, "schema", "report.schema.json")),
    true,
  );
  assert.equal(fs.existsSync(path.join(ROOT, "assets", "icon.png")), true);
});

test("skill has finished frontmatter and no placeholders", () => {
  const skill = fs.readFileSync(
    path.join(ROOT, "skills", "cuar", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /^---\nname: cuar\ndescription: .+\n---\n/);
  const skillDescription = skill.match(
    /^---\nname: cuar\ndescription: (.+)\n---\n/,
  )?.[1];
  assert.ok(skillDescription);
  assert.match(
    skillDescription,
    /^Use whenever the user invokes or mentions CUAR,/,
  );
  assert.ok(
    skillDescription.indexOf("reminder tooling is unavailable") < 160,
    "reminder-tooling dispatch must remain near the front of the description",
  );
  assert.equal(skill.includes("[TODO:"), false);
  assert.match(skill, /\$cuar/);
  assert.match(skill, /whether a CUAR expiration reminder was created/);
  assert.match(skill, /whether CUAR reminder tooling is unavailable/);
});

test("skill requires every normal-summary fact and caveat", () => {
  const skill = fs.readFileSync(
    path.join(ROOT, "skills", "cuar", "SKILL.md"),
    "utf8",
  );
  for (const [label, pattern] of [
    ["complete checklist", /state every applicable item below/],
    ["expiration time", /every returned expiration's local date/],
    ["exhaustion time", /projected-exhaustion local date and clock time/],
    ["active reset time", /active-reset local date and\s+clock time/],
    ["conditional projection", /conditional on the current average burn continuing/],
    ["non-additive resets", /banked resets are not additive current capacity/],
    ["whole-point source", /OpenAI reports usage in whole percentage points/],
    ["remaining upper bound", /remaining percentage is an upper bound/],
    ["one-percent state", /less_than_one_percent/],
    ["one-percent urgency", /exhaustion is imminent/],
    ["projection uncertainty", /may occur sooner than the projection/],
    ["time-zone context", /Include time-zone\s+context once/],
    ["one action", /Recommend at most\s+one action/],
    ["no action menu", /never present an either\/or menu/],
  ]) {
    assert.match(skill, pattern, `missing skill contract: ${label}`);
  }
});

test("skill requires one low-freedom recovery action for errors", () => {
  const skill = fs.readFileSync(
    path.join(ROOT, "skills", "cuar", "SKILL.md"),
    "utf8",
  );
  for (const [label, pattern] of [
    ["exact recovery", /use the exact mapped recovery sentence/],
    ["malformed retry", /Recovery action: Retry \$cuar once in a fresh request/],
    ["method update", /Recovery action: Update Codex/],
    ["login action", /Recovery action: Sign in to Codex/],
    ["runtime action", /`codex_not_executable` or `codex_not_found`/],
    ["end immediately", /end the answer immediately after it/],
    ["no alternatives", /Do not combine alternatives with “or,”/],
    ["no follow-up", /append any validation, retry, or follow-up sentence/],
    [
      "current forecast declined",
      /The CUAR refresh failed, so I cannot provide a current capacity\s+forecast/,
    ],
    ["no stale repeat", /Do not repeat retained facts/],
    ["no reminder success", /no reminder was created/],
    [
      "reminder authorization boundary",
      /Creating a reminder requires\s+your explicit authorization; no reminder was created\./,
    ],
    [
      "unavailable reminder boundary",
      /Reminder tooling is\s+unavailable on this surface, so no reminder was created\./,
    ],
    [
      "no reminder acquisition",
      /acquire a new CUAR report merely\s+to\s+answer/,
    ],
  ]) {
    assert.match(skill, pattern, `missing error/session contract: ${label}`);
  }
});
