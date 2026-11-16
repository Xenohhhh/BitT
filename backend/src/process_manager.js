const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const ipcClient = require("./tcp_client");
const EventEmitter = require("events");

const processEvents = new EventEmitter();

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ENGINE_DIR = path.join(PROJECT_ROOT, "engine");

const ENGINE_EXECUTABLE = path.join(
  ENGINE_DIR,
  "build",
  "Release",
  "tcp_server.exe"
);

let engineProcess = null;
let processState = "STOPPED";

const STARTUP_TIMEOUT_MS = 10000;
const STARTUP_FORCE_KILL_MS = 2000;

const SHUTDOWN_TIMEOUT_MS = 7000;
const FORCE_KILL_TIMEOUT_MS = 2000;

let shutdownPromise = null;


function startEngine() {
  if (engineProcess !== null) {
    throw new Error(
      `Cannot start engine: process is ${processState}`
    );
  }

  const token = process.env.BITT_IPC_TOKEN;

  if (!token) {
    throw new Error(
      "BITT_IPC_TOKEN must be set before starting the engine"
    );
  }

  processState = "STARTING";

  const child = spawn(ENGINE_EXECUTABLE, [], {
    cwd: ENGINE_DIR,
    env: {
      ...process.env,
      BITT_IPC_TOKEN: token
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });

  engineProcess = child;

  return new Promise((resolve, reject) => {
    let startupSettled = false;
    let startupTimer;
    let forceKillTimer;

    function resolveStartup() {
      if (startupSettled) return;

      startupSettled = true;
      clearTimeout(startupTimer);

      resolve(child);
    }

    function rejectStartup(error) {
      if (startupSettled) return;

      startupSettled = true;
      clearTimeout(startupTimer);

      reject(error);
    }

    // Startup timeout.
    startupTimer = setTimeout(() => {
      if (startupSettled) return;

      const error = new Error(
        `C++ engine failed to become ready within ${STARTUP_TIMEOUT_MS}ms`
      );

      console.error(error.message);

      rejectStartup(error);
      processState = "STOPPING";

      const signalSent = child.kill("SIGTERM");

      if (!signalSent) {
        console.warn(
          "Could not send termination signal to unready engine"
        );
      }

      forceKillTimer = setTimeout(() => {
        if (engineProcess === child) {
          console.warn(
            "Unready engine did not terminate. Forcing termination."
          );

          child.kill("SIGKILL");
        }
      }, STARTUP_FORCE_KILL_MS);

    }, STARTUP_TIMEOUT_MS);

    // Capture stdout and detect readiness.
    const stdoutReader = readline.createInterface({
      input: child.stdout
    });

    stdoutReader.on("line", (line) => {
      console.log(`[C++ stdout] ${line}`);

      if (
        line.trim() === "ENGINE_READY" &&
        processState === "STARTING"
      ) {
        processState = "READY";

        console.log(
          "C++ engine is ready to accept connections"
        );

        resolveStartup();
      }
    });

    // Capture stderr.
    const stderrReader = readline.createInterface({
      input: child.stderr
    });

    stderrReader.on("line", (line) => {
      console.error(`[C++ stderr] ${line}`);
    });

    // Event 1: Process successfully created.
    child.once("spawn", () => {
      console.log(
        `C++ engine process created. PID: ${child.pid}`
      );
    });

    // Event 2: Process-related error.
    child.on("error", (err) => {
      console.error("C++ process error:", err.message);

      rejectStartup(err);
    });

    // Event 3: Process terminated.
    child.once("exit", (code, signal) => {
      console.log(
        `C++ engine exited. Exit code: ${code}, Signal: ${signal}`
      );

      const unexpectedExit = processState !== "STOPPING";

      if (unexpectedExit) {
        processState = "FAILED";

        const failure = {
          code,
          signal,
          pid: child.pid,
          message: "C++ engine terminated unexpectedly"
        };

        console.error(failure.message);

        // Immediately clean up IPC and reject pending requests.
        ipcClient.handleEngineCrash(
          new Error(failure.message)
        );

        // Notify the application layer.
        processEvents.emit("engineCrash", failure);

        rejectStartup(
          new Error(
            `C++ engine exited unexpectedly. Code: ${code}, Signal: ${signal}`
          )
        );
      }
    });

    // Event 4: Process and stdio streams closed.
    child.once("close", (code, signal) => {
      console.log(
        `C++ engine closed. Exit code: ${code}, Signal: ${signal}`
      );

      clearTimeout(forceKillTimer);

      if (engineProcess === child) {
        engineProcess = null;

        // Preserve FAILED after an unexpected exit.
        if (processState !== "FAILED") {
          processState = "STOPPED";
        }
      }

      rejectStartup(
        new Error("C++ engine closed before becoming ready")
      );
    });
  });
}



function stopEngine() {
  // Prevent multiple simultaneous shutdown operations.
  if (shutdownPromise) {
    return shutdownPromise;
  }

  const child = engineProcess;

  // Nothing to stop.
  if (!child) {
    processState = "STOPPED";
    return Promise.resolve();
  }

  // Application-level shutdown requires a ready engine.
  if (processState !== "READY") {
    return Promise.reject(
      new Error(
        `Cannot gracefully stop engine: process is ${processState}`
      )
    );
  }

  processState = "STOPPING";

  shutdownPromise = (async () => {
    let forceKillTimer;
    let finalTimer;

    // Register close listener before requesting shutdown.
    const closePromise = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    });

    // Force termination if graceful shutdown takes too long.
    const forceKillPromise = new Promise((resolve, reject) => {
      forceKillTimer = setTimeout(() => {
        if (engineProcess !== child) {
          resolve(null);
          return;
        }

        console.warn(
          "Engine did not close in time. Forcing termination..."
        );

        try {
          child.kill("SIGKILL");
        } catch (err) {
          console.error(
            "Force termination failed:",
            err.message
          );
        }

        finalTimer = setTimeout(() => {
          reject(
            new Error(
              "Engine failed to close after forced termination"
            )
          );
        }, FORCE_KILL_TIMEOUT_MS);

      }, SHUTDOWN_TIMEOUT_MS);
    });

    try {
      // Connect to the running engine.
      await ipcClient.connectToEngine();

      // Request application-level shutdown.
      const response = await ipcClient.shutdownEngine();

      if (!response || response.success !== true) {
        throw new Error(
          "C++ engine did not acknowledge shutdown"
        );
      }

      console.log(
        "C++ engine accepted shutdown request"
      );

    } catch (err) {
      console.error(
        "Graceful shutdown request failed:",
        err.message
      );

      // Fall back to OS-level termination.
      if (engineProcess === child) {
        child.kill("SIGTERM");
      }
    }

    try {
      // Wait for process closure or forced termination timeout.
      const result = await Promise.race([
        closePromise,
        forceKillPromise
      ]);

      if (!result) {
        throw new Error(
          "Engine process reference was cleared unexpectedly"
        );
      }

      console.log("Engine shutdown completed");

      return result;

    } finally {
      clearTimeout(forceKillTimer);
      clearTimeout(finalTimer);
    }

  })().finally(async () => {
    // Always clean up the IPC connection.
    try {
      await ipcClient.disconnect();
    } catch (err) {
      console.error(
        "IPC connection cleanup failed:",
        err.message
      );
    }

    shutdownPromise = null;
  });

  return shutdownPromise;
}


function isEngineRunning() {
  return processState === "READY";
}

function getEngineProcess() {
  return engineProcess;
}

function getProcessState() {
  return processState;
}

function onEngineCrash(callback) {
  processEvents.on("engineCrash", callback);

  return () => {
    processEvents.off("engineCrash", callback);
  };
}

module.exports = {
  startEngine,
  stopEngine,
  isEngineRunning,
  getEngineProcess,
  getProcessState,
  onEngineCrash
};
