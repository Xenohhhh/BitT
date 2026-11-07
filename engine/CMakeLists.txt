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
)

target_include_directories(tcp_server
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_link_libraries(tcp_server
    PRIVATE
        nlohmann_json::nlohmann_json
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