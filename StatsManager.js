const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class StatsManager {
    constructor() {
        this.statsPath = path.join(app.getPath('userData'), 'stats_history.json');
        this.stats = this.loadStats();
    }

    loadStats() {
        try {
            if (fs.existsSync(this.statsPath)) {
                const data = JSON.parse(fs.readFileSync(this.statsPath));
                // Basic validation and reset session start
                data.sessionStartTime = Date.now();
                if (!data.hourlyPower) data.hourlyPower = [];
                if (!data.dailyStats) data.dailyStats = {};
                if (!data.monthlyStats) data.monthlyStats = {};
                if (data.totalPowerKwh === undefined) data.totalPowerKwh = 0;
                return data;
            }
        } catch (e) { console.error("Load stats error:", e); }

        return {
            totalPowerKwh: 0,
            hourlyPower: [], // [{time, watts}]
            dailyStats: {},   // { "2024-04-10": { powerKwh, uptimeSeconds } }
            monthlyStats: {}, // { "2024-04": { powerKwh, cost, uptimeSeconds } }
            sessionStartTime: Date.now()
        };
    }

    saveStats() {
        try {
            fs.writeFileSync(this.statsPath, JSON.stringify(this.stats));
        } catch (e) { console.error("Save stats error:", e); }
    }

    update(watts, costPerUnit = 8) {
        if (!watts || watts < 1) return;

        const now = Date.now();
        const date = new Date();
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const dateStr = date.toISOString().split('T')[0];
        const monthStr = dateStr.substring(0, 7); // YYYY-MM

        // 1. Hourly/Real-time History (limit to last 60 points)
        this.stats.hourlyPower.push({ time: timeStr, watts: watts });
        if (this.stats.hourlyPower.length > 60) this.stats.hourlyPower.shift();

        // 2. Accumulate Power (Watts to kWh) roughly every 2 seconds
        const kwh = (watts * 2) / 3600000;
        this.stats.totalPowerKwh += kwh;

        // 3. Daily Stats
        if (!this.stats.dailyStats[dateStr]) {
            this.stats.dailyStats[dateStr] = { powerKwh: 0, uptimeSeconds: 0 };
        }
        this.stats.dailyStats[dateStr].powerKwh += kwh;
        this.stats.dailyStats[dateStr].uptimeSeconds += 2;

        // 4. Monthly Stats (for summary)
        if (!this.stats.monthlyStats[monthStr]) {
            this.stats.monthlyStats[monthStr] = { powerKwh: 0, cost: 0, uptimeSeconds: 0 };
        }
        this.stats.monthlyStats[monthStr].powerKwh += kwh;
        this.stats.monthlyStats[monthStr].cost = this.stats.monthlyStats[monthStr].powerKwh * costPerUnit;
        this.stats.monthlyStats[monthStr].uptimeSeconds += 2;

        if (Math.random() < 0.05) this.saveStats();
    }

    clearStats() {
        this.stats = {
            totalPowerKwh: 0,
            hourlyPower: [],
            dailyStats: {},
            monthlyStats: {},
            sessionStartTime: Date.now()
        };
        this.saveStats();
    }

    getSummary(costPerUnit = 8) {
        const todayStr = new Date().toISOString().split('T')[0];
        const todayStats = this.stats.dailyStats[todayStr] || { powerKwh: 0, uptimeSeconds: 0 };
        
        return {
            totalPowerKwh: this.stats.totalPowerKwh.toFixed(4),
            totalCostThb: (this.stats.totalPowerKwh * costPerUnit).toFixed(2),
            todayPowerKwh: todayStats.powerKwh.toFixed(4),
            todayCostThb: (todayStats.powerKwh * costPerUnit).toFixed(2),
            costPerUnit: costPerUnit,
            sessionUptimeSeconds: Math.floor((Date.now() - this.stats.sessionStartTime) / 1000),
            history: this.stats.hourlyPower,
            monthlyHistory: this.stats.monthlyStats
        };
    }
}

module.exports = StatsManager;
