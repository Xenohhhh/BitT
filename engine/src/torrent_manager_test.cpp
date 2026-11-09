#include <iostream>
#include "torrent_manager.hpp"

int main()
{
    try
    {
        std::cout << "Creating TorrentManager...\n";

        TorrentManager manager;

        std::cout << "TorrentManager created successfully!\n";

        std::cout << "Session is alive.\n";
    }
    catch (const std::exception& e)
    {
        std::cerr << "Error: " << e.what() << '\n';
        return 1;
    }

    std::cout << "TorrentManager destroyed successfully.\n";

    return 0;
}