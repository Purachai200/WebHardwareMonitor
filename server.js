const express = require('express');

const http = require('http');

const WebSocket = require('ws');

const axios = require('axios');

const path = require('path');

const qrcode = require('qrcode-terminal');

const ip = require('ip');

const { exec } = require('child_process');



const app = express();

const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

const PORT = 3000;

const LHM_API = 'http://localhost:8085/data.json';
const MY_IP = ip.address();

const publicPath = app.isPackaged 
  ? path.join(process.resourcesPath, 'public') 
  : path.join(__dirname, 'public');

app.use(express.static(publicPath));

// ฟังก์ชันแกะข้อมูลแบบใหม่ (แม่นยำ 100% และดึงชื่อรุ่นได้)
function parseHardwareData(json) {
    let stats = {
        cpuName: "Unknown CPU", cpuLoad: 0, cpuTemp: 0,
        gpuName: "Unknown GPU", gpuLoad: 0, gpuTemp: 0,
        ramLoad: 0, hddLoad: 0
    };

    try {
        const hardwares = json.Children[0].Children;
        for (let hw of hardwares) {
            // เช็คว่าเป็น CPU
            if (hw.ImageURL.includes("cpu")) {
                stats.cpuName = hw.Text; // ได้ชื่อรุ่น CPU
                let load = hw.Children.find(c => c.Text === "Load");
                if (load) {
                    let totalLoad = load.Children.find(c => c.Text === "CPU Total");
                    if (totalLoad) stats.cpuLoad = parseFloat(totalLoad.Value);
                }
                let temp = hw.Children.find(c => c.Text === "Temperatures");
                if (temp) {
                    // รองรับทั้ง Intel และ AMD
                    let pkgTemp = temp.Children.find(c => c.Text === "CPU Package" || c.Text === "Core Average" || c.Text === "Core (Tctl/Tdie)");
                    if (pkgTemp) stats.cpuTemp = parseFloat(pkgTemp.Value);
                }
            }

            // เช็คว่าเป็น GPU (Nvidia / AMD)
            else if (hw.ImageURL.includes("nvidia") || hw.ImageURL.includes("ati") || hw.ImageURL.includes("amd")) {
                stats.gpuName = hw.Text; // ได้ชื่อรุ่น GPU
                let load = hw.Children.find(c => c.Text === "Load");
                if (load) {
                    let coreLoad = load.Children.find(c => c.Text === "GPU Core");
                    if (coreLoad) stats.gpuLoad = parseFloat(coreLoad.Value);
                }
                let temp = hw.Children.find(c => c.Text === "Temperatures");
                if (temp) {
                    let coreTemp = temp.Children.find(c => c.Text === "GPU Core");
                    if (coreTemp) stats.gpuTemp = parseFloat(coreTemp.Value);
                }
            }

            // เช็คว่าเป็น RAM
            else if (hw.ImageURL.includes("ram")) {
                let load = hw.Children.find(c => c.Text === "Load");
                if (load) {
                    let memLoad = load.Children.find(c => c.Text === "Memory");
                    if (memLoad) stats.ramLoad = parseFloat(memLoad.Value);
                }
            }

            // เช็คว่าเป็น HDD/SSD
            else if (hw.ImageURL.includes("hdd")) {
                let load = hw.Children.find(c => c.Text === "Load");
                if (load) {
                    let space = load.Children.find(c => c.Text === "Used Space");
                    if (space) stats.hddLoad = parseFloat(space.Value);
                }
            }
        }
    } catch (err) { }
    return stats;
}

// ระบบสั่งงาน PC
function executeCommand(cmd) {
    if (cmd === 'toggle_speaker') {
        exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]173)"'); // Mute/Unmute
    } else if (cmd === 'spk_up') {
        exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]175)"'); // Volume Up
    } else if (cmd === 'spk_down') {
        exec('powershell -c "(new-object -com wscript.shell).SendKeys([char]174)"'); // Volume Down
    } else if (cmd === 'toggle_mic') {
        // คำสั่งปิดไมค์ (ต้องใช้โปรแกรมเสริม หรือใช้ SoundVolumeView Command line)
        // พื้นฐานของ Windows ไม่มีปุ่มลัด Mute ไมค์ครับ
        console.log("Mic Mute toggled");
    } else if (cmd === 'mic_up') {
        console.log("Mic Vol Up"); // Windows ไม่มีคำสั่งง่ายๆ สำหรับเร่งเสียงไมค์ผ่าน Script พื้นฐาน
    } else if (cmd === 'mic_down') {
        console.log("Mic Vol Down");
    } else if (cmd === 'open_settings') {
        exec('start ms-settings:'); // เปิด Settings
    } else if (cmd === 'open_taskmgr') {
        exec('start taskmgr'); // เปิด Task Manager
    }
}

function drawPCGui() {
    console.clear();
    console.log('\x1b[36m%s\x1b[0m', '   🚀 IPAD SIDEBAR MONITOR ACTIVE');
    console.log(`\n   [URL]    : \x1b[33mhttp://${MY_IP}:${PORT}\x1b[0m\n`);
    qrcode.generate(`http://${MY_IP}:${PORT}`, { small: true });

}

wss.on('connection', function (ws) {
    console.log(`\x1b[32m   [CONNECTED]\x1b[0m iPad Connected`);

    ws.on('message', function (message) {
        try {
            var data = JSON.parse(message);
            if (data.command) executeCommand(data.command);
        } catch (e) { }
    });

    var timer = setInterval(async function () {
        try {
            var res = await axios.get(LHM_API);
            var stats = parseHardwareData(res.data);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(stats));
        } catch (e) { }

    }, 1000);

    ws.on('close', function () { clearInterval(timer); });

});

server.listen(PORT, drawPCGui);