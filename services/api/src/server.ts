import { buildApp } from "./app.js";

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

start();
