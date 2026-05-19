package com.codex.billiards;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LanRoomPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
