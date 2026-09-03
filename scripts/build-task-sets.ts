import { taskSetService } from "@/server/services/task-sets";
import { schoolConfig } from "../config/school.config";

/**
 * Build (and optionally publish) the task sets from the CLI — `pnpm tasksets:build`.
 *
 * The admin screen at `/admin/task-sets` is the normal path; this exists for the same reason the
 * other data scripts do: a fresh deployment needs to get from "the bank is seeded" to "a student
 * can sit set #1" without a browser, and a build is worth being able to inspect in a terminal
 * before anyone publishes it.
 *
 *   pnpm tasksets:build            # propose sets, print the composition, publish nothing
 *   pnpm tasksets:build --publish  # propose and publish in one go
 *   pnpm tasksets:build --class BE
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const publish = args.includes("--publish");
  const classFlag = args.indexOf("--class");
  const licenseClassCode =
    classFlag >= 0 && args[classFlag + 1]
      ? args[classFlag + 1]
      : schoolConfig.licenseClassSeeds[0].code;

  const built = await taskSetService.build({ licenseClassCode }, null);

  console.log(
    `\n${built.sets.length} sets proposed for class ${licenseClassCode} — ` +
      `${built.itemsPlaced} questions placed, ${built.orphaned.length} orphaned\n`,
  );
  console.log(
    "  set   pool  paper  pass  topics  with-picture  avg-difficulty",
  );
  for (const set of built.sets) {
    const visual =
      (set.composition.typeCounts.IMAGE ?? 0) +
      (set.composition.typeCounts.SIGN ?? 0);
    console.log(
      `  #${String(set.number).padEnd(4)}` +
        `${String(set.poolSize).padStart(4)}` +
        `${String(set.paperSize).padStart(7)}` +
        `${String(set.passMark).padStart(6)}` +
        `${String(Object.keys(set.composition.topicCounts).length).padStart(8)}` +
        `${String(visual).padStart(14)}` +
        `${set.composition.avgDifficulty.toFixed(1).padStart(16)}` +
        (set.composition.warnings.length > 0
          ? `   ⚠ ${set.composition.warnings.join(", ")}`
          : ""),
    );
  }

  if (!publish) {
    console.log(
      `\nNothing published. Review at /admin/task-sets, or re-run with --publish.\n`,
    );
    return;
  }

  await taskSetService.publish({ buildId: built.buildId });
  console.log(`\nPublished ${built.sets.length} sets.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
