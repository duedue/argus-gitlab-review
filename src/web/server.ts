import { join } from "node:path";
import { serve } from "@hono/node-server";
import { assertRequiredConfig, loadConfig } from "../config.ts";
import { getMasterKey } from "../crypto.ts";
import { releaseStaleRunning, openDb } from "../db.ts";
import { applyStoredSettings, bootstrapSetup } from "../setup.ts";
import { warnOwnerEngineTest } from "../engine.ts";
import { pollLoop } from "../runtime.ts";
import { createApp } from "./app.tsx";

// Entry for `npm run web`: HTTP server + the poller loop in ONE process. One process matters for OAuth users:
// GitLab rotates refresh tokens, and a single process serialises refreshes per user.
const cfg = loadConfig();
assertRequiredConfig(cfg); // uncaught throw = startup failure with the hint in the log
const key = getMasterKey(); // fail closed
const db = openDb(join(cfg.dataDir, "argus.db"));
applyStoredSettings(cfg, db, key); // env > DB for owner / Jira token
// Empty client id/secret = SETUP MODE (first run): the app serves only /setup until the form fills this same object in place.
const { oauth } = bootstrapSetup(cfg, db, key);
warnOwnerEngineTest(cfg.ownerEngineTestUsers);
releaseStaleRunning(db);

serve({ fetch: createApp({ cfg, db, key, oauth }).fetch, port: cfg.web.port, hostname: cfg.web.host }, (i) =>
  console.log(`[web] listening on http://${i.address}:${i.port} (redirect ${oauth.redirectUri}, secure cookies: ${cfg.web.cookieSecure})`),
);

if (process.env.POLL !== "0") {
  console.log(cfg.dryRun ? "dry-run: nothing will be posted" : "LIVE: comments WILL be posted to GitLab");
  void pollLoop(cfg, db, key, oauth);
}
