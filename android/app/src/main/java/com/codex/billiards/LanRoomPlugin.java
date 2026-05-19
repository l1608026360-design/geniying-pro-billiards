package com.codex.billiards;

import android.Manifest;
import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.text.TextUtils;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

@CapacitorPlugin(
    name = "LanRoomPlugin",
    permissions = {
        @Permission(alias = "nearbyWifi", strings = { Manifest.permission.NEARBY_WIFI_DEVICES }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION })
    }
)
public class LanRoomPlugin extends Plugin {
    private static final String DEFAULT_ROOM_NAME = "思颖竞技台球房间";
    private static final String SERVICE_TYPE = "_geniyingbilliards._tcp.";

    private NsdManager nsdManager;
    private LanRoomServer roomServer;
    private NsdManager.RegistrationListener registrationListener;
    private NsdManager.DiscoveryListener discoveryListener;
    private final Map<String, JSObject> discoveredRooms = new LinkedHashMap<>();
    private WifiManager.MulticastLock multicastLock;

    private String currentRoomCode = "";
    private String currentRoomName = DEFAULT_ROOM_NAME;
    private String currentHostIp = "";
    private String currentServiceName = "";
    private String deviceName = "Android";
    private int currentPort = 0;
    private boolean discoveryActive = false;

    @Override
    public void load() {
        Context context = getContext().getApplicationContext();
        nsdManager = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
        deviceName = buildDeviceName();
    }

    @PluginMethod
    public void startHosting(PluginCall call) {
        if (!hasLanPermission()) {
            requestLanPermission(call, "startHostingPermissionCallback");
            return;
        }
        handleStartHosting(call);
    }

    @PluginMethod
    public void stopHosting(PluginCall call) {
        stopHostingInternal(false);
        call.resolve();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (!hasLanPermission()) {
            requestLanPermission(call, "startDiscoveryPermissionCallback");
            return;
        }
        handleStartDiscovery(call);
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        stopDiscoveryInternal(false);
        call.resolve();
    }

    @PluginMethod
    public void getDiscoveredRooms(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("rooms", roomsAsArray());
        call.resolve(payload);
    }

    @PermissionCallback
    private void startHostingPermissionCallback(PluginCall call) {
        if (!hasLanPermission()) {
            call.reject("需要允许附近 Wi-Fi 设备权限后才能创建局域网房间");
            return;
        }
        handleStartHosting(call);
    }

    @PermissionCallback
    private void startDiscoveryPermissionCallback(PluginCall call) {
        if (!hasLanPermission()) {
            call.reject("需要允许附近 Wi-Fi 设备权限后才能扫描房间");
            return;
        }
        handleStartDiscovery(call);
    }

    @Override
    protected void handleOnDestroy() {
        stopDiscoveryInternal(true);
        stopHostingInternal(true);
        releaseMulticastLockIfIdle();
    }

    private void handleStartHosting(PluginCall call) {
        if (nsdManager == null) {
            call.reject("当前设备不支持局域网发现服务");
            return;
        }

        stopHostingInternal(true);
        acquireMulticastLock();

        currentRoomName = sanitizeRoomName(call.getString("roomName", DEFAULT_ROOM_NAME));
        currentRoomCode = createRoomCode();
        currentHostIp = findLocalIpv4();
        currentServiceName = buildServiceName(currentRoomCode, currentRoomName);

        if (TextUtils.isEmpty(currentHostIp)) {
            releaseMulticastLockIfIdle();
            call.reject("没有检测到可用的局域网地址，请先连接 Wi-Fi 或热点");
            return;
        }

        roomServer = new LanRoomServer(currentRoomCode, message -> notifyHostStatus("error", message));
        try {
            currentPort = roomServer.startServer();
        } catch (Exception error) {
            roomServer = null;
            releaseMulticastLockIfIdle();
            call.reject("本机房间服务启动失败");
            return;
        }

        registerNsdService();

        JSObject payload = buildHostPayload("starting");
        call.resolve(payload);
        notifyHostStatus("starting", null);
    }

    private void handleStartDiscovery(PluginCall call) {
        if (nsdManager == null) {
            call.reject("当前设备不支持局域网发现服务");
            return;
        }

        stopDiscoveryInternal(true);
        acquireMulticastLock();
        discoveredRooms.clear();
        notifyRoomsUpdated();

        discoveryListener = new NsdManager.DiscoveryListener() {
            @Override
            public void onDiscoveryStarted(String serviceType) {
                discoveryActive = true;
            }

            @Override
            public void onServiceFound(NsdServiceInfo serviceInfo) {
                if (!SERVICE_TYPE.equals(serviceInfo.getServiceType())) {
                    return;
                }
                if (!TextUtils.isEmpty(currentServiceName) && currentServiceName.equals(serviceInfo.getServiceName())) {
                    return;
                }
                tryResolveService(serviceInfo);
            }

            @Override
            public void onServiceLost(NsdServiceInfo serviceInfo) {
                discoveredRooms.remove(serviceInfo.getServiceName());
                notifyRoomsUpdated();
            }

            @Override
            public void onDiscoveryStopped(String serviceType) {
                discoveryActive = false;
                releaseMulticastLockIfIdle();
            }

            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                discoveryActive = false;
                notifyHostStatus("error", "扫描附近房间失败");
                stopDiscoveryInternal(true);
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                discoveryActive = false;
                stopDiscoveryInternal(true);
            }
        };

        try {
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
            call.resolve();
        } catch (Exception error) {
            discoveryListener = null;
            releaseMulticastLockIfIdle();
            call.reject("启动房间扫描失败");
        }
    }

    private void tryResolveService(NsdServiceInfo serviceInfo) {
        try {
            nsdManager.resolveService(serviceInfo, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    // Ignore noisy resolution failures.
                }

                @Override
                public void onServiceResolved(NsdServiceInfo resolvedServiceInfo) {
                    JSObject room = toRoomPayload(resolvedServiceInfo);
                    if (room == null) {
                        return;
                    }
                    discoveredRooms.put(resolvedServiceInfo.getServiceName(), room);
                    notifyRoomsUpdated();
                }
            });
        } catch (Exception ignored) {
        }
    }

    private void registerNsdService() {
        unregisterServiceIfNeeded();

        NsdServiceInfo serviceInfo = new NsdServiceInfo();
        serviceInfo.setServiceType(SERVICE_TYPE);
        serviceInfo.setServiceName(currentServiceName);
        serviceInfo.setPort(currentPort);
        serviceInfo.setAttribute("roomCode", currentRoomCode);
        serviceInfo.setAttribute("roomName", currentRoomName);
        serviceInfo.setAttribute("deviceName", deviceName);

        registrationListener = new NsdManager.RegistrationListener() {
            @Override
            public void onServiceRegistered(NsdServiceInfo registeredServiceInfo) {
                currentServiceName = registeredServiceInfo.getServiceName();
                notifyHostStatus("hosting", null);
            }

            @Override
            public void onRegistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                notifyHostStatus("error", "局域网广播注册失败");
            }

            @Override
            public void onServiceUnregistered(NsdServiceInfo serviceInfo) {
                notifyHostStatus("stopped", null);
            }

            @Override
            public void onUnregistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                notifyHostStatus("error", "局域网广播停止失败");
            }
        };

        try {
            nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registrationListener);
        } catch (Exception error) {
            notifyHostStatus("error", "局域网广播启动失败");
        }
    }

    private void unregisterServiceIfNeeded() {
        if (nsdManager == null || registrationListener == null) {
            return;
        }
        try {
            nsdManager.unregisterService(registrationListener);
        } catch (Exception ignored) {
        }
        registrationListener = null;
    }

    private void stopHostingInternal(boolean silent) {
        unregisterServiceIfNeeded();

        if (roomServer != null) {
            roomServer.stopServer();
            roomServer = null;
        }

        currentRoomCode = "";
        currentRoomName = DEFAULT_ROOM_NAME;
        currentHostIp = "";
        currentServiceName = "";
        currentPort = 0;

        if (!silent) {
            notifyHostStatus("stopped", null);
        }
        releaseMulticastLockIfIdle();
    }

    private void stopDiscoveryInternal(boolean clearRooms) {
        if (nsdManager != null && discoveryListener != null) {
            try {
                nsdManager.stopServiceDiscovery(discoveryListener);
            } catch (Exception ignored) {
            }
        }
        discoveryListener = null;
        discoveryActive = false;

        if (clearRooms) {
            discoveredRooms.clear();
        }
        notifyRoomsUpdated();
        releaseMulticastLockIfIdle();
    }

    private boolean hasLanPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return getPermissionState("nearbyWifi") == PermissionState.GRANTED;
        }
        return getPermissionState("location") == PermissionState.GRANTED;
    }

    private void requestLanPermission(PluginCall call, String callbackName) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissionForAlias("nearbyWifi", call, callbackName);
        } else {
            requestPermissionForAlias("location", call, callbackName);
        }
    }

    private JSObject buildHostPayload(String status) {
        JSObject payload = new JSObject();
        payload.put("status", status);
        payload.put("roomCode", currentRoomCode);
        payload.put("roomName", currentRoomName);
        payload.put("hostIp", currentHostIp);
        payload.put("port", currentPort);
        payload.put("serviceName", currentServiceName);
        payload.put("deviceName", deviceName);
        return payload;
    }

    private void notifyHostStatus(String status, String message) {
        JSObject payload = buildHostPayload(status);
        if (!TextUtils.isEmpty(message)) {
            payload.put("message", message);
        }
        notifyListeners("hostStatusChanged", payload, true);
    }

    private void notifyRoomsUpdated() {
        JSObject payload = new JSObject();
        payload.put("rooms", roomsAsArray());
        notifyListeners("roomsUpdated", payload, true);
    }

    private JSArray roomsAsArray() {
        JSArray rooms = new JSArray();
        for (JSObject room : discoveredRooms.values()) {
            rooms.put(room);
        }
        return rooms;
    }

    private JSObject toRoomPayload(NsdServiceInfo serviceInfo) {
        InetAddress host = serviceInfo.getHost();
        if (host == null) {
            return null;
        }

        String hostIp = host.getHostAddress();
        String roomCode = getAttribute(serviceInfo, "roomCode");
        String roomName = getAttribute(serviceInfo, "roomName");
        String remoteDeviceName = getAttribute(serviceInfo, "deviceName");

        if (TextUtils.isEmpty(roomCode)) {
            roomCode = extractRoomCode(serviceInfo.getServiceName());
        }
        if (TextUtils.isEmpty(roomCode)) {
            return null;
        }

        JSObject payload = new JSObject();
        payload.put("roomCode", roomCode);
        payload.put("roomName", TextUtils.isEmpty(roomName) ? DEFAULT_ROOM_NAME : roomName);
        payload.put("deviceName", TextUtils.isEmpty(remoteDeviceName) ? serviceInfo.getServiceName() : remoteDeviceName);
        payload.put("hostIp", hostIp);
        payload.put("port", serviceInfo.getPort());
        payload.put("serviceName", serviceInfo.getServiceName());
        payload.put("connectionStatus", "available");
        return payload;
    }

    private String getAttribute(NsdServiceInfo serviceInfo, String key) {
        try {
            byte[] value = serviceInfo.getAttributes().get(key);
            if (value == null) {
                return "";
            }
            return new String(value, StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            return "";
        }
    }

    private void acquireMulticastLock() {
        try {
            WifiManager wifiManager = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager == null) {
                return;
            }
            if (multicastLock == null) {
                multicastLock = wifiManager.createMulticastLock("GeniYingLanDiscovery");
                multicastLock.setReferenceCounted(false);
            }
            if (!multicastLock.isHeld()) {
                multicastLock.acquire();
            }
        } catch (Exception ignored) {
        }
    }

    private void releaseMulticastLockIfIdle() {
        if (multicastLock == null) {
            return;
        }
        if (discoveryActive || roomServer != null) {
            return;
        }
        try {
            if (multicastLock.isHeld()) {
                multicastLock.release();
            }
        } catch (Exception ignored) {
        }
    }

    private String sanitizeRoomName(String rawRoomName) {
        String trimmed = rawRoomName == null ? "" : rawRoomName.trim();
        if (trimmed.isEmpty()) {
            return DEFAULT_ROOM_NAME;
        }
        if (trimmed.length() > 24) {
            return trimmed.substring(0, 24);
        }
        return trimmed;
    }

    private String buildServiceName(String roomCode, String roomName) {
        String compactName = roomName.replaceAll("[^\\p{L}\\p{N}]+", "");
        if (compactName.length() > 12) {
            compactName = compactName.substring(0, 12);
        }
        return String.format(Locale.US, "GYPB-%s-%s", roomCode, compactName.isEmpty() ? "Room" : compactName);
    }

    private String extractRoomCode(String serviceName) {
        if (serviceName == null) {
            return "";
        }
        String[] parts = serviceName.split("-");
        for (String part : parts) {
            if (part.matches("\\d{4}")) {
                return part;
            }
        }
        return "";
    }

    private String createRoomCode() {
        int number = 1000 + (int) (Math.random() * 9000);
        return String.valueOf(number);
    }

    private String buildDeviceName() {
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        String combined = (manufacturer + " " + model).trim();
        return combined.isEmpty() ? "Android" : combined;
    }

    private String findLocalIpv4() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            for (NetworkInterface networkInterface : Collections.list(interfaces)) {
                if (!networkInterface.isUp() || networkInterface.isLoopback()) {
                    continue;
                }
                for (InetAddress address : Collections.list(networkInterface.getInetAddresses())) {
                    if (address instanceof Inet4Address && !address.isLoopbackAddress()) {
                        return address.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return "";
    }
}
