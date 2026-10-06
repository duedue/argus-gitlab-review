import test from "node:test";
import assert from "node:assert/strict";
import { isExcluded } from "../src/exclude.ts";
import { DEFAULT_EXCLUDES } from "../src/config.ts";

test("default globs exclude lock/generated/vendor files, keep source", () => {
  for (const p of ["package-lock.json", "web/yarn.lock", "go.sum", "vendor/x/y.go", "a/dist/b.js", "app.min.js", "api/foo.pb.go", ".github/gen/generated/x.ts"])
    assert.equal(isExcluded(p, DEFAULT_EXCLUDES), true, p);
  for (const p of ["src/index.ts", "docs/lock.md", "src/vendorish.ts", "lib/builder.py"])
    assert.equal(isExcluded(p, DEFAULT_EXCLUDES), false, p);
});
