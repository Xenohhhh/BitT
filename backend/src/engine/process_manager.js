const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const EventEmitter = require("events");

const ipcClient = require("./tcp_client");
const { createComponentLogger } = require("../observability/logger");

const log = createComponentLogger("process-manager");
const processEvents = new EventEmitter();

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ENGINE_DIR = path.join(PROJECT_ROOT, "engine");

const ENGINE_EXECUTABLE =
  process.env.ENGINE_EXECUTABLE_PATH ||
  path.join(
    ENGINE_DIR,
    "build-observability",
    "Release",
    "tcp_server.exe"
  );

// Process state
let engineProcess = null;
let processState = "STOPPED";

// Startup configuration
const STARTUP_TIMEOUT_MS = 10000;
const STARTUP_FORCE_KILL_MS = 2000;

// Shutdown configuration
const SHUTDOWN_TIMEOUT_MS = 7000;
const FORCE_KILL_TIMEOUT_MS = 2000;

// Automatic restart configuration
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAYS_MS = [1000, 2000, 4000];
const STABLE_RUNTIME_MS = 60000;

let restartAttempts = 0;
let restartPromise = null;
let restartCancelled = false;
let stableRuntimeTimer = null;

let shutdownPromise = null;

// Utility: delay
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearStableRuntimeTimer() {
  if (stableRuntimeTimer !== null) {
    clearTimeout(stableRuntimeTimer);
    stableRuntimeTimer = null;
  }
}

// Terminate a child process and wait for its close event.
// Force-kill it if graceful termination takes too long.
function terminateChildAndWait(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let settled = false;
    let forceKillTimer;
    let finalTimer;

    const cleanup = () => {
      clearTimeout(forceKillTimer);
      clearTimeout(finalTimer);
      child.off("close", handleClose);
    };

    const finish = (error = null) => {
      if (settled) return;

      settled = true;
      cleanup();

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const handleClose = () => finish();

    child.once("close", handleClose);

    child.kill("SIGTERM");

    forceKillTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }

      child.kill("SIGKILL");

      finalTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          finish(
            new Error(
              "Engine process did not close after forced termination"
            )
          );
          return;
        }

        finish();
      }, FORCE_KILL_TIMEOUT_MS);
    }, STARTUP_FORCE_KILL_MS);
  });
}

// Start the C++ engine and wait for ENGINE_READY.
function startEngine({ automatic = false } = {}) {
  if (engineProcess !== null) {
    throw new Error(
      `Cannot start engine: process is ${processState}`
    );
  }

  // A manual start begins a fresh lifecycle.
  if (!automatic) {
    restartCancelled = false;
    restartAttempts = 0;
    clearStableRuntimeTimer();
  }

  const token = process.env.BITT_IPC_TOKEN;

  if (!token) {
    throw new Error(
      "BITT_IPC_TOKEN must be set before starting the engine"
    );
  }

  processState = "STARTING";

  log.info(
    {
      event: "engine_starting",
      executable: ENGINE_EXECUTABLE
    },
    "Starting C++ engine"
  );

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

      child.kill("SIGTERM");

      forceKillTimer = setTimeout(() => {
        if (engineProcess === child) {
          log.warn(
            {
              event: "engine_startup_force_kill",
              pid: child.pid
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

    // Process successfully created.
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

    // Process-related error.
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

    // Process terminated.
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

      const unexpectedExit =
        processState !== "STOPPING" &&
        !restartCancelled;

      if (unexpectedExit) {
        clearStableRuntimeTimer();
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

        ipcClient.handleEngineCrash(
          new Error(failure.message)
        );

        processEvents.emit("engineCrash", failure);
      }

      rejectStartup(
        new Error(
          `C++ engine exited. Code: ${code}, Signal: ${signal}`
        )
      );
    });

    // Process and stdio streams closed.
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

        if (processState !== "FAILED") {
          processState = "STOPPED";
        }
      }

      rejectStartup(
        new Error("C++ engine closed before becoming ready")
      );

      // Start recovery only after the old process has fully closed.
      if (
        processState === "FAILED" &&
        !restartCancelled &&
        !shutdownPromise
      ) {
        scheduleAutomaticRestart();
      }
    });
  });
}

// Schedule automatic engine recovery.
function scheduleAutomaticRestart() {
  // Prevent multiple simultaneous restart sequences.
  if (restartPromise || restartCancelled || shutdownPromise) {
    return restartPromise;
  }

  restartPromise = recoverEngine()
    .catch((err) => {
      log.error(
        {
          event: "engine_recovery_failed",
          err
        },
        "Automatic engine recovery failed"
      );

      processState = "FAILED";

      processEvents.emit("engineRestartFailed", err);
    })
    .finally(() => {
      restartPromise = null;
    });

  return restartPromise;
}

// Restart engine with bounded retries.
async function recoverEngine() {
  log.warn(
    {
      event: "engine_recovery_started",
      max_attempts: MAX_RESTART_ATTEMPTS
    },
    "Starting automatic engine recovery"
  );

  while (
    restartAttempts < MAX_RESTART_ATTEMPTS &&
    !restartCancelled &&
    !shutdownPromise
  ) {
    const attempt = restartAttempts + 1;
    const waitMs = RESTART_DELAYS_MS[restartAttempts];

    restartAttempts++;

    log.info(
      {
        event: "engine_restart_scheduled",
        attempt,
        max_attempts: MAX_RESTART_ATTEMPTS,
        delay_ms: waitMs
      },
      "Scheduling engine restart"
    );

    await delay(waitMs);

    if (restartCancelled || shutdownPromise) {
      return;
    }

    try {
      // Start a new engine process and wait for ENGINE_READY.
      await startEngine({ automatic: true });

      if (restartCancelled || shutdownPromise) {
        return;
      }

      // Reconnect to the new engine.
      await ipcClient.connectToEngine();

      // Verify authenticated IPC communication.
      const response = await ipcClient.sendRequest("get_status");

      if (!response || response.status !== "UP") {
        throw new Error(
          "Engine restarted but health verification failed"
        );
      }

      log.info(
        {
          event: "engine_recovery_completed",
          attempt,
          pid: engineProcess?.pid
        },
        "Engine recovered and IPC connection restored"
      );

      processEvents.emit("engineRecovered", {
        attempt,
        pid: engineProcess?.pid
      });

      // Reset retry counter only if this same engine remains READY.
      clearStableRuntimeTimer();

      const recoveredChild = engineProcess;

      stableRuntimeTimer = setTimeout(() => {
        stableRuntimeTimer = null;

        if (
          processState !== "READY" ||
          engineProcess !== recoveredChild ||
          restartCancelled
        ) {
          log.debug(
            {
              event: "engine_restart_counter_reset_skipped",
              process_state: processState
            },
            "Stable runtime reset skipped because engine is no longer active"
          );
          return;
        }

        restartAttempts = 0;

        log.info(
          {
            event: "engine_restart_counter_reset",
            stable_runtime_ms: STABLE_RUNTIME_MS
          },
          "Engine remained stable. Restart counter reset"
        );
      }, STABLE_RUNTIME_MS);

      return;

    } catch (err) {
      log.error(
        {
          event: "engine_restart_attempt_failed",
          attempt,
          max_attempts: MAX_RESTART_ATTEMPTS,
          err
        },
        "Engine restart attempt failed"
      );

      // Ensure a partially started process is terminated before retrying.
      const failedChild = engineProcess;

      if (failedChild) {
        processState = "STOPPING";

        try {
          await terminateChildAndWait(failedChild);
        } catch (cleanupError) {
          log.error(
            {
              event: "restart_process_cleanup_failed",
              pid: failedChild.pid,
              err: cleanupError
            },
            "Could not confirm engine process termination"
          );

          throw cleanupError;
        }

        if (engineProcess === failedChild) {
          engineProcess = null;
        }
      }

      try {
        await ipcClient.disconnect();
      } catch (disconnectError) {
        log.warn(
          {
            event: "restart_ipc_cleanup_failed",
            err: disconnectError
          },
          "IPC cleanup after restart failure failed"
        );
      }

      processState = "FAILED";
    }
  }

  if (!restartCancelled && !shutdownPromise) {
    processState = "FAILED";

    const error = new Error(
      `Engine recovery exhausted ${MAX_RESTART_ATTEMPTS} attempts`
    );

    log.error(
      {
        event: "engine_restart_exhausted",
        attempts: restartAttempts
      },
      error.message
    );

    processEvents.emit("engineRestartFailed", error);
  }
}

// Gracefully stop the engine.
function stopEngine() {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  // Cancel any pending automatic recovery.
  restartCancelled = true;
  clearStableRuntimeTimer();

  const child = engineProcess;

  if (!child) {
    processState = "STOPPED";
    return Promise.resolve();
  }

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

    const closePromise = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    });

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

        child.kill("SIGKILL");

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
      await ipcClient.connectToEngine();

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

      if (engineProcess === child) {
        child.kill("SIGTERM");
      }
    }

    try {
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

      processState = "STOPPED";

      return result;

    } finally {
      clearTimeout(forceKillTimer);
      clearTimeout(finalTimer);
    }

  })().finally(async () => {
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

// State and process accessors.
function isEngineRunning() {
  return processState === "READY";
}

function getEngineProcess() {
  return engineProcess;
}

function getProcessState() {
  return processState;
}

function getRestartAttempts() {
  return restartAttempts;
}

// Event listeners.
function onEngineCrash(callback) {
  processEvents.on("engineCrash", callback);

  return () => {
    processEvents.off("engineCrash", callback);
  };
}

function onEngineRecovered(callback) {
  processEvents.on("engineRecovered", callback);

  return () => {
    processEvents.off("engineRecovered", callback);
  };
}

function onEngineRestartFailed(callback) {
  processEvents.on("engineRestartFailed", callback);

  return () => {
    processEvents.off("engineRestartFailed", callback);
  };
}

module.exports = {
  startEngine,
  stopEngine,
  isEngineRunning,
  getEngineProcess,
  getProcessState,
  getRestartAttempts,
  onEngineCrash,
  onEngineRecovered,
  onEngineRestartFailed
};
