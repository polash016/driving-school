/**
 * pm2 process model (spec-14 topology, spec-19 worker). Kept in git so the process model is
 * reproducible and reviewable.
 *
 * IMPORTANT — this file is a reference, not what the VPS runs. The live copy is
 * `~/teoripro.ecosystem.config.cjs`, deliberately outside the app directory: a config inside the
 * working tree makes every `git pull` fail on an untracked-file collision. Keep the two in step by
 * hand, and set `interpreter` to the box's nvm node — a non-interactive shell has no `node` on
 * PATH, so pm2 cannot start either app without it.
 *
 * pm2 7.0.3 does NOT accept `startOrReload`/`startOrRestart` on a .cjs module (it expects JSON and
 * dies on `config.deploy`), and it only recognises a file as an ecosystem config if the NAME
 * matches its heuristic — hence the `.ecosystem.config.cjs` suffix on the server copy. Deploy with:
 *
 *   pm2 restart teoripro
 *   pm2 start ~/teoripro.ecosystem.config.cjs --only teoripro-i18n-worker
 *   pm2 save
 */
// Set to the absolute nvm node path on the target box; pm2 has no PATH in a non-interactive shell.
const NODE = process.env.PM2_NODE ?? undefined;
module.exports = {
  apps: [
    {
      name: "teoripro",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start --port 3020",
      ...(NODE ? { interpreter: NODE } : {}),
      exec_mode: "fork",
      autorestart: true,
      env: { NODE_ENV: "production" },
    },
    {
      name: "teoripro-i18n-worker",
      cwd: __dirname,
      // Run from TypeScript source via tsx (a devDependency — a --prod install breaks this).
      script: "scripts/i18n-worker.ts",
      ...(NODE ? { interpreter: NODE } : {}),
      interpreter_args: "--import tsx",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // Layer 5: a crash restarts with growing delay; the lease design makes any restart safe.
      exp_backoff_restart_delay: 2000,
      max_restarts: 50,
      // SIGTERM → finish the batch in flight. The in-flight provider call aborts within
      // milliseconds (signal threading), so this only needs to cover the DB writes after it.
      kill_timeout: 20000,
      env: { NODE_ENV: "production" },
    },
  ],
};
