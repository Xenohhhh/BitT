
#include "torrent_metadata.hpp"
#include <sstream>
#include <iostream>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/file_storage.hpp>
#include <libtorrent/load_torrent.hpp>

namespace lt = libtorrent;
using json = nlohmann::json;

json inspectTorrent(const std::string &torrentPath)
{
    lt::error_code ec;

    // Load and parse the .torrent file.
    lt::add_torrent_params params =
        lt::load_torrent_file(
            torrentPath,
            ec,
            lt::load_torrent_limits{});

    if (ec)
    {
        return {
            {"success", false},
            {"error", ec.message()}};
    }

    if (!params.ti)
    {
        return {
            {"success", false},
            {"error", "Torrent metadata unavailable"}};
    }

    const lt::torrent_info &ti = *params.ti;

    // Extract torrent identity.
    const auto hashes = ti.info_hashes();

    json infoHashes = json::object();

    if (!hashes.v1.is_all_zeros())
    {
        std::ostringstream v1Stream;
        v1Stream << hashes.v1;
        infoHashes["v1"] = v1Stream.str();
    }

    if (!hashes.v2.is_all_zeros())
    {
        std::ostringstream v2Stream;
        v2Stream << hashes.v2;
        infoHashes["v2"] = v2Stream.str();
    }

    // Extract general metadata.
    json metadata;

    metadata["name"] = ti.name();
    metadata["totalSize"] = ti.total_size();
    metadata["pieceCount"] = ti.num_pieces();
    metadata["pieceLength"] = ti.piece_length();
    metadata["infoHashes"] = infoHashes;

    // Extract file information.
    const lt::file_storage &fs = ti.layout();

    metadata["fileCount"] = fs.num_files();
    metadata["files"] = json::array();

    for (auto const fileIndex : fs.file_range())
    {
        json file;

        file["path"] = fs.file_path(fileIndex);
        file["size"] = fs.file_size(fileIndex);

        metadata["files"].push_back(file);
    }

    return {
        {"success", true},
        {"metadata", metadata}};
}
