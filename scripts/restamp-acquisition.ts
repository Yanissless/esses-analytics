/**
 * Re-derive customers.acquisition_channel from existing touchpoints.
 * Useful after changing channel classification rules, without a full re-sync.
 *
 *   run.cmd restamp
 */
import "dotenv/config";
import { stampAcquisitionChannels } from "../src/attribution/ingest";

stampAcquisitionChannels()
  .then((n) => {
    console.log(`Acquisition channels stamped: ${n} customer(s) updated.`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
