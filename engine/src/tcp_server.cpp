
#include <winsock2.h>
#include <iostream>
#include <string>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <nlohmann/json.hpp>

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
    char* buffer,
    int length
)
{
    int totalReceived = 0;

    while (totalReceived < length)
    {
        int bytesReceived = recv(
            sock,
            buffer + totalReceived,
            length - totalReceived,
            0
        );

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
    const char* data,
    int length
)
{
    int totalSent = 0;

    while (totalSent < length)
    {
        int bytesSent = send(
            sock,
            data + totalSent,
            length - totalSent,
            0
        );

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
    json& message
)
{
    // 1. Receive exactly 4 bytes for the header.
    uint32_t networkLength = 0;

    RecvStatus headerStatus = recvExact(
        sock,
        reinterpret_cast<char*>(&networkLength),
        HEADER_SIZE
    );

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
        static_cast<int>(payloadLength)
    );

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
    catch (const json::exception& e)
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
    const json& message
)
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
            reinterpret_cast<const char*>(&networkLength),
            HEADER_SIZE
        ))
    {
        return false;
    }

    // Send payload.
    return sendAll(
        sock,
        payload.data(),
        static_cast<int>(payload.size())
    );
}

// Compare tokens without early exit on differing characters.
bool constantTimeEqual(
    const string& a,
    const string& b
)
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
    const json& id,
    int code,
    const string& message
)
{
    return {
        {"jsonrpc", "2.0"},
        {"id", id},
        {"error", {
            {"code", code},
            {"message", message}
        }}
    };
}

// Validate basic JSON-RPC request structure.
bool isValidRequest(const json& request)
{
    return request.is_object()
        && request.value("jsonrpc", string()) == "2.0"
        && request.contains("id")
        && request.contains("method")
        && request["method"].is_string()
        && (!request.contains("params")
            || request["params"].is_object()
            || request["params"].is_array());
}

// Process a single authenticated request.
json processRequest(const json& request)
{
    json id = request["id"];
    string method = request["method"].get<string>();

    if (method == "get_status")
    {
        return {
            {"jsonrpc", "2.0"},
            {"id", id},
            {"result", {
                {"status", "UP"},
                {"message", "Hello from C++ engine"}
            }}
        };
    }

    // Unknown method.
    return makeError(
        id,
        -32601,
        "Method not found"
    );
}

// Handle one connected client until disconnect/error.
void handleClient(
    SOCKET clientSocket,
    const string& expectedToken
)
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

        
        // Authentication succeeded.

        string method = request["method"].get<string>();

        // Send an event before the get_status response.
        if (method == "get_status")
        {
            json notification = {
                {"jsonrpc", "2.0"},
                {"method", "torrent_state_changed"},
                {"params", {
                    {"torrentId", "demo-torrent-1"},
                    {"state", "downloading"},
                    {"progress", 0.35}
                }}
            };

            // Notification has no "id".
            if (!sendJson(clientSocket, notification))
            {
                cout << "Failed to send notification\n";
                break;
            }

            cout << "Notification sent successfully\n";
        }

        

        cout << "Response sent successfully\n";


        cout << "Received request:\n"
             << request.dump(4) << "\n";

        // Validate JSON-RPC structure.
        if (!isValidRequest(request))
        {
            json errorResponse = makeError(
                request.value("id", json(nullptr)),
                -32600,
                "Invalid Request"
            );

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
                "Unauthorized: token missing"
            );

            sendJson(clientSocket, errorResponse);
            break;
        }

        string receivedToken =
            request["token"].get<string>();

        if (!constantTimeEqual(
                receivedToken,
                expectedToken
            ))
        {
            json errorResponse = makeError(
                request["id"],
                -32001,
                "Unauthorized: invalid token"
            );

            sendJson(clientSocket, errorResponse);
            break;
        }

        // Authentication succeeded.
        // Only now execute the requested method.
        json response = processRequest(request);

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
    const char* tokenEnv = getenv("BITT_IPC_TOKEN");

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
        &wsaData
    );

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
        IPPROTO_TCP
    );

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
    if (bind(
            listenSocket,
            reinterpret_cast<sockaddr*>(&serverAddr),
            sizeof(serverAddr)
        ) == SOCKET_ERROR)
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
            SOMAXCONN
        ) == SOCKET_ERROR)
    {
        cerr << "Listen failed: "
             << WSAGetLastError() << "\n";

        closesocket(listenSocket);
        WSACleanup();
        return 1;
    }

    cout << "Engine listening on 127.0.0.1:5000\n";

    // 7. Accept clients repeatedly.
    while (true)
    {
        SOCKET clientSocket = accept(
            listenSocket,
            nullptr,
            nullptr
        );

        if (clientSocket == INVALID_SOCKET)
        {
            cerr << "Accept failed: "
                 << WSAGetLastError() << "\n";
            break;
        }

        handleClient(clientSocket, expectedToken);

        cout << "Waiting for next client...\n";
    }

    // 8. Cleanup server.
    closesocket(listenSocket);
    WSACleanup();

    return 0;
}
