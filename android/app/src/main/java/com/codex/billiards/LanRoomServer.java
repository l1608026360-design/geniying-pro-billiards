package com.codex.billiards;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.InetSocketAddress;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class LanRoomServer extends WebSocketServer {
    public interface EventListener {
        void onServerError(String message);
    }

    private final EventListener eventListener;
    private final CountDownLatch startedLatch = new CountDownLatch(1);
    private volatile Exception startException;
    private String roomCode;
    private WebSocket hostSocket;
    private WebSocket guestSocket;
    private JSONObject roomState;

    public LanRoomServer(String roomCode, EventListener eventListener) {
        super(new InetSocketAddress(0));
        this.roomCode = roomCode;
        this.eventListener = eventListener;
        setReuseAddr(true);
        setTcpNoDelay(true);
    }

    public int startServer() {
        start();
        try {
            startedLatch.await(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while starting room server", e);
        }

        if (startException != null) {
            throw new IllegalStateException("Failed to start room server", startException);
        }
        return getPort();
    }

    public void stopServer() {
        try {
            stop(200);
        } catch (Exception ignored) {
        }
        closeSocket(hostSocket);
        closeSocket(guestSocket);
        hostSocket = null;
        guestSocket = null;
        roomState = null;
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        // No-op.
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        leaveRoom(conn, "player-left");
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        try {
            JSONObject payload = new JSONObject(message);
            String type = payload.optString("type", "");
            switch (type) {
                case "create-room":
                    handleCreateRoom(conn, payload);
                    break;
                case "join-room":
                    handleJoinRoom(conn, payload);
                    break;
                case "shot":
                    handleShot(conn, payload);
                    break;
                case "state-sync":
                    handleStateSync(conn, payload);
                    break;
                case "leave-room":
                    leaveRoom(conn, "player-left");
                    break;
                default:
                    sendJson(conn, errorPayload("不支持的消息类型"));
                    break;
            }
        } catch (JSONException error) {
            sendJson(conn, errorPayload("消息格式不正确"));
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        if (startException == null && getConnections().isEmpty()) {
            startException = ex;
            startedLatch.countDown();
        }

        if (eventListener != null && ex != null && ex.getMessage() != null) {
            eventListener.onServerError(ex.getMessage());
        }
    }

    @Override
    public void onStart() {
        startedLatch.countDown();
    }

    private void handleCreateRoom(WebSocket socket, JSONObject message) throws JSONException {
        if (hostSocket != null && hostSocket != socket) {
            sendJson(socket, errorPayload("当前房主已存在"));
            return;
        }

        String preferredRoomCode = message.optString("roomCode", "");
        if (!preferredRoomCode.isEmpty()) {
            roomCode = preferredRoomCode;
        }

        hostSocket = socket;
        roomState = message.optJSONObject("state");

        JSONObject response = new JSONObject();
        response.put("type", "room-created");
        response.put("roomCode", roomCode);
        response.put("role", 1);
        sendJson(socket, response);
    }

    private void handleJoinRoom(WebSocket socket, JSONObject message) throws JSONException {
        String joiningRoomCode = message.optString("roomCode", "");
        if (hostSocket == null || !roomCode.equals(joiningRoomCode)) {
            JSONObject response = new JSONObject();
            response.put("type", "room-missing");
            sendJson(socket, response);
            return;
        }

        if (guestSocket != null && guestSocket != socket) {
            JSONObject response = new JSONObject();
            response.put("type", "room-full");
            sendJson(socket, response);
            return;
        }

        guestSocket = socket;

        JSONObject hostReady = new JSONObject();
        hostReady.put("type", "room-ready");
        hostReady.put("roomCode", roomCode);
        hostReady.put("role", 1);
        if (roomState != null) {
            hostReady.put("state", roomState);
        }
        sendJson(hostSocket, hostReady);

        JSONObject guestReady = new JSONObject();
        guestReady.put("type", "room-ready");
        guestReady.put("roomCode", roomCode);
        guestReady.put("role", 2);
        if (roomState != null) {
            guestReady.put("state", roomState);
        }
        sendJson(guestSocket, guestReady);
    }

    private void handleShot(WebSocket socket, JSONObject message) throws JSONException {
        WebSocket target = socket == hostSocket ? guestSocket : hostSocket;
        if (target == null) {
            return;
        }

        JSONObject payload = new JSONObject();
        payload.put("type", "shot");
        payload.put("roomCode", roomCode);
        if (message.has("shot")) {
            payload.put("shot", message.getJSONObject("shot"));
        }
        if (message.has("state")) {
            payload.put("state", message.getJSONObject("state"));
        }
        sendJson(target, payload);
    }

    private void handleStateSync(WebSocket socket, JSONObject message) throws JSONException {
        if (socket != hostSocket) {
            return;
        }

        roomState = message.optJSONObject("state");
        if (guestSocket == null || roomState == null) {
            return;
        }

        JSONObject payload = new JSONObject();
        payload.put("type", "state-sync");
        payload.put("roomCode", roomCode);
        payload.put("state", roomState);
        sendJson(guestSocket, payload);
    }

    private void leaveRoom(WebSocket socket, String reason) {
        if (socket == null) {
            return;
        }

        if (socket == hostSocket) {
            if (guestSocket != null) {
                sendJson(guestSocket, typePayload("room-closed"));
                closeSocket(guestSocket);
            }
            hostSocket = null;
            guestSocket = null;
            roomState = null;
            return;
        }

        if (socket == guestSocket) {
            if (hostSocket != null) {
                sendJson(hostSocket, typePayload(reason));
                closeSocket(hostSocket);
            }
            guestSocket = null;
            hostSocket = null;
            roomState = null;
        }
    }

    private JSONObject errorPayload(String message) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("type", "error");
            payload.put("message", message);
        } catch (JSONException ignored) {
        }
        return payload;
    }

    private JSONObject typePayload(String type) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("type", type);
        } catch (JSONException ignored) {
        }
        return payload;
    }

    private void sendJson(WebSocket socket, JSONObject payload) {
        if (socket != null && socket.isOpen() && payload != null) {
            socket.send(payload.toString());
        }
    }

    private void closeSocket(WebSocket socket) {
        if (socket != null) {
            try {
                socket.close();
            } catch (Exception ignored) {
            }
        }
    }
}
