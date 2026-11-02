cmake_minimum_required(VERSION 3.16)
project(bitt_engine LANGUAGES CXX)

add_executable(tcp_server src/tcp_server.cpp)
target_include_directories(tcp_server PRIVATE src)
target_compile_features(tcp_server PRIVATE cxx_std_14)
target_compile_definitions(tcp_server PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(tcp_server PRIVATE ws2_32)

if(MSVC)
    target_compile_options(tcp_server PRIVATE /W4 /permissive-)
else()
    target_compile_options(tcp_server PRIVATE -Wall -Wextra -Wpedantic)
endif()
