const pino = require("pino");

const SERVICE_NAME = "bittorrent-backend";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",

  // Consistent application metadata.
  base: {
    service: SERVICE_NAME
  },

  // Human-readable ISO timestamps.
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,

  // Use textual log levels instead of numeric values.
  formatters: {
    level(label) {
      return { level: label };
    }
  },

  // Never expose sensitive information in logs.
  redact: {
    paths: [
      "token",
      "*.token",
      "password",
      "*.password",
      "secret",
      "*.secret",
      "authorization",
      "*.authorization",
      "BITT_IPC_TOKEN"
    ],
    censor: "[REDACTED]"
  }
});

// Create component-specific child loggers.
function createComponentLogger(component) {
  return logger.child({ component });
}

module.exports = {
  logger,
  createComponentLogger
};
