#include "torrent_manager.hpp"

#include <stdexcept>
#include <utility>

#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/load_torrent.hpp>
#include <libtorrent/torrent_status.hpp>

TorrentManager::TorrentManager()
    : session_()
{
}

lt::torrent_handle TorrentManager::addTorrent(
    const std::string& torrentPath,
    const std::string& savePath)
{
    lt::error_code ec;

    // 1. Load torrent file.
    lt::add_torrent_params params =
        lt::load_torrent_file(
            torrentPath,
            ec,
            lt::load_torrent_limits{});

    if (ec)
    {
        throw std::runtime_error(
            "Failed to load torrent: " + ec.message());
    }

    // 2. Validate metadata.
    if (!params.ti)
    {
        throw std::runtime_error(
            "Torrent metadata is unavailable");
    }

    // 3. Configure download location.
    params.save_path = savePath;

    // 4. Add torrent in paused state.
    params.flags |= lt::torrent_flags::paused;

    // 5. Add torrent to the existing session.
    lt::torrent_handle handle =
        session_.add_torrent(std::move(params), ec);

    if (ec)
    {
        throw std::runtime_error(
            "Failed to add torrent: " + ec.message());
    }

    // Keep the ID's 32-bit bit pattern consistently as an unsigned value.
    const std::uint32_t torrentId =
        static_cast<std::uint32_t>(handle.id());

    torrents_.emplace(torrentId, handle);

    return handle;
}

// Find a torrent using its unsigned 32-bit ID.
lt::torrent_handle TorrentManager::findTorrent(
    std::uint32_t torrentId) const
{
    auto it = torrents_.find(torrentId);

    if (it == torrents_.end())
    {
        throw std::runtime_error("Torrent not found");
    }

    if (!it->second.is_valid())
    {
        throw std::runtime_error("Invalid torrent handle");
    }

    return it->second;
}

nlohmann::json TorrentManager::getTorrentStatus(
    std::uint32_t torrentId) const
{
    // 1. Find the torrent.
    lt::torrent_handle handle = findTorrent(torrentId);

    // 2. Retrieve its current status.
    lt::torrent_status status = handle.status();

    // 3. Convert libtorrent state into a readable string.
    std::string state;

    switch (status.state)
    {
        case lt::torrent_status::checking_files:
            state = "checking_files";
            break;

        case lt::torrent_status::downloading_metadata:
            state = "downloading_metadata";
            break;

        case lt::torrent_status::downloading:
            state = "downloading";
            break;

        case lt::torrent_status::finished:
            state = "finished";
            break;

        case lt::torrent_status::seeding:
            state = "seeding";
            break;

        case lt::torrent_status::checking_resume_data:
            state = "checking_resume_data";
            break;

        default:
            state = "unknown";
            break;
    }

    // 4. Check whether the torrent is paused.
    const bool paused =
        (status.flags & lt::torrent_flags::paused) != lt::torrent_flags_t{};

    // 5. Return structured status with the same unsigned ID.
    return {
        {"torrentId", torrentId},
        {"name", status.name},
        {"state", state},
        {"paused", paused},
        {"progress", status.progress},
        {"downloaded", status.total_done},
        {"total", status.total},
        {"connectedPeers", status.num_peers}
    };
}

// Pause an existing torrent.
void TorrentManager::pauseTorrent(std::uint32_t torrentId)
{
    lt::torrent_handle handle = findTorrent(torrentId);
    handle.pause();
}

// Resume an existing torrent.
void TorrentManager::resumeTorrent(std::uint32_t torrentId)
{
    lt::torrent_handle handle = findTorrent(torrentId);
    handle.resume();
}

// Remove a torrent from the session.
void TorrentManager::removeTorrent(std::uint32_t torrentId)
{
    auto it = torrents_.find(torrentId);

    if (it == torrents_.end())
    {
        throw std::runtime_error("Torrent not found");
    }

    session_.remove_torrent(it->second);
    torrents_.erase(it);
}
