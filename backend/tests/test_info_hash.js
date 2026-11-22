
const ipcClient = require("../src/engine/tcp_client.js");

async function testInfoHash() {
    try {
        await ipcClient.connectToEngine();

        const response = await ipcClient.sendRequest(
            "inspect_torrent",
            {
                torrentPath:
                    "C:/Users/stvks/Downloads/Practice/New folder/BitT/test-data/ubuntu.torrent"
            }
        );

        console.log("Torrent metadata response:");
        console.dir(response, { depth: null });

    } catch (error) {
        console.error("Test failed:", error);
    } finally {
        await ipcClient.disconnect();
    }
}

testInfoHash();
