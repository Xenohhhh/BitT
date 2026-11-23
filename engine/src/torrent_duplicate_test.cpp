
#include <iostream>
#include <filesystem>
#include <stdexcept>
#include <cstdint>

#include "torrent_manager.hpp"

int main()
{
    try
    {
        std::cout << "Creating TorrentManager...\n";

        TorrentManager manager;

        std::filesystem::create_directories("./test-downloads");

        const std::string torrentPath = "./test-data/ubuntu.torrent";
        const std::string savePath = "./test-downloads";

        // First addition
        std::cout << "\nFirst addTorrent() call...\n";

        AddTorrentResult first = manager.addTorrent(
            torrentPath,
            savePath
        );

        const std::uint32_t firstId =
            static_cast<std::uint32_t>(first.handle.id());

        std::cout << "Added: " << std::boolalpha
                  << first.added << '\n';

        std::cout << "Torrent ID: " << firstId << '\n';

        if (!first.added)
        {
            throw std::runtime_error(
                "Expected the first call to add a new torrent"
            );
        }

        if (!first.handle.is_valid())
        {
            throw std::runtime_error(
                "First torrent handle is invalid"
            );
        }

        // Second addition of the same torrent
        std::cout << "\nSecond addTorrent() call...\n";

        AddTorrentResult second = manager.addTorrent(
            torrentPath,
            savePath
        );

        const std::uint32_t secondId =
            static_cast<std::uint32_t>(second.handle.id());

        std::cout << "Added: " << second.added << '\n';
        std::cout << "Torrent ID: " << secondId << '\n';

        if (second.added)
        {
            throw std::runtime_error(
                "Duplicate torrent was added instead of reused"
            );
        }

        if (!second.handle.is_valid())
        {
            throw std::runtime_error(
                "Second torrent handle is invalid"
            );
        }

        // Verify both calls returned the same engine torrent.
        if (firstId != secondId)
        {
            throw std::runtime_error(
                "Duplicate calls returned different torrent IDs"
            );
        }

        std::cout << "\nDuplicate detection verified!\n";
        std::cout << "Both calls returned the same torrent handle ID.\n";
        std::cout << "Only one torrent was registered for this info hash.\n";

        // Cleanup
        std::cout << "\nRemoving torrent...\n";

        manager.removeTorrent(firstId);

        std::cout << "Torrent removed successfully!\n";
    }
    catch (const std::exception& e)
    {
        std::cerr << "Test failed: " << e.what() << '\n';
        return 1;
    }

    return 0;
}
