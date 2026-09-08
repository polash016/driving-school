/**
 * pm2 process model for the VPS (spec-14 topology, spec-19 worker). Kept in git so a deploy is
 * reproducible; the VPS keeps its own copy too (decision 2026-09-08) — reconcile on deploy.
 *
 *   pm2 startOrReload ecosystem.config.cjs --update-env
 */
module.exports = {
  apps: [
    {
      name: "teoripro",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start --port 3020 --hostname 127.0.0.1",
      exec_mode: "fork",
      autorestart: true,
      env: { NODE_ENV: "production" },
    },
    {
      name: "teoripro-i18n-worker",
      cwd: __dirname,
      script: "node_modules/.bin/tsx",
      args: "scripts/i18n-worker.ts",
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
