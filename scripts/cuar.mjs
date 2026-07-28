#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "./lib/cli.mjs";

export function isCliEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const modulePath = fileURLToPath(moduleUrl);
  const entryPath = path.resolve(argv1);
  if (entryPath === modulePath) return true;
  try {
    return fs.realpathSync(entryPath) === fs.realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isCliEntry(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
