#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>

#include <libtorrent/session.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <nlohmann/json.hpp>

namespace lt = libtorrent;

class TorrentManager
{
public:
    TorrentManager();

    lt::torrent_handle addTorrent(
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
    std::unordered_map<std::uint32_t, lt::torrent_handle> torrents_;
};
