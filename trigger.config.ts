import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Your Trigger.dev project ref — find it at cloud.trigger.dev → your project → Project settings.
  // (Not a secret; it just tells the CLI which project to deploy to.)
  project: "proj_voemmaqyyigtejyanjci",
  runtime: "node",
  logLevel: "log",
  // Max seconds any single run may use. Waiting on child runs doesn't count.
  maxDuration: 900,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 2000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./src/trigger"],
});
