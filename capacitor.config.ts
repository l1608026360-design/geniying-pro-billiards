import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.codex.billiards',
  appName: '思颖竞技台球: GeniYing Pro Billiards',
  webDir: 'dist',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'http',
  },
};

export default config;
