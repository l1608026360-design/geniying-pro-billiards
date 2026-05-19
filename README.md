# 掌上台球联机版

这个项目现在已经是可落地的手机台球应用，包含：

- 练习模式
- AI 对战
- 4 位房号双人联机
- 拉杆力度条和弹簧拉力示意
- 目标球碰撞后的虚线角度辅助
- PWA 安装能力
- Capacitor 安卓壳工程

## 关键文件

- Web 入口: [index.html](/C:/Users/16080/Documents/Codex/2026-05-19/files-mentioned-by-the-user-billiards/index.html)
- 游戏逻辑: [src/main.js](/C:/Users/16080/Documents/Codex/2026-05-19/files-mentioned-by-the-user-billiards/src/main.js)
- 样式: [src/styles.css](/C:/Users/16080/Documents/Codex/2026-05-19/files-mentioned-by-the-user-billiards/src/styles.css)
- 房间中继服务: [server/index.js](/C:/Users/16080/Documents/Codex/2026-05-19/files-mentioned-by-the-user-billiards/server/index.js)
- 安卓工程: [android](/C:/Users/16080/Documents/Codex/2026-05-19/files-mentioned-by-the-user-billiards/android)

## 两台手机一起玩

最稳的方式是开本地联机服务，然后两台手机都访问同一个地址。

```bash
npm install
npm run serve:lan
```

启动后终端会打印可访问地址，例如：

```text
http://192.168.31.128:8787
```

两台手机连到同一个 Wi‑Fi 后：

1. 都打开这个地址
2. 房主点“创建联机房间”
3. 另一台输入 4 位房号加入
4. 浏览器里可以直接“添加到主屏幕”当成 App 用

## 安卓 App 使用

安卓工程已经生成好：

```bash
npm run cap:sync
```

然后用 Android Studio 打开 [android](/C:/Users/16080/Documents/Codex/2026-05-19/files-mentioned-by-the-user-billiards/android)。

首次装到手机后：

1. 打开 App
2. 在大厅展开“联机服务器”
3. 填入 `ws://你的电脑局域网IP:8787/ws`
4. 保存后，两台手机都连同一个服务器即可联机

如果你把 [server/index.js](/C:/Users/16080/Documents/Codex/2026-05-19/files-mentioned-by-the-user-billiards/server/index.js) 部署到公网，也可以把这里改成 `wss://你的域名/ws`。

## 打包 APK

当前目录已经有 Capacitor 安卓壳，但这个环境里没有 Java / Android SDK，所以我没法直接出 APK 文件。

你本机可以在 Android Studio 里执行：

1. `Build > Build Bundle(s) / APK(s) > Build APK(s)`
2. 或接真机后直接 `Run`

## 说明

- 联机已经从 Firebase 占位逻辑改成项目自带的房间中继。
- 现在的双人联机更适合“同 Wi‑Fi 两台手机一起玩”或者“把中继服务部署到公网后远程联机”。
- AI 是陪打型难度，适合练手。
