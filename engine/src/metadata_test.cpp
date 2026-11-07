#include <iostream>
#include "torrent_metadata.hpp"

int main(int argc, char* argv[])
{
    if (argc < 2)
    {
        std::cerr << "Usage: metadata_test <torrent-file>\n";
        return 1;
    }

    nlohmann::json result = inspectTorrent(argv[1]);

    std::cout << result.dump(4) << '\n';

    if (!result["success"].get<bool>())
    {
        return 1;
    }

    return 0;
}