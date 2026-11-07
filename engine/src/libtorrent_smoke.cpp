
#include <iostream>
#include <chrono>
#include <thread>

#include <libtorrent/session.hpp>

namespace lt = libtorrent;

int main()
{
    try
    {
        std::cout << "Initializing libtorrent session...\n";

        // Creates the session and starts libtorrent's
        // internal networking thread.
        lt::session session;

        std::cout << "libtorrent session started successfully!\n";

        // Keep it alive briefly so we can verify it runs.
        std::this_thread::sleep_for(
            std::chrono::seconds(3)
        );

        std::cout << "Shutting down session...\n";
    }
    catch (const std::exception& e)
    {
        std::cerr << "Failed to initialize libtorrent: "
                  << e.what() << '\n';

        return 1;
    }

    // Session is destroyed here and shuts down.
    std::cout << "Session shut down successfully.\n";

    return 0;
}
