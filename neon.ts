import { defineConfig } from "@neon/config/v1";

/**
 * Neon project steep-flower-23682200 (aws-eu-central-1, Frankfurt: next to the
 * Hetzner server in Nuremberg). The app uses Neon for Postgres only:
 * files live in Cloudflare R2 and the AI calls go to Anthropic / fal.ai
 * directly, so no AI gateway, buckets, auth or Data API are provisioned.
 */
export default defineConfig({
  auth: false,
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default (production) branch: project defaults.
      return {};
    }
    if (!branch.exists) {
      // New non-default branches auto-expire (`neon checkout <name>`).
      return { ttl: "7d" };
    }
    return {};
  },
});
