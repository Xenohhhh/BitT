import app from "./app.js";
import {
  initializeEngine,
  shutdownEngine
} from "./engine/engine.client.js";

const PORT = Number(process.env.PORT) || 3000;

let server: ReturnType<typeof app.listen> | null = null;
let isShuttingDown = false;

async function startServer(): Promise<void> {
  try {
    // Start the C++ engine and verify authenticated IPC communication.
    await initializeEngine();

    console.log("C++ engine initialized successfully");

    // Start accepting HTTP requests only after engine initialization.
    server = app.listen(PORT, () => {
      console.log(`Backend listening on port ${PORT}`);
    });
  } catch (error) {
    console.error("Backend startup failed:", error);
    process.exitCode = 1;
  }
}

async function stopServer(signal: string): Promise<void> {
  if (isShuttingDown) return;

  isShuttingDown = true;
  console.log(`${signal} received. Shutting down backend...`);

  try {
    // Stop accepting new HTTP connections.
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    // Gracefully stop the C++ engine.
    await shutdownEngine();

    console.log("Backend shutdown completed");
  } catch (error) {
    console.error("Backend shutdown failed:", error);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => {
  void stopServer("SIGINT");
});

process.on("SIGTERM", () => {
  void stopServer("SIGTERM");
});

void startServer();
