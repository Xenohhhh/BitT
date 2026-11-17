
#pragma once

#include <spdlog/spdlog.h>
#include <spdlog/sinks/stdout_sinks.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <ctime>
#include <iomanip>
#include <memory>
#include <sstream>
#include <string>

namespace EngineLogger {

using json = nlohmann::json;

inline std::shared_ptr<spdlog::logger> logger;

inline std::string getTimestamp() {
    const auto now = std::chrono::system_clock::now();
    const auto time = std::chrono::system_clock::to_time_t(now);

    const auto milliseconds =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch()
        ).count() % 1000;

    std::tm utcTime{};

#ifdef _WIN32
    gmtime_s(&utcTime, &time);
#else
    gmtime_r(&time, &utcTime);
#endif

    std::ostringstream timestamp;

    timestamp << std::put_time(
        &utcTime,
        "%Y-%m-%dT%H:%M:%S"
    );

    timestamp << '.'
              << std::setw(3)
              << std::setfill('0')
              << milliseconds
              << 'Z';

    return timestamp.str();
}

inline void initialize() {
    if (logger) return;

    logger = spdlog::stdout_logger_mt("bittorrent-engine");

    // Output only the JSON message, without spdlog's default prefix.
    logger->set_pattern("%v");

    logger->set_level(spdlog::level::debug);
    logger->flush_on(spdlog::level::info);
}

inline void log(
    spdlog::level::level_enum level,
    const std::string& component,
    const std::string& event,
    const std::string& message,
    const json& fields = json::object()
) {
    if (!logger) initialize();

    json entry = fields;

    entry["level"] = spdlog::level::to_string_view(level).data();
    entry["timestamp"] = getTimestamp();
    entry["service"] = "bittorrent-engine";
    entry["component"] = component;
    entry["event"] = event;
    entry["msg"] = message;

    logger->log(level, "{}", entry.dump());
}

inline void info(
    const std::string& component,
    const std::string& event,
    const std::string& message,
    const json& fields = json::object()
) {
    log(spdlog::level::info, component, event, message, fields);
}

inline void debug(
    const std::string& component,
    const std::string& event,
    const std::string& message,
    const json& fields = json::object()
) {
    log(spdlog::level::debug, component, event, message, fields);
}

inline void warn(
    const std::string& component,
    const std::string& event,
    const std::string& message,
    const json& fields = json::object()
) {
    log(spdlog::level::warn, component, event, message, fields);
}

inline void error(
    const std::string& component,
    const std::string& event,
    const std::string& message,
    const json& fields = json::object()
) {
    log(spdlog::level::err, component, event, message, fields);
}

}
