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
    fs.existsSync(path.join(ROOT, "scripts", "lib", "reset-ledger.mjs")),
    true,
  );
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
  assert.match(skillDescription, /whether an unscheduled Codex reset happened/);
  assert.equal(
    skillDescription.includes("scheduled summaries"),
    false,
    "the skill must not advertise unimplemented scheduled summaries",
  );
});

test("skill interprets the local reset ledger conservatively", () => {
  const skill = fs.readFileSync(
    path.join(ROOT, "skills", "cuar", "SKILL.md"),
    "utf8",
  );
  for (const [label, pattern] of [
    ["schema version", /`schema_version` to equal `2`/],
    ["bounded ledger", /one sanitized usage snapshot and at most one recent\s+derived reset event/],
    ["eight-day retention", /prunes either on the next successful report\s+once it is more than eight days old/],
    ["observation window", /interval from\s+`previous_observed_at_local` through `observed_at_local`/],
    ["no exact reset time", /Never claim the exact reset time/],
    ["likely reset caveat", /an account switch cannot be ruled out/],
    ["banked reset caveat", /event may reflect banked-reset use/],
    ["no evidence caveat", /not proof that none occurred/],
    ["no auth inspection", /Do not inspect authentication to distinguish accounts/],
    ["session alert", /`reset_observation\.detected_now` is true/],
  ]) {
    assert.match(skill, pattern, `missing reset-ledger contract: ${label}`);
  }
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
    ["next reset time", /next-scheduled-reset local\s+date and clock time/],
    ["conditional projection", /conditional on the current average burn continuing/],
    [
      "replacement resets",
      /banked resets are replacement resets and do not increase current\s+remaining usage until used/,
    ],
    ["whole-point source", /OpenAI reports usage in whole percentage points/],
    ["remaining upper bound", /remaining percentage is an upper bound/],
    [
      "linear pace meaning",
      /Linear pace means being on\s+track to use exactly 100% at the next scheduled reset/,
    ],
    ["one-percent state", /less_than_one_percent/],
    ["one-percent urgency", /exhaustion is imminent/],
    ["projection uncertainty", /may occur sooner than the projection/],
    ["time-zone context", /Include time-zone\s+context once/],
    ["one action", /Select exactly one controlling deadline/],
    ["no action menu", /Never present an either\/or menu/],
    [
      "exhaustion deadline strategy",
      /moving already valuable Codex-dependent work\s+before that supplied exhaustion deadline/,
    ],
    [
      "expiring reset priority",
      /banked reset with `expiry_state` equal to `future` and a non-null\s+`expires_at_local` controls/,
    ],
    [
      "expired reset exclusion",
      /Never use an `expired` or `no_expiration_reported` row as a\s+deadline/,
    ],
    [
      "expiring reset strategy",
      /moving only\s+already\s+valuable Codex-dependent work before that expiration/,
    ],
    ["undefined strategy ban", /never use\s+undefined phrases such as `capacity-sensitive work`/i],
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
      /The CUAR refresh failed, so I cannot provide a current usage\s+forecast/,
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

test("manifest offers compact reset and usage-aware starters", () => {
  const plugin = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  );
  assert.ok(
    plugin.interface.defaultPrompt.includes(
      "Stay usage-aware for this session.",
    ),
  );
  assert.ok(
    plugin.interface.defaultPrompt.includes(
      "Did an unscheduled Codex reset just happen?",
    ),
  );
  assert.deepEqual(plugin.interface.capabilities, ["Read", "Local storage"]);
  assert.equal(plugin.homepage, "https://filamentlabs.io/CUAR");
  assert.equal(
    plugin.repository,
    "https://github.com/joelfarthing/codex-usage-and-resets",
  );
  assert.deepEqual(plugin.keywords, [
    "codex",
    "usage",
    "rate-limits",
    "capacity-planning",
    "reset-credits",
  ]);
  assert.equal(plugin.interface.websiteURL, "https://filamentlabs.io/CUAR");
  assert.equal(
    plugin.interface.privacyPolicyURL,
    "https://filamentlabs.io/CUAR/privacy",
  );
  assert.equal(
    plugin.interface.termsOfServiceURL,
    "https://filamentlabs.io/CUAR/terms",
  );
  const agent = fs.readFileSync(
    path.join(ROOT, "skills", "cuar", "agents", "openai.yaml"),
    "utf8",
  );
  assert.match(agent, /default_prompt: "Use \$cuar and stay usage-aware for this session\."/);
});
