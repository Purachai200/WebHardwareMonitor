const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const AutoLaunch = require('auto-launch');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const ip = require('ip');

let win;
let tray = null;
let serverInstance = null;

const appAutoLauncher = new AutoLaunch({
    name: 'PC Monitor Hub',
    path: app.getPath('exe'),
});

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
            
            // 1. Motherboard (ดึงอุณหภูมิ, Vcore, และ พัดลม)
            if (id === "/motherboard") {
                stats.mb.name = hw.Text;
                if (hw.Children) {
                    for (let chip of hw.Children) {
                        if (chip.Children) {
                            // อุณหภูมิบอร์ด
                            let temps = chip.Children.find(c => c.Text === "Temperatures");
                            if (temps && temps.Children.length > 0) stats.mb.temp = parseFloat(temps.Children[0].Value);
                            
                            // แรงดันไฟ Vcore
                            let volts = chip.Children.find(c => c.Text === "Voltages");
                            if (volts) {
                                let vcore = volts.Children.find(c => c.Text.toLowerCase().includes("vcore"));
                                if (vcore) stats.mb.vcore = parseFloat(vcore.Value);
                            }
                            
                            // ดึงพัดลมระบบ/CPU ที่ต่อเข้าบอร์ด
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
            
            // 2. CPU (อัปเกรดความแม่นยำและเพิ่ม Fallback)
            else if (id.includes("/amdcpu") || id.includes("/intelcpu")) {
                stats.cpu.name = hw.Text;
                let load = hw.Children.find(c => c.Text === "Load");
                if (load) {
                    let tot = load.Children.find(c => c.Text.includes("Total"));
                    if (tot) stats.cpu.load = parseFloat(tot.Value);
                }
                let temps = hw.Children.find(c => c.Text === "Temperatures");
                if (temps && temps.Children && temps.Children.length > 0) {
                    // ใช้ includes เพื่อความยืดหยุ่น เผื่อมีเว้นวรรคหรือตัวอักษรซ่อน
                    let pkg = temps.Children.find(c => 
                        c.Text.includes("Package") || 
                        c.Text.includes("Average") || 
                        c.Text.includes("Tctl") || 
                        c.Text.includes("Tdie")
                    );
                    
                    // Fallback: ถ้าหาชื่อเซ็นเซอร์หลักไม่เจอเลย ให้ดึงตัวแรกสุดที่เจอมาใช้แทน
                    if (!pkg) {
                        pkg = temps.Children[0];
                    }
                    
                    if (pkg) stats.cpu.temp = parseFloat(pkg.Value);
                }
            }
            
            // 3. GPU
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
                    if (!core) core = temps.Children[0]; // Fallback ให้ GPU ด้วย
                    if (core) gTemp = parseFloat(core.Value);
                }
                stats.gpus.push({ name: hw.Text, load: gLoad, temp: gTemp });
            }
            
            // 4. RAM
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
            
            // 5. Storage
            else if (id.includes("/hdd") || id.includes("/ssd")) {
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
    } catch (err) { console.error("Parse Error:", err); }
    return stats;
}

function executeCommand(cmd) {
    if (cmd === 'toggle_speaker') exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]173)"');
    else if (cmd === 'spk_up') exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]175)"');
    else if (cmd === 'spk_down') exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]174)"');
    else if (cmd === 'toggle_mic') exec('powershell -c "$m = New-Object -ComObject Shell.Application; $m.mutesysvolume(2)"'); 
}

function startServer() {
    const expressApp = express();
    const server = http.createServer(expressApp);
    const wss = new WebSocket.Server({ server });
    const PORT = process.env.PORT || 3000;
    const LHM_API = 'http://localhost:8085/data.json';

    const publicPath = app.isPackaged ? path.join(process.resourcesPath, 'public') : path.join(__dirname, 'public');
    expressApp.use(express.static(publicPath));

    wss.on('connection', (ws) => {
        const timer = setInterval(async () => {
            try {
                const res = await axios.get(LHM_API);
                const stats = parseHardwareData(res.data);
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(stats));
            } catch (e) { }
        }, 1000);
        ws.on('message', (msg) => {
            try {
                const data = JSON.parse(msg);
                if (data.command) executeCommand(data.command);
            } catch (e) { }
        });
        ws.on('close', () => clearInterval(timer));
    });

    serverInstance = server.listen(PORT, () => {
        if (win) win.webContents.send('server-log', `Server running on port ${PORT}`);
    });
}

function stopServer() { if (serverInstance) serverInstance.close(); }

function createWindow() {
    win = new BrowserWindow({
        width: 550, height: 800, title: "PC Monitor Hub",
        resizable: false, autoHideMenuBar: true, backgroundColor: '#1a1b26',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    win.loadFile('index.html');
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.ico'); 
    let icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty(); 
    tray = new Tray(icon);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show App', click: () => win.show() },
        { label: 'Exit', click: () => { app.isQuiting = true; stopServer(); app.quit(); } }
    ]);
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => win.show());
}

app.whenReady().then(() => {
    createWindow();
    createTray();
    startServer();
});

ipcMain.on('toggle-server', (event, start) => {
    if (start) { if (!serverInstance) startServer(); } else stopServer();
});
ipcMain.on('minimize-to-tray', () => win.hide());
ipcMain.on('open-hwm', () => {
    require('dotenv').config();
    if (process.env.LHM_PATH) exec(`"${process.env.LHM_PATH}"`);
});