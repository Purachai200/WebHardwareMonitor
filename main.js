const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
let AutoLaunch;
try {
    AutoLaunch = require('auto-launch');
} catch (e) {
    console.log("auto-launch not installed, skipping...");
}
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const ip = require('ip');

let win;
let tray = null;
let serverInstance = null;

const appAutoLauncher = AutoLaunch ? new AutoLaunch({
    name: 'PC Monitor Hub',
    path: app.getPath('exe'),
}) : null;

// ================= DEBUG HELPER =================
function sendLog(msg) {
    console.log(msg);
    if (win) win.webContents.send('server-log', msg);
}

// ฟังก์ชันแกะข้อมูล Hardware ให้ตรงกับ Data.json ของคุณ
function parseHardwareData(json) {
    let stats = {
        mb: { name: "Motherboard", temp: 0, vcore: 0, fans: [] },
        cpu: { name: "CPU", load: 0, temp: 0 },
        gpus: [],
        rams: [],
        storage: []
    };

    try {
        const hardwares = json.Children[0].Children;

        for (let hw of hardwares) {
            let id = hw.HardwareId || "";

            if (id === "/motherboard") {
                stats.mb.name = hw.Text;

                if (hw.Children) {
                    for (let chip of hw.Children) {
                        if (chip.Children) {

                            let temps = chip.Children.find(c => c.Text === "Temperatures");
                            if (temps && temps.Children.length > 0) stats.mb.temp = parseFloat(temps.Children[0].Value);

                            let volts = chip.Children.find(c => c.Text === "Voltages");
                            if (volts) {
                                let vcore = volts.Children.find(c => c.Text.toLowerCase().includes("vcore"));
                                if (vcore) stats.mb.vcore = parseFloat(vcore.Value);
                            }

                            let fans = chip.Children.find(c => c.Text === "Fans");
                            if (fans) {
                                fans.Children.forEach(f => {
                                    let rpm = parseFloat(f.Value);
                                    if (rpm > 0) stats.mb.fans.push({ name: f.Text, rpm: rpm });
                                });
                            }
                        }
                    }
                }
            }

            else if (id.includes("/amdcpu") || id.includes("/intelcpu")) {
                stats.cpu.name = hw.Text;

                let load = hw.Children.find(c => c.Text === "Load");
                if (load) {
                    let tot = load.Children.find(c => c.Text.includes("Total"));
                    if (tot) stats.cpu.load = parseFloat(tot.Value);
                }

                let temps = hw.Children.find(c => c.Text === "Temperatures");
                if (temps && temps.Children && temps.Children.length > 0) {

                    let pkg = temps.Children.find(c =>
                        c.Text.includes("Package") ||
                        c.Text.includes("Average") ||
                        c.Text.includes("Tctl") ||
                        c.Text.includes("Tdie")
                    );

                    if (!pkg) pkg = temps.Children[0];

                    if (pkg) stats.cpu.temp = parseFloat(pkg.Value);
                }
            }

            else if (id.includes("/gpu")) {
                let gLoad = 0, gTemp = 0;

                let load = hw.Children.find(c => c.Text === "Load");
                if (load) {
                    let core = load.Children.find(c => c.Text === "GPU Core");
                    if (core) gLoad = parseFloat(core.Value);
                }

                let temps = hw.Children.find(c => c.Text === "Temperatures");
                if (temps && temps.Children && temps.Children.length > 0) {
                    let core = temps.Children.find(c => c.Text.includes("GPU Core") || c.Text.includes("Core"));
                    if (!core) core = temps.Children[0];
                    if (core) gTemp = parseFloat(core.Value);
                }

                stats.gpus.push({ name: hw.Text, load: gLoad, temp: gTemp });
            }

            else if (id === "/ram") {
                let rLoad = 0, rTemp = 0;

                let load = hw.Children.find(c => c.Text === "Load");
                if (load) {
                    let mem = load.Children.find(c => c.Text === "Memory");
                    if (mem) rLoad = parseFloat(mem.Value);
                }

                let temps = hw.Children.find(c => c.Text === "Temperatures");
                if (temps && temps.Children && temps.Children.length > 0) {
                    rTemp = parseFloat(temps.Children[0].Value);
                }

                stats.rams.push({ name: hw.Text, load: rLoad, temp: rTemp });
            }

            else if (
                id.includes("/hdd") ||
                id.includes("/ssd") ||
                id.includes("/nvme") ||
                id.toLowerCase().includes("disk")
            ) {
                let dLoad = 0, dTemp = 0;

                let load = hw.Children.find(c => c.Text === "Load");
                if (load) {
                    let space = load.Children.find(c => c.Text === "Used Space");
                    if (space) dLoad = parseFloat(space.Value);
                }

                let temps = hw.Children.find(c => c.Text === "Temperatures");
                if (temps && temps.Children && temps.Children.length > 0) {
                    dTemp = parseFloat(temps.Children[0].Value);
                }

                stats.storage.push({ name: hw.Text, load: dLoad, temp: dTemp });
            }
        }

    } catch (err) {
        console.error("Parse Error:", err);
        sendLog("❌ Parse Error: " + err.message);
    }

    return stats;
}

function executeCommand(cmd) {
    sendLog("⚡ Execute command: " + cmd);

    if (cmd === 'toggle_speaker') exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]173)"');
    else if (cmd === 'spk_up') exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]175)"');
    else if (cmd === 'spk_down') exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]174)"');
    else if (cmd === 'toggle_mic') exec('powershell -c "$m = New-Object -ComObject Shell.Application; $m.mutesysvolume(2)"');
}

function startServer() {
    sendLog("🔥 startServer called");

    const expressApp = express();

    // ================= 🔥 SERVE WEB =================
    const publicPath = path.join(__dirname, 'public');

    expressApp.use(express.static(publicPath));

    // กันเคสเข้า / แล้วไม่เจอ
    expressApp.get('/', (req, res) => {
        res.sendFile(path.join(publicPath, 'index.html'));
    });

    // debug route
    expressApp.get('/health', (req, res) => {
        res.json({ status: 'ok' });
    });

    // ================= SERVER =================
    const server = http.createServer(expressApp);
    const wss = new WebSocket.Server({ server });

    const PORT = 9674;
    const LHM_API = 'http://localhost:8085/data.json';

    // ================= WEBSOCKET =================
    wss.on('connection', (ws) => {
        sendLog("📱 Client connected");

        const timer = setInterval(async () => {
            try {
                const res = await axios.get(LHM_API);
                const stats = parseHardwareData(res.data);

                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(stats));
                }

            } catch (e) {
                sendLog("❌ LHM fetch error: " + e.message);
            }
        }, 2000);

        ws.on('message', (msg) => {
            sendLog("📩 WS message: " + msg);

            try {
                const data = JSON.parse(msg);
                if (data.command) executeCommand(data.command);
            } catch (e) {
                sendLog("❌ WS parse error");
            }
        });

        ws.on('close', () => {
            sendLog("📴 Client disconnected");
            clearInterval(timer);
        });
    });

    // ================= START =================
    serverInstance = server.listen(PORT, () => {
        const info = {
            ip: ip.address(),
            port: PORT
        };

        sendLog(`🚀 Server running on ${info.ip}:${PORT}`);
        sendLog(`🌐 Open: http://${info.ip}:${PORT}`);

        if (win) {
            win.webContents.send('server-info', info);
            win.webContents.send('server-status', true);
        }
    });

    // ================= ERROR =================
    server.on('error', (err) => {
        sendLog("❌ Server error: " + err.message);

        if (err.code === 'EADDRINUSE') {
            sendLog("❌ Port already in use: " + PORT);
        }

        if (win) win.webContents.send('server-status', false);
    });
}

function stopServer() {
    sendLog("🛑 stopServer called");

    if (serverInstance) {
        serverInstance.close();
        serverInstance = null;

        if (win) win.webContents.send('server-status', false);
    }
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.ico');
    let icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();

    tray = new Tray(icon);

    function buildMenu() {
        return Menu.buildFromTemplate([
            {
                label: 'Start Minimized',
                type: 'checkbox',
                checked: settings.startMinimized,
                click: (item) => {
                    settings.startMinimized = item.checked;
                    saveSettings();
                }
            },
            {
                label: 'Minimize To Tray',
                type: 'checkbox',
                checked: settings.minimizeToTray,
                click: (item) => {
                    settings.minimizeToTray = item.checked;
                    saveSettings();
                }
            },
            {
                label: 'Minimize On Close',
                type: 'checkbox',
                checked: settings.closeToTray,
                click: (item) => {
                    settings.closeToTray = item.checked;
                    saveSettings();
                }
            },
            {
                label: 'Run On Windows Startup',
                type: 'checkbox',
                checked: settings.autoStart,
                click: async (item) => {
                    settings.autoStart = item.checked;
                    saveSettings();

                    if (appAutoLauncher) {
                        if (item.checked) await appAutoLauncher.enable();
                        else await appAutoLauncher.disable();
                    }
                }
            },
            { type: 'separator' },
            { label: 'Show App', click: () => win.show() },
            {
                label: 'Exit',
                click: () => {
                    app.isQuiting = true;
                    stopServer();
                    app.quit();
                }
            }
        ]);
    }

    tray.setContextMenu(buildMenu());
    tray.on('right-click', () => tray.setContextMenu(buildMenu()));
    tray.on('double-click', () => win.show());
}

const fs = require('fs');

const configPath = path.join(app.getPath('userData'), 'config.json');

let settings = {
    startMinimized: false,
    minimizeToTray: true,
    closeToTray: true,
    autoStart: false
};

function createWindow() {
    win = new BrowserWindow({
        width: 550,
        height: 800,
        title: "PC Monitor Hub",
        resizable: false,
        autoHideMenuBar: true,
        backgroundColor: '#1a1b26',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    win.loadFile('index.html');

    // ✅ ย้ายมาไว้ตรงนี้
    win.on('close', (e) => {
        if (!app.isQuiting && settings.closeToTray) {
            e.preventDefault();
            win.hide();
            sendLog("📦 Close → Tray");
        }
    });

    win.on('minimize', (e) => {
        if (settings.minimizeToTray) {
            e.preventDefault();
            win.hide();
            sendLog("📦 Minimize → Tray");
        }
    });
}

function loadSettings() {
    try {
        if (fs.existsSync(configPath)) {
            settings = JSON.parse(fs.readFileSync(configPath));
        }
    } catch (e) {
        console.log("loadSettings error");
    }
}

function saveSettings() {
    fs.writeFileSync(configPath, JSON.stringify(settings));
}
app.disableHardwareAcceleration();
app.whenReady().then(() => {
    loadSettings();

    createWindow();
    createTray();

    if (settings.autoStart && appAutoLauncher) {
        appAutoLauncher.enable();
    }

    if (settings.startMinimized) {
        win.hide();
    }

});

ipcMain.on('update-settings', (e, newSettings) => {
    settings = { ...settings, ...newSettings };
    saveSettings();

    if (appAutoLauncher) {
        if (settings.autoStart) appAutoLauncher.enable();
        else appAutoLauncher.disable();
    }
});

ipcMain.on('toggle-server', (event, start) => {
    sendLog("📡 toggle-server: " + start);

    if (start) {
        if (!serverInstance) startServer();
        else sendLog("⚠️ Server already running");
    } else {
        stopServer();
    }
});

ipcMain.on('minimize-to-tray', () => {
    sendLog("🗕 Minimize to tray");
    win.hide();
});

ipcMain.on('open-hwm', () => {
    sendLog("🖥 Open Hardware Monitor");

    require('dotenv').config();

    if (process.env.LHM_PATH) exec(`"${process.env.LHM_PATH}"`);
    else sendLog("❌ LHM_PATH not set");
});