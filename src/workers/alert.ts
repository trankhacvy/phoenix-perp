import { alertWorker } from "../jobs/processors/alert.js";
import { logger } from "../lib/logger.js";

logger.info("Alert worker started");

process.on("SIGTERM", async () => {
  await alertWorker.close();
  process.exit(0);
});
