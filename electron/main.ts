import { app, shell, BrowserWindow, clipboard, dialog, ipcMain, IpcMainEvent } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getRiotClientInfo, getTokens, getUserInfo } from "./util/riot-client.ts";
import { initSettingsIpc } from "./modules/profiles";
import { initCareerIpc } from "./modules/career";
import { initReplaysIpc } from "./modules/replays";
import { autoUpdater } from "electron-updater"
import { initialize, trackEvent } from "@aptabase/electron/main";
import Store from "./util/store.ts";

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.js
// │
process.env.DIST = path.join(__dirname, '../dist')
process.env.PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

function configureWritableSessionData() {
    const basePath = app.isPackaged
        ? process.env.LOCALAPPDATA || app.getPath('temp')
        : path.join(process.cwd(), '.tmp', 'electron-runtime');
    const sessionDataPath = path.join(basePath, 'ValoUtils', 'session-data');
    const diskCachePath = path.join(sessionDataPath, 'Cache');
    const crashDumpsPath = path.join(basePath, 'ValoUtils', 'crash-dumps');

    try {
        mkdirSync(diskCachePath, { recursive: true });
        mkdirSync(crashDumpsPath, { recursive: true });
        app.setPath('sessionData', sessionDataPath);
        app.setPath('crashDumps', crashDumpsPath);
        app.commandLine.appendSwitch('disk-cache-dir', diskCachePath);
        app.commandLine.appendSwitch('disable-http-cache');
        app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
        app.commandLine.appendSwitch('disable-crash-reporter');
    } catch (error) {
        console.warn('Unable to configure Electron session cache path:', error);
    }
}

configureWritableSessionData();

initialize("A-US-3830100076");

let win: BrowserWindow | null
// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

const height = 720;
const width = 1000;

const config = new Store({
    configName: 'config',
    defaults: {
        openDevTools: false,
        autoUpdate: true,
    }
})

function createWindow() {
    win = new BrowserWindow({
        width,
        height,
        minWidth: 760,
        minHeight: 560,
        frame: true,
        show: true,
        resizable: true,
        fullscreenable: true,
        icon: path.join(process.env.PUBLIC, 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
        },
    })
    win.setMenu(null);
    if (config.get("openDevTools")) win.webContents.openDevTools();
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url)
        return { action: 'deny' }
    })

    if (VITE_DEV_SERVER_URL) {
        win.loadURL(VITE_DEV_SERVER_URL)
    } else {
        // win.loadFile('dist/index.html')
        win.loadFile(path.join(process.env.DIST, 'index.html'))
    }
}
const checkUpdate = async () => {
    if (config.get("autoUpdate")) {
        await autoUpdater.checkForUpdatesAndNotify();
    }
}
autoUpdater.on('checking-for-update', () => {
    console.log("Checking for updates...");
    win?.webContents.send("update:checking");
    win?.webContents.send("alert:info", "Checking for updates...");
})
autoUpdater.on('update-available', (info) => {
    console.log("Update available, downloading...");
    win?.webContents.send("update:available", JSON.stringify(info));
    win?.webContents.send("alert:info", "Update available, downloading...");
    trackEvent("update_downloading");
})

autoUpdater.on('update-not-available', (info) => {
    console.log("Update not available");
    win?.webContents.send("update:not-available", JSON.stringify(info));
    win?.webContents.send("alert:info", "No updates available.");
})
autoUpdater.on('error', (err) => {
    console.error("Error while updating: ", err);
    win?.webContents.send("update:error", err);
})
autoUpdater.on('download-progress', (progressObj) => {
    let log_message = "Download speed: " + progressObj.bytesPerSecond;
    log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
    log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
    console.log(log_message);
    win?.webContents.send("update:download-progress", progressObj);
})
autoUpdater.on('update-downloaded', (info) => {
    console.log("Update downloaded");
    win?.webContents.send("update:downloaded", JSON.stringify(info));
    win?.webContents.send("alert:info", "Successfully downloaded update. Restarting...");
    autoUpdater.quitAndInstall(true, true);
});

app.on('window-all-closed', () => {
    win = null
    app.quit(); // SUPER IMPORTANT I HAD 100 PROCESSES RUNNING IN THE BACKGROUND LOL
})

app.on('ready', async () => {
    await checkUpdate();
});
app.whenReady().then(createWindow)

ipcMain.on("open_url", (_: IpcMainEvent, url: string) => {
    console.log("Opening URL in browser: ", url);
    trackEvent("open_url", { url: url });
    shell.openExternal(url);
});

ipcMain.on("version", (event: IpcMainEvent) => {
    const version = app.getVersion();
    event.sender.send("version", version);
});

ipcMain.on("client_info:get", async (event: IpcMainEvent) => {
    event.sender.send("client_info:get", JSON.stringify(await getRiotClientInfo()));
});

ipcMain.on("tokens:get", async (event: IpcMainEvent) => {
    event.sender.send("tokens:get", JSON.stringify(await getTokens()));
});

ipcMain.on("tokens:refresh", async (event: IpcMainEvent) => {
    event.sender.send("tokens:refresh", JSON.stringify(await getTokens(true)));
});

ipcMain.on("userinfo:get", async (event: IpcMainEvent) => {
    try {
        event.sender.send("userinfo:get", JSON.stringify(await getUserInfo()));
    } catch (error) {
        event.sender.send("userinfo:get", JSON.stringify({ error: (error as any).toString() }));
    }
});

ipcMain.on("clipboard:get", async (event: IpcMainEvent) => {
    event.sender.send("clipboard:get", JSON.stringify({
        text: clipboard.readText(),
    }));
});
ipcMain.on("clipboard:set", async (event: IpcMainEvent, text: string) => {
    clipboard.writeText(text);
    event.sender.send("clipboard:set", JSON.stringify({
        text: clipboard.readText(),
    }));
});

ipcMain.on("debug:save-json", async (event: IpcMainEvent, filename: string, json: string) => {
    const { filePath, canceled } = await dialog.showSaveDialog({
        title: "Save JSON",
        defaultPath: filename,
        filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) {
        event.sender.send("debug:save-json", JSON.stringify({ success: false }));
        return;
    }
    writeFileSync(filePath, json, "utf-8");
    event.sender.send("debug:save-json", JSON.stringify({ success: true, filePath }));
});

ipcMain.on("analytics:track", async (_: IpcMainEvent, event: string, data: string) => {
    trackEvent(event, JSON.parse(data));
});

ipcMain.on("update:check", async () => {
    await checkUpdate();
});

ipcMain.on("config:get-all", (event: IpcMainEvent) => {
    event.sender.send("config:get-all", JSON.stringify({
        autoUpdate: config.get("autoUpdate") ?? true,
        openDevTools: config.get("openDevTools") ?? false,
    }));
});

ipcMain.on("config:set", (event: IpcMainEvent, key: string, value: any) => {
    config.set(key, value);
    event.sender.send("config:set", JSON.stringify({ success: true, key }));
});

initSettingsIpc();
initCareerIpc();
initReplaysIpc();
if (config.get("autoUpdate")) {
    setInterval(async () => {
        try {
            await checkUpdate();
        } catch (error) {
            console.error("Error while checking for updates: ", error);
        }
    }, 1000 * 60 * 60) // auto check for updates every hour
}
