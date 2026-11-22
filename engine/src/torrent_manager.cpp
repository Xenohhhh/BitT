
#include "torrent_manager.hpp"

#include <sstream>
#include <stdexcept>
#include <utility>
#include <vector>

#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/load_torrent.hpp>
#include <libtorrent/torrent_status.hpp>

namespace
{
    // Generate separate lookup keys for v1 and v2 hashes.
    // Prefixes prevent hashes of different types from colliding.
    std::vector<std::string> getInfoHashKeys(
        const lt::torrent_info& torrentInfo)
    {
        const auto hashes = torrentInfo.info_hashes();

        std::vector<std::string> keys;

        if (!hashes.v1.is_all_zeros())
        {
            std::ostringstream stream;
            stream << hashes.v1;

            keys.push_back("v1:" + stream.str());
        }

        if (!hashes.v2.is_all_zeros())
        {
            std::ostringstream stream;
            stream << hashes.v2;

            keys.push_back("v2:" + stream.str());
        }

        if (keys.empty())
        {
            throw std::runtime_error(
                "Torrent does not contain a valid info hash");
        }

        return keys;
    }
}

TorrentManager::TorrentManager()
    : session_()
{
}

AddTorrentResult TorrentManager::addTorrent(
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

    // 3. Generate info-hash lookup keys before moving params.
    const std::vector<std::string> hashKeys =
        getInfoHashKeys(*params.ti);

    // 4. Check whether this torrent is already managed.
    for (const auto& key : hashKeys)
    {
        auto existing = infoHashToTorrentId_.find(key);

        if (existing == infoHashToTorrentId_.end())
        {
            continue;
        }

        const std::uint32_t existingId = existing->second;

        auto torrent = torrents_.find(existingId);

        if (torrent != torrents_.end() &&
            torrent->second.is_valid())
        {
            // Return the existing handle without adding another torrent.
            return {
                torrent->second,
                false
            };
        }

        // Remove stale lookup entries if their handle no longer exists.
        infoHashToTorrentId_.erase(existing);
    }

    // 5. Configure download location.
    params.save_path = savePath;

    // 6. Disable automatic torrent management.
    params.flags &= ~lt::torrent_flags::auto_managed;

    // 7. Add torrent in paused state.
    params.flags |= lt::torrent_flags::paused;

    // 8. Add torrent to the existing session.
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

    // 9. Register the new handle.
    torrents_.emplace(torrentId, handle);

    // 10. Register its info hashes.
    for (const auto& key : hashKeys)
    {
        infoHashToTorrentId_[key] = torrentId;
    }

    torrentHashKeys_[torrentId] = hashKeys;

    return {
        handle,
        true
    };
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

    // Remove its info-hash lookup entries.
    auto hashKeys = torrentHashKeys_.find(torrentId);

    if (hashKeys != torrentHashKeys_.end())
    {
        for (const auto& key : hashKeys->second)
        {
            auto hashEntry = infoHashToTorrentId_.find(key);

            if (hashEntry != infoHashToTorrentId_.end() &&
                hashEntry->second == torrentId)
            {
                infoHashToTorrentId_.erase(hashEntry);
            }
        }

        torrentHashKeys_.erase(hashKeys);
    }

    torrents_.erase(it);
}
