import { buildApp } from "./app.js";
import { startScheduler } from "./services/scheduler.js";

async function start() {
  const app = await buildApp();

  // Close the server (and DB via the onClose hook) on termination signals.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully`);
      try {
        await app.close();
        process.exit(0);
      } catch (err) {
        app.log.error(err);
        process.exit(1);
      }
    });
  }

  // Best-effort: start the price-refresh scheduler BEFORE listen() so it can register
  // its onClose cleanup hook (addHook throws once the instance is listening). A
  // scheduler failure must never block the API from serving requests.
  try {
    await startScheduler(app);
  } catch (err) {
    app.log.error({ err }, "Price-refresh scheduler failed to start; continuing without it");
  }

  try {
    const address = await app.listen({
      port: app.config.PORT,
      host: "0.0.0.0",
    });
    app.log.info(`Server listening at ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start().catch((err) => {
  // buildApp() throwing (bad config, failed migration) rejects here before any in-function
  // try/catch can run — surface it and exit non-zero rather than dangling as an unhandled
  // rejection.
  console.error(err);
  process.exit(1);
});
