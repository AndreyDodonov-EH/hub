import { test } from "node:test";
import { accessSync, constants, readFileSync } from "node:fs";

// `hub` on the PATH is a link to the file itself: without the bit, "Permission denied"
test("what `hub` links to is executable", () => {
  const { bin } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const file of Object.values(bin)) accessSync(new URL(`../${file}`, import.meta.url), constants.X_OK);
});
