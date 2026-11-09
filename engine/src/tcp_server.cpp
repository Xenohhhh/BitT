
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
            cout << "recv failed: "
                 << WSAGetLastError() << "\n";

            return RecvStatus::Error;
        }

        totalReceived += bytesReceived;
    }

    return RecvStatus::Success;
}

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
            cout << "send failed: "
                 << WSAGetLastError() << "\n";

            return false;
        }

        if (bytesSent == 0)
        {
            cout << "Connection closed during send\n";
            return false;
        }

        totalSent += bytesSent;
    }

    return true;
}

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
            cout << "Client disconnected while reading header\n";
        }

        return false;
    }

    // 2. Convert network byte order to host byte order.
    uint32_t payloadLength = ntohl(networkLength);

    // 3. Validate length before allocating memory.
    if (payloadLength == 0 ||
        payloadLength > MAX_PAYLOAD)
    {
        cout << "Invalid payload length: "
             << payloadLength << "\n";

        return false;
    }

    // 4. Receive exactly the payload length.
    string payload(payloadLength, '\0');

    RecvStatus payloadStatus = recvExact(
        sock,
        &payload[0],
        static_cast<int>(payloadLength));

    if (payloadStatus != RecvStatus::Success)
    {
        if (payloadStatus == RecvStatus::Closed)
        {
            cout << "Client disconnected during payload\n";
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
        cout << "JSON parse failed: "
             << e.what() << "\n";

        return false;
    }

    return true;
}

// Serialize JSON and send a framed response.
bool sendJson(
    SOCKET sock,
    const json &message)
{
    string payload = message.dump();

    if (payload.empty() || payload.size() > MAX_PAYLOAD)
    {
        cout << "Invalid response payload size\n";
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
    TorrentManager &manager)
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
            lt::torrent_handle handle = manager.addTorrent(
                params["torrentPath"].get<string>(),
                params["savePath"].get<string>());

            return {
                {"jsonrpc", "2.0"},
                {"id", id},
                {"result", {
                    {"success", true},
                    {"torrentId", static_cast<std::uint32_t>(handle.id())},
                    {"name", handle.status().name}
                }}
            };
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
    TorrentManager &manager)
{
    cout << "Client connected\n";

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

        cout << "Received authenticated request:\n"
             << loggedRequest.dump(4) << "\n";

        // Only authenticated requests reach the method dispatcher.
        json response = processRequest(request, manager);

        if (!sendJson(clientSocket, response))
        {
            cout << "Failed to send response\n";
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
    // 1. Load the shared IPC secret.
    const char *tokenEnv = getenv("BITT_IPC_TOKEN");

    if (tokenEnv == nullptr || strlen(tokenEnv) == 0)
    {
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
        cerr << "Socket creation failed: "
             << WSAGetLastError() << "\n";

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
        cerr << "Bind failed: "
             << WSAGetLastError() << "\n";

        closesocket(listenSocket);
        WSACleanup();
        return 1;
    }

    // 6. Listen.
    if (listen(
            listenSocket,
            SOMAXCONN) == SOCKET_ERROR)
    {
        cerr << "Listen failed: "
             << WSAGetLastError() << "\n";

        closesocket(listenSocket);
        WSACleanup();
        return 1;
    }

    cout << "Engine listening on 127.0.0.1:5000\n";

    // One manager (and one libtorrent session) for the engine lifetime.
    TorrentManager manager;

    // 7. Accept clients repeatedly.
    while (true)
    {
        SOCKET clientSocket = accept(
            listenSocket,
            nullptr,
            nullptr);

        if (clientSocket == INVALID_SOCKET)
        {
            cerr << "Accept failed: "
                 << WSAGetLastError() << "\n";
            break;
        }

        handleClient(
            clientSocket,
            expectedToken,
            manager);

        cout << "Waiting for next client...\n";
    }

    // 8. Cleanup server.
    closesocket(listenSocket);
    WSACleanup();

    return 0;
}
