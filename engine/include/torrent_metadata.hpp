#pragma once

#include <string>
#include <nlohmann/json.hpp>

nlohmann::json inspectTorrent(const std::string& torrentPath);