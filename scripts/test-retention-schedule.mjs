#!/usr/bin/env node
// =============================================================
//  nextRunAt(): the daily sweep's clock. Fixed instants, no database.
//    node scripts/test-retention-schedule.mjs
// =============================================================

import { nextRunAt } from "../backend/retention/sweep.js";

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const iso = (d) => (d ? d.toISOString() : "null");

// Los Angeles, PDT (UTC-7): 02:00 local = 09:00Z
check("before today's slot: today", iso(nextRunAt("02:00", "America/Los_Angeles", new Date("2026-09-14T08:59:00Z"))) === "2026-09-14T09:00:00.000Z", iso(nextRunAt("02:00", "America/Los_Angeles", new Date("2026-09-14T08:59:00Z"))));
check("exactly at the slot: tomorrow", iso(nextRunAt("02:00", "America/Los_Angeles", new Date("2026-09-14T09:00:00Z"))) === "2026-09-15T09:00:00.000Z");
check("after today's slot: tomorrow", iso(nextRunAt("02:00", "America/Los_Angeles", new Date("2026-09-14T20:00:00Z"))) === "2026-09-15T09:00:00.000Z");
// crossing the PDT -> PST change (2026-11-01 in the US): 02:00 local becomes 10:00Z
check("after the autumn change: 02:00 PST = 10:00Z", iso(nextRunAt("02:00", "America/Los_Angeles", new Date("2026-11-02T12:00:00Z"))) === "2026-11-03T10:00:00.000Z", iso(nextRunAt("02:00", "America/Los_Angeles", new Date("2026-11-02T12:00:00Z"))));
check("the night of the change still lands on a real 02:00", (() => { const d = nextRunAt("02:00", "America/Los_Angeles", new Date("2026-11-01T06:00:00Z")); return d && d.getTime() > Date.parse("2026-11-01T06:00:00Z") && d.getTime() <= Date.parse("2026-11-01T10:00:00Z"); })(), iso(nextRunAt("02:00", "America/Los_Angeles", new Date("2026-11-01T06:00:00Z"))));
// UTC and a positive-offset zone
check("UTC: same clock", iso(nextRunAt("23:30", "UTC", new Date("2026-09-14T23:00:00Z"))) === "2026-09-14T23:30:00.000Z");
check("Honolulu (UTC-10, no DST): 02:00 = 12:00Z", iso(nextRunAt("02:00", "Pacific/Honolulu", new Date("2026-09-14T13:00:00Z"))) === "2026-09-15T12:00:00.000Z");
check("Tokyo (UTC+9): 02:00 = 17:00Z the day before", iso(nextRunAt("02:00", "Asia/Tokyo", new Date("2026-09-14T16:00:00Z"))) === "2026-09-14T17:00:00.000Z");
// invalid input
check("bad time is null", nextRunAt("25:00", "UTC") === null && nextRunAt("2am", "UTC") === null && nextRunAt("", "UTC") === null);
check("bad zone is null", nextRunAt("02:00", "Mars/Olympus") === null);
check("default now is in the future", (nextRunAt("02:00", "UTC")?.getTime() || 0) > Date.now());

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
