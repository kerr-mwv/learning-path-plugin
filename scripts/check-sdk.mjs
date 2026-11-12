/** Typecheck preflight: the LearnHarness plugin API types are not part of this
 * repository. Building and testing do not need them; `tsc` does. */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const types = fileURLToPath(new URL("../.sdk/index.d.ts", import.meta.url));
if (!fs.existsSync(types)) {
  console.error(
    "Typecheck needs the LearnHarness plugin API types at .sdk/index.d.ts.\n" +
      "Copy the `types` folder of the LearnHarness plugin SDK (0.6.0) to .sdk/ and run again.\n" +
      "Building (`npm run build`) and testing (`npm test`) work without it.",
  );
  process.exit(1);
}
