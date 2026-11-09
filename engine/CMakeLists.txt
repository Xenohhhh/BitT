cmake_minimum_required(VERSION 3.20)

project(BitTEngine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Find dependencies
find_package(LibtorrentRasterbar CONFIG REQUIRED)
find_package(nlohmann_json CONFIG REQUIRED)

# Existing TCP IPC server
add_executable(tcp_server
    src/tcp_server.cpp
    src/torrent_metadata.cpp
    src/torrent_manager.cpp
)

target_include_directories(tcp_server
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(tcp_server
    PRIVATE
        nlohmann_json::nlohmann_json
        LibtorrentRasterbar::torrent-rasterbar
)

if(WIN32)
    target_link_libraries(tcp_server PRIVATE ws2_32)
endif()

# Separate libtorrent initialization test
add_executable(libtorrent_smoke
    src/libtorrent_smoke.cpp
)

target_link_libraries(libtorrent_smoke
    PRIVATE
        LibtorrentRasterbar::torrent-rasterbar
)

# Torrent metadata inspection test
add_executable(metadata_test
    src/metadata_test.cpp
    src/torrent_metadata.cpp
)

target_include_directories(metadata_test
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(metadata_test
    PRIVATE
        LibtorrentRasterbar::torrent-rasterbar
        nlohmann_json::nlohmann_json
)

# Torrent manager lifecycle test
add_executable(torrent_manager_test
    src/torrent_manager_test.cpp
    src/torrent_manager.cpp
)

target_include_directories(torrent_manager_test
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(torrent_manager_test
    PRIVATE
        LibtorrentRasterbar::torrent-rasterbar
)

# Torrent addition test
add_executable(torrent_add_test
    src/torrent_add_test.cpp
    src/torrent_manager.cpp
)

target_include_directories(torrent_add_test
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(torrent_add_test
    PRIVATE
        LibtorrentRasterbar::torrent-rasterbar
)