
#include <iostream>
#include <filesystem>
#include <stdexcept>
#include <thread>
#include <chrono>
#include "torrent_manager.hpp"

int main()
{
    try
    {
        std::cout << "Creating TorrentManager...\n";

        TorrentManager manager;

        std::filesystem::create_directories(
            "./test-downloads");

        std::cout << "Adding torrent...\n";

        lt::torrent_handle handle = manager.addTorrent(
            "./test-data/ubuntu.torrent",
            "./test-downloads");

        std::cout << "Torrent added successfully!\n";

        // Retrieve torrent ID.
        int torrentId = handle.id();

        std::cout << "Torrent ID: "
                  << torrentId << '\n';

        std::cout << "Handle valid: "
                  << std::boolalpha
                  << handle.is_valid() << '\n';

        // 1. Retrieve initial torrent status.
        std::cout << "\nRetrieving initial torrent status...\n";

        nlohmann::json status =
            manager.getTorrentStatus(torrentId);

        std::cout << status.dump(4) << '\n';

        // 1. Resume torrent
        std::cout << "\nResuming torrent...\n";

        manager.resumeTorrent(torrentId);

        // Wait until libtorrent reflects the resumed state.
        bool resumed = false;

        for (int i = 0; i < 50; i++)
        {
            auto status = manager.getTorrentStatus(torrentId);

            if (!status["paused"].get<bool>())
            {
                resumed = true;
                break;
            }

            std::this_thread::sleep_for(
                std::chrono::milliseconds(100));
        }

        if (!resumed)
        {
            throw std::runtime_error(
                "Torrent did not resume within timeout");
        }

        std::cout << "Torrent resumed successfully!\n";

        status = manager.getTorrentStatus(torrentId);
        std::cout << status.dump(4) << '\n';

        // 2. Pause torrent again
        std::cout << "\nPausing torrent again...\n";

        manager.pauseTorrent(torrentId);

        bool paused = false;

        for (int i = 0; i < 50; i++)
        {
            auto status = manager.getTorrentStatus(torrentId);

            if (status["paused"].get<bool>())
            {
                paused = true;
                break;
            }

            std::this_thread::sleep_for(
                std::chrono::milliseconds(100));
        }

        if (!paused)
        {
            throw std::runtime_error(
                "Torrent did not pause within timeout");
        }

        std::cout << "Torrent paused successfully!\n";

        // 3. Remove torrent
        std::cout << "\nRemoving torrent...\n";

        manager.removeTorrent(torrentId);

        std::cout << "Torrent removed successfully!\n";
    }
    catch (const std::exception &e)
    {
        std::cerr << "Error: " << e.what() << '\n';
        return 1;
    }

    return 0;
}
