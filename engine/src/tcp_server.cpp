
#include <winsock2.h>
#include <iostream>
#include <string>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <nlohmann/json.hpp>
#include "torrent_metadata.hpp"
#include "torrent_manager.hpp"
#include "logger.hpp"

using namespace std;
using json = nlohmann::json;

constexpr uint32_t MAX_PAYLOAD = 1024 * 1024; // 1 MiB
constexpr int HEADER_SIZE = 4;

enum class RecvStatus
{
    Success,
    Closed,
    Error
};

// Receive exactly the requested number of bytes.
// Does not read beyond the current header or payload.
// Receive exactly the requested number of bytes.
// Does not read beyond the current header or payload.
RecvStatus recvExact(
    SOCKET sock,
    char *buffer,
    int length)
{
    int totalReceived = 0;

    while (totalReceived < length)
    {
        int bytesReceived = recv(
            sock,
            buffer + totalReceived,
            length - totalReceived,
            0);

        if (bytesReceived == 0)
        {
            return RecvStatus::Closed;
        }

        if (bytesReceived == SOCKET_ERROR)
        {
            const int errorCode = WSAGetLastError();

            EngineLogger::error(
                "tcp-server",
                "socket_receive_failed",
                "Failed to receive socket data",
                {{"error_code", errorCode},
                 {"bytes_received", totalReceived},
                 {"expected_bytes", length}});

            return RecvStatus::Error;
        }

        totalReceived += bytesReceived;
    }

    return RecvStatus::Success;
}

// Send all bytes, handling partial sends.
// Send all bytes, handling partial sends.
bool sendAll(
    SOCKET sock,
    const char *data,
    int length)
{
    int totalSent = 0;

    while (totalSent < length)
    {
        int bytesSent = send(
            sock,
            data + totalSent,
            length - totalSent,
            0);

        if (bytesSent == SOCKET_ERROR)
        {
            const int errorCode = WSAGetLastError();

            EngineLogger::error(
                "tcp-server",
                "socket_send_failed",
                "Failed to send socket data",
                {{"error_code", errorCode},
                 {"bytes_sent", totalSent},
                 {"expected_bytes", length}});

            return false;
        }

        if (bytesSent == 0)
        {
            EngineLogger::warn(
                "tcp-server",
                "socket_send_interrupted",
                "Connection closed during send",
                {{"bytes_sent", totalSent},
                 {"expected_bytes", length}});

            return false;
        }

        totalSent += bytesSent;
    }

    return true;
}

// Receive one complete length-prefixed JSON frame.
// Receive one complete length-prefixed JSON frame.
bool receiveJson(
    SOCKET sock,
    json &message)
{
    // 1. Receive exactly 4 bytes for the header.
    uint32_t networkLength = 0;

    RecvStatus headerStatus = recvExact(
        sock,
        reinterpret_cast<char *>(&networkLength),
        HEADER_SIZE);

    if (headerStatus != RecvStatus::Success)
    {
        if (headerStatus == RecvStatus::Closed)
        {
            EngineLogger::debug(
                "tcp-server",
                "connection_closed_during_header",
                "Client disconnected while reading frame header");
        }

        return false;
    }

    // 2. Convert network byte order to host byte order.
    uint32_t payloadLength = ntohl(networkLength);

    // 3. Validate length before allocating memory.
    if (payloadLength == 0 ||
        payloadLength > MAX_PAYLOAD)
    {
        EngineLogger::warn(
            "tcp-server",
            "invalid_payload_length",
            "Received invalid payload length",
            {{"payload_length", payloadLength},
             {"maximum_payload", MAX_PAYLOAD}});

        return false;
    }

    // 4. Receive exactly the payload length.
    string payload(payloadLength, '\\0');

    RecvStatus payloadStatus = recvExact(
        sock,
        &payload[0],
        static_cast<int>(payloadLength));

    if (payloadStatus != RecvStatus::Success)
    {
        if (payloadStatus == RecvStatus::Closed)
        {
            EngineLogger::warn(
                "tcp-server",
                "connection_closed_during_payload",
                "Client disconnected before the complete payload arrived",
                {{"expected_payload_bytes", payloadLength}});
        }

        return false;
    }

    // 5. Parse JSON.
    try
    {
        message = json::parse(payload);
    }
    catch (const json::exception &e)
    {
        EngineLogger::warn(
            "tcp-server",
            "json_parse_failed",
            "Failed to parse incoming JSON payload",
            {{"error", e.what()},
             {"payload_bytes", payloadLength}});

        return false;
    }

    return true;
}

// Serialize JSON and send a framed response.
// Serialize JSON and send a framed response.
bool sendJson(
    SOCKET sock,
    const json &message)
{
    string payload = message.dump();

    if (payload.empty() || payload.size() > MAX_PAYLOAD)
    {
        EngineLogger::error(
            "tcp-server",
            "invalid_response_payload",
            "Response payload size is invalid",
            {{"payload_bytes", payload.size()},
             {"maximum_payload", MAX_PAYLOAD}});

        return false;
    }

    uint32_t payloadLength =
        static_cast<uint32_t>(payload.size());

    uint32_t networkLength = htonl(payloadLength);

    // Send header.
    if (!sendAll(
            sock,
            reinterpret_cast<const char *>(&networkLength),
            HEADER_SIZE))
    {
        return false;
    }

    // Send payload.
    return sendAll(
        sock,
        payload.data(),
        static_cast<int>(payload.size()));
}

// Compare tokens without early exit on differing characters.
bool constantTimeEqual(
    const string &a,
    const string &b)
{
    if (a.size() != b.size())
    {
        return false;
    }

    unsigned char difference = 0;

    for (size_t i = 0; i < a.size(); ++i)
    {
        difference |=
            static_cast<unsigned char>(a[i] ^ b[i]);
    }

    return difference == 0;
}

json makeError(
    const json &id,
    int code,
    const string &message)
{
    return {
        {"jsonrpc", "2.0"},
        {"id", id},
        {"error", {{"code", code}, {"message", message}}}};
}

// Validate basic JSON-RPC request structure.
bool isValidRequest(const json &request)
{
    return request.is_object() && request.value("jsonrpc", string()) == "2.0" && request.contains("id") && request.contains("method") && request["method"].is_string() && (!request.contains("params") || request["params"].is_object() || request["params"].is_array());
}

// Read a JSON torrent ID without allowing negative or out-of-range values.
// Accepts only integral JSON values in the uint32_t range.
bool getTorrentIdParam(
    const json &params,
    std::uint32_t &torrentId)
{
    if (!params.is_object() || !params.contains("torrentId"))
    {
        return false;
    }

    const json &value = params["torrentId"];
    constexpr std::uint64_t maxTorrentId =
        (std::numeric_limits<std::uint32_t>::max)();

    if (value.is_number_unsigned())
    {
        const std::uint64_t parsed = value.get<std::uint64_t>();

        if (parsed > maxTorrentId)
        {
            return false;
        }

        torrentId = static_cast<std::uint32_t>(parsed);
        return true;
    }

    if (value.is_number_integer())
    {
        const std::int64_t parsed = value.get<std::int64_t>();

        if (parsed < 0 ||
            static_cast<std::uint64_t>(parsed) > maxTorrentId)
        {
            return false;
        }

        torrentId = static_cast<std::uint32_t>(parsed);
        return true;
    }

    // Reject floats, strings, booleans, null, arrays, and objects.
    return false;
}

// Process a single authenticated request.

json processRequest(
    const json &request,
    TorrentManager &manager,
    bool &shutdownRequested)
{
    json id = request["id"];
    string method = request["method"].get<string>();

    json params = request.value("params", json::object());

    if (method == "get_status")
    {
        return {
            {"jsonrpc", "2.0"},
            {"id", id},
            {"result", {{"status", "UP"}, {"message", "Hello from C++ engine"}}}};
    }

    // Inspect torrent metadata.
    if (method == "inspect_torrent")
    {
        if (!params.is_object() ||
            !params.contains("torrentPath") ||
            !params["torrentPath"].is_string() ||
            params["torrentPath"].get<string>().empty())
        {
            return makeError(
                id,
                -32602,
                "Invalid params: valid torrentPath is required");
        }

        json result = inspectTorrent(
            params["torrentPath"].get<string>());

        return {
            {"jsonrpc", "2.0"},
            {"id", id},
            {"result", result}};
    }

    // Add torrent.
    if (method == "add_torrent")
    {
        if (!params.is_object() ||
            !params.contains("torrentPath") ||
            !params.contains("savePath") ||
            !params["torrentPath"].is_string() ||
            !params["savePath"].is_string() ||
            params["torrentPath"].get<string>().empty() ||
            params["savePath"].get<string>().empty())
        {
            return makeError(
                id,
                -32602,
                "Invalid params: torrentPath and savePath are required");
        }

        try
        {
            AddTorrentResult addResult = manager.addTorrent(
                params["torrentPath"].get<string>(),
                params["savePath"].get<string>());

            const auto &handle = addResult.handle;

            return {
                {"jsonrpc", "2.0"},
                {"id", id},
                {"result", {{"success", true}, {"torrentId", static_cast<std::uint32_t>(handle.id())}, {"name", handle.status().name}, {"added", addResult.added}, {"alreadyExists", !addResult.added}}}};
        }
        catch (const std::exception &e)
        {
            return makeError(id, -32000, e.what());
        }
    }

    // Get torrent status.
    if (method == "get_torrent_status")
    {
        std::uint32_t torrentId = 0;
        if (!getTorrentIdParam(params, torrentId))
        {
            return makeError(
                id,
                -32602,
                "Invalid params: torrentId must be an integer between 0 and UINT32_MAX");
        }

        try
        {
            return {
                {"jsonrpc", "2.0"},
                {"id", id},
                {"result", manager.getTorrentStatus(torrentId)}};
        }
        catch (const std::exception &e)
        {
            return makeError(id, -32000, e.what());
        }
    }

    // Pause torrent.
    if (method == "pause_torrent")
    {
        std::uint32_t torrentId = 0;
        if (!getTorrentIdParam(params, torrentId))
        {
            return makeError(
                id,
                -32602,
                "Invalid params: torrentId must be an integer between 0 and UINT32_MAX");
        }

        try
        {
            manager.pauseTorrent(torrentId);

            return {
                {"jsonrpc", "2.0"},
                {"id", id},
                {"result", {{"success", true}, {"message", "Pause request submitted"}}}};
        }
        catch (const std::exception &e)
        {
            return makeError(id, -32000, e.what());
        }
    }

    // Resume torrent.
    if (method == "resume_torrent")
    {
        std::uint32_t torrentId = 0;
        if (!getTorrentIdParam(params, torrentId))
        {
            return makeError(
                id,
                -32602,
                "Invalid params: torrentId must be an integer between 0 and UINT32_MAX");
        }

        try
        {
            manager.resumeTorrent(torrentId);

            return {
                {"jsonrpc", "2.0"},
                {"id", id},
                {"result", {{"success", true}, {"message", "Resume request submitted"}}}};
        }
        catch (const std::exception &e)
        {
            return makeError(id, -32000, e.what());
        }
    }

    // Remove torrent.
    if (method == "remove_torrent")
    {
        std::uint32_t torrentId = 0;
        if (!getTorrentIdParam(params, torrentId))
        {
            return makeError(
                id,
                -32602,
                "Invalid params: torrentId must be an integer between 0 and UINT32_MAX");
        }

        try
        {
            manager.removeTorrent(torrentId);

            return {
                {"jsonrpc", "2.0"},
                {"id", id},
                {"result", {{"success", true}, {"message", "Torrent removed successfully"}}}};
        }
        catch (const std::exception &e)
        {
            return makeError(id, -32000, e.what());
        }
    }

    // Gracefully shut down the engine.
    if (method == "shutdown_engine")
    {
        shutdownRequested = true;

        return {
            {"jsonrpc", "2.0"},
            {"id", id},
            {"result", {{"success", true}, {"message", "Engine shutdown requested"}}}};
    }

    // Unknown method.
    return makeError(
        id,
        -32601,
        "Method not found");
}

// Handle one connected client until disconnect/error.
void handleClient(
    SOCKET clientSocket,
    const string &expectedToken,
    TorrentManager &manager,
    bool &shutdownRequested)
{
    EngineLogger::info(
        "tcp-server",
        "client_connected",
        "Client connected");

    while (true)
    {
        json request;

        // Receive one complete frame.
        if (!receiveJson(clientSocket, request))
        {
            cout << "Stopping client session\n";
            break;
        }

        // Validate JSON-RPC structure before accessing request fields.
        if (!isValidRequest(request))
        {
            json errorResponse = makeError(
                request.value("id", json(nullptr)),
                -32600,
                "Invalid Request");

            sendJson(clientSocket, errorResponse);
            break;
        }

        // Authenticate before processing the method.
        if (!request.contains("token") ||
            !request["token"].is_string())
        {
            json errorResponse = makeError(
                request["id"],
                -32001,
                "Unauthorized: token missing");

            sendJson(clientSocket, errorResponse);
            break;
        }

        string receivedToken =
            request["token"].get<string>();

        if (!constantTimeEqual(
                receivedToken,
                expectedToken))
        {
            json errorResponse = makeError(
                request["id"],
                -32001,
                "Unauthorized: invalid token");

            sendJson(clientSocket, errorResponse);
            break;
        }

        // Authentication succeeded. Log the request without exposing the token.
        json loggedRequest = request;
        loggedRequest.erase("token");

        EngineLogger::debug(
            "tcp-server",
            "request_authenticated",
            "Authenticated IPC request",
            {{"request_id", request["id"]},
             {"method", request["method"]}});

        // Only authenticated requests reach the method dispatcher.
        json response = processRequest(request, manager, shutdownRequested);

        if (!sendJson(clientSocket, response))
        {
            cout << "Failed to send response\n";
            break;
        }

        if (shutdownRequested)
        {
            cout << "Shutdown command received. Closing client session." << endl;
            break;
        }

        cout << "Response sent successfully\n";
    }

    // Gracefully shut down this client connection.
    shutdown(clientSocket, SD_SEND);
    closesocket(clientSocket);

    cout << "Client socket closed\n";
}

int main()
{
    EngineLogger::initialize();

    EngineLogger::info(
        "tcp-server",
        "engine_starting",
        "BitTorrent engine startup initiated");

    // 1. Load the shared IPC secret.
    const char *tokenEnv = getenv("BITT_IPC_TOKEN");

    if (tokenEnv == nullptr || strlen(tokenEnv) == 0)
    {
        EngineLogger::error(
            "tcp-server",
            "configuration_error",
            "BITT_IPC_TOKEN is not configured");

        cerr << "BITT_IPC_TOKEN is not configured\n";
        return 1;
    }

    string expectedToken(tokenEnv);

    // 2. Initialize Winsock.
    WSADATA wsaData;

    int result = WSAStartup(
        MAKEWORD(2, 2),
        &wsaData);

    if (result != 0)
    {
        EngineLogger::error(
            "tcp-server",
            "winsock_initialization_failed",
            "WSAStartup failed",
            {{"error_code", result}});

        cerr << "WSAStartup failed: "
             << result << "\n";
        return 1;
    }

    // 3. Create listening socket.
    SOCKET listenSocket = socket(
        AF_INET,
        SOCK_STREAM,
        IPPROTO_TCP);

    if (listenSocket == INVALID_SOCKET)
    {
        const int errorCode = WSAGetLastError();

        EngineLogger::error(
            "tcp-server",
            "socket_creation_failed",
            "Failed to create listening socket",
            {{"error_code", errorCode}});

        cerr << "Socket creation failed: "
             << errorCode << "\n";

        WSACleanup();
        return 1;
    }

    // 4. Configure address.
    sockaddr_in serverAddr{};

    serverAddr.sin_family = AF_INET;
    serverAddr.sin_addr.s_addr =
        htonl(INADDR_LOOPBACK);
    serverAddr.sin_port = htons(5000);

    // 5. Bind.
    if (::bind(
            listenSocket,
            reinterpret_cast<sockaddr *>(&serverAddr),
            sizeof(serverAddr)) == SOCKET_ERROR)
    {
        const int errorCode = WSAGetLastError();

        EngineLogger::error(
            "tcp-server",
            "socket_bind_failed",
            "Failed to bind listening socket",
            {{"error_code", errorCode},
             {"host", "127.0.0.1"},
             {"port", 5000}});

        cerr << "Bind failed: "
             << errorCode << "\n";

        closesocket(listenSocket);
        WSACleanup();
        return 1;
    }

    // 6. Listen.
    if (listen(
            listenSocket,
            SOMAXCONN) == SOCKET_ERROR)
    {
        const int errorCode = WSAGetLastError();

        EngineLogger::error(
            "tcp-server",
            "socket_listen_failed",
            "Failed to listen on server socket",
            {{"error_code", errorCode},
             {"host", "127.0.0.1"},
             {"port", 5000}});

        cerr << "Listen failed: "
             << errorCode << "\n";

        closesocket(listenSocket);
        WSACleanup();
        return 1;
    }

    EngineLogger::info(
        "tcp-server",
        "engine_listening",
        "Engine listening",
        {{"host", "127.0.0.1"},
         {"port", 5000}});

    // IMPORTANT: Keep this exact line for Node.js readiness detection.
    cout << "ENGINE_READY" << endl;

    // One manager (and one libtorrent session) for the engine lifetime.
    TorrentManager manager;

    bool shutdownRequested = false;

    // 7. Accept clients repeatedly.
    while (!shutdownRequested)
    {
        SOCKET clientSocket = accept(
            listenSocket,
            nullptr,
            nullptr);

        if (clientSocket == INVALID_SOCKET)
        {
            const int errorCode = WSAGetLastError();

            EngineLogger::error(
                "tcp-server",
                "client_accept_failed",
                "Failed to accept incoming client connection",
                {{"error_code", errorCode}});

            cerr << "Accept failed: "
                 << errorCode << "\n";
            break;
        }

        handleClient(
            clientSocket,
            expectedToken,
            manager,
            shutdownRequested);

        cout << "Waiting for next client...\n";
    }

    EngineLogger::info(
        "tcp-server",
        "engine_shutdown_started",
        "Engine shutdown initiated",
        {{"shutdown_requested", shutdownRequested}});

    cout << "Shutting down C++ engine..." << endl;

    // 8. Cleanup server.
    closesocket(listenSocket);
    WSACleanup();

    EngineLogger::info(
        "tcp-server",
        "engine_stopped",
        "BitTorrent engine stopped");

    return 0;
}
