
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const EventEmitter = require("events");

const ipcClient = require("./tcp_client");

const { createComponentLogger } = require("./observability/logger");

const log = createComponentLogger("process-manager");
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

      log.error(
        {
          event: "engine_startup_timeout",
          pid: child.pid,
          timeout_ms: STARTUP_TIMEOUT_MS
        },
        error.message
      );

      rejectStartup(error);
      processState = "STOPPING";

      const signalSent = child.kill("SIGTERM");

      if (!signalSent) {
        log.warn(
          {
            event: "engine_termination_signal_failed",
            pid: child.pid,
            signal: "SIGTERM"
          },
          "Could not send termination signal to unready engine"
        );
      }

      forceKillTimer = setTimeout(() => {
        if (engineProcess === child) {
          log.warn(
            {
              event: "engine_startup_force_kill",
              pid: child.pid,
              timeout_ms: STARTUP_FORCE_KILL_MS
            },
            "Unready engine did not terminate. Forcing termination"
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
      // Preserve the original engine output as structured logs.
      log.info(
        {
          event: "engine_stdout",
          pid: child.pid,
          output: line
        },
        "C++ engine output"
      );

      if (
        line.trim() === "ENGINE_READY" &&
        processState === "STARTING"
      ) {
        processState = "READY";

        log.info(
          {
            event: "engine_ready",
            pid: child.pid
          },
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
      log.error(
        {
          event: "engine_stderr",
          pid: child.pid,
          output: line
        },
        "C++ engine error output"
      );
    });

    // Event 1: Process successfully created.
    child.once("spawn", () => {
      log.info(
        {
          event: "engine_process_created",
          pid: child.pid,
          executable: ENGINE_EXECUTABLE
        },
        "C++ engine process created"
      );
    });

    // Event 2: Process-related error.
    child.on("error", (err) => {
      log.error(
        {
          event: "engine_process_error",
          pid: child.pid,
          err
        },
        "C++ process error"
      );

      rejectStartup(err);
    });

    // Event 3: Process terminated.
    child.once("exit", (code, signal) => {
      log.info(
        {
          event: "engine_process_exit",
          pid: child.pid,
          exit_code: code,
          signal
        },
        "C++ engine process exited"
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

        log.error(
          {
            event: "engine_crash",
            ...failure
          },
          failure.message
        );

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
      log.info(
        {
          event: "engine_process_closed",
          pid: child.pid,
          exit_code: code,
          signal
        },
        "C++ engine process and stdio streams closed"
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

  log.info(
    {
      event: "engine_shutdown_started",
      pid: child.pid
    },
    "Engine shutdown initiated"
  );

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

        log.warn(
          {
            event: "engine_force_kill",
            pid: child.pid,
            timeout_ms: SHUTDOWN_TIMEOUT_MS
          },
          "Engine did not close in time. Forcing termination"
        );

        try {
          child.kill("SIGKILL");
        } catch (err) {
          log.error(
            {
              event: "engine_force_kill_failed",
              pid: child.pid,
              err
            },
            "Force termination failed"
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

      log.info(
        {
          event: "engine_shutdown_acknowledged",
          pid: child.pid
        },
        "C++ engine accepted shutdown request"
      );

    } catch (err) {
      log.error(
        {
          event: "graceful_shutdown_failed",
          pid: child.pid,
          err
        },
        "Graceful shutdown request failed"
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

      log.info(
        {
          event: "engine_shutdown_completed",
          pid: child.pid,
          exit_code: result.code,
          signal: result.signal
        },
        "Engine shutdown completed"
      );

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
      log.error(
        {
          event: "ipc_cleanup_failed",
          err
        },
        "IPC connection cleanup failed"
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
