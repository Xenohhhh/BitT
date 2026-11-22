
#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

#include <libtorrent/session.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <nlohmann/json.hpp>

namespace lt = libtorrent;

// Result returned when adding a torrent.
struct AddTorrentResult
{
    lt::torrent_handle handle;
    bool added;
};

class TorrentManager
{
public:
    TorrentManager();

    AddTorrentResult addTorrent(
        const std::string& torrentPath,
        const std::string& savePath
    );

    nlohmann::json getTorrentStatus(std::uint32_t torrentId) const;

    void pauseTorrent(std::uint32_t torrentId);
    void resumeTorrent(std::uint32_t torrentId);
    void removeTorrent(std::uint32_t torrentId);

private:
    lt::torrent_handle findTorrent(std::uint32_t torrentId) const;

    lt::session session_;

    // Engine ID -> torrent handle.
    std::unordered_map<std::uint32_t, lt::torrent_handle> torrents_;

    // Info hash -> engine ID.
    // Separate prefixes allow v1 and v2 hashes to be checked independently.
    std::unordered_map<std::string, std::uint32_t> infoHashToTorrentId_;

    // Engine ID -> all info-hash keys belonging to that torrent.
    std::unordered_map<std::uint32_t, std::vector<std::string>> torrentHashKeys_;
};
