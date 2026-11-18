
import processManager from "./process_manager.js";
import ipcClient from "./tcp_client.js";

type EngineStatus = {
  status: string;
  [key: string]: unknown;
};

let initialized = false;

// Start the C++ engine and establish authenticated IPC communication.
export async function initializeEngine(): Promise<void> {
  if (
    processManager.isEngineRunning() &&
    ipcClient.getConnectionState() === "CONNECTED"
  ) {
    return;
  }

  try {
    await processManager.startEngine();

    await ipcClient.connectToEngine();

    const response: unknown = await ipcClient.sendRequest("get_status");

    if (
      typeof response !== "object" ||
      response === null ||
      !("status" in response) ||
      response.status !== "UP"
    ) {
      throw new Error("Engine health check failed");
    }

    initialized = true;
  } catch (error) {
    initialized = false;

    try {
      if (processManager.getProcessState() === "READY") {
        await processManager.stopEngine();
      } else {
        await ipcClient.disconnect();
      }
    } catch {
      // Preserve the original initialization error.
    }

    throw error;
  }
}

// Gracefully stop the C++ engine.
export async function shutdownEngine(): Promise<void> {
  try {
    await processManager.stopEngine();
  } finally {
    initialized = false;
  }
}

// Check whether the engine is initialized.
export function isEngineInitialized(): boolean {
  return initialized;
}

// Get the current engine process state.
export function getEngineState(): string {
  return processManager.getProcessState();
}

// Get engine status through IPC.
export async function getEngineStatus(): Promise<EngineStatus> {
  if (!initialized) {
    throw new Error("Engine is not initialized");
  }

  const response: unknown = await ipcClient.sendRequest("get_status");

  if (
    typeof response !== "object" ||
    response === null ||
    !("status" in response) ||
    typeof response.status !== "string"
  ) {
    throw new Error("Invalid engine status response");
  }

  return response as EngineStatus;
}

// Forward additional requests to the C++ engine.
export async function sendEngineRequest(
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!initialized) {
    throw new Error("Engine is not initialized");
  }

  return ipcClient.sendRequest(method, params);
}

// Forward engine lifecycle events.
export function onEngineCrash(callback: (failure: unknown) => void) {
  return processManager.onEngineCrash(callback);
}

export function onEngineRecovered(callback: (event: unknown) => void) {
  return processManager.onEngineRecovered(callback);
}

export function onEngineRestartFailed(callback: (error: unknown) => void) {
  return processManager.onEngineRestartFailed(callback);
}

// Keep the initialization state synchronized with engine lifecycle events.
processManager.onEngineCrash(() => {
  initialized = false;
});

processManager.onEngineRecovered(() => {
  initialized = true;
});

processManager.onEngineRestartFailed(() => {
  initialized = false;
});