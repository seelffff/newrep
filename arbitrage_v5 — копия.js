/**
 * ARBITRAGE PRO V5 (BLESSED TUI - ALIGNED COLUMNS)
 * Features: 
 * - Perfect Column Alignment (Smart Padding)
 * - Zero Flicker
 * - Robust Interface
 */

const blessed = require('blessed');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ============================================================
// ⚙️ GLOBAL CONFIGURATION
// ============================================================
const CONFIG = {
    CAPITAL: {
        MARGIN: 20,        // Маржа ($)
        LEVERAGE: 5        // Плечо
    },
    STRATEGY: {
        ENTRY_THRESHOLD: 0.90, 
        EXIT_THRESHOLD: 0.1,   
        IGNORE_FLASH_MS: 2000, 
        COOLDOWN_MS: 300000,   
    },
    COSTS: {
        FEE_RATE: 0.0016,      
        SLIPPAGE_RATE: 0.002   
    },
    SYSTEM: {
        MAX_FLASH_STRIKES: 3,
        REFRESH_RATE: 200,
    },
    BLACKLIST: ['ALICEUSDT', 'USDCUSDT'],
    DIRS: { ROOT: './logs', DEALS: './logs/deals', FLASH: './logs/flash' }
};

const POSITION_SIZE = CONFIG.CAPITAL.MARGIN * CONFIG.CAPITAL.LEVERAGE;

// ============================================================
// 🖥️ TUI LAYOUT (BLESSED)
// ============================================================

const screen = blessed.screen({
    smartCSR: true,
    title: 'ARBITRAGE V5'
});

const style = {
    box: {
        border: { type: 'line', fg: 'cyan' },
        style: { border: { fg: 'cyan' } }
    }
};

// --- WIDGETS ---

const headerBox = blessed.box({
    top: 0, left: 0, width: '100%', height: 3,
    label: ' {bold}STATUS{/bold} ', tags: true, ...style.box
});

const metricsBox = blessed.box({
    top: 3, left: 0, width: '100%', height: 3,
    tags: true,
    border: { type: 'line', fg: 'green' },
    style: { border: { fg: 'green' } }
});

const activeBox = blessed.box({
    top: 6, left: 0, width: '100%', height: '40%',
    label: ' {bold}ACTIVE OPERATIONS{/bold} ', tags: true, ...style.box
});

const scannerBox = blessed.box({
    top: '40%+6', left: 0, width: '100%', height: '30%',
    label: ' {bold}LIVE SCANNER{/bold} ', tags: true, ...style.box
});

const logBox = blessed.box({
    bottom: 0, left: 0, width: '100%', height: '30%-6',
    label: ' {bold}SYSTEM LOGS{/bold} ', tags: true, scrollable: true,
    scrollbar: { bg: 'cyan' },
    style: { border: { fg: 'white' }, fg: 'gray' },
    border: { type: 'line' }
});

screen.append(headerBox);
screen.append(metricsBox);
screen.append(activeBox);
screen.append(scannerBox);
screen.append(logBox);

screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

// ============================================================
// 🛠️ UI HELPERS (SMART ALIGNMENT)
// ============================================================
const UI = {
    c: (text, color) => `{${color}-fg}${text}{/}`,
    
    // Умный паддинг: считает длину БЕЗ тегов цветов
    pad: (text, width) => {
        // Удаляем все теги типа {red-fg}, {/}, {bold} для подсчета длины
        const visibleText = text.replace(/\{.*?\}/g, ''); 
        const visibleLen = visibleText.length;
        const padding = Math.max(0, width - visibleLen);
        return text + ' '.repeat(padding);
    },

    bar: (val, max = 5, len = 15) => {
        const p = Math.min(Math.abs(val) / max, 1);
        const fill = Math.round(p * len);
        return UI.c('█'.repeat(fill), 'white') + UI.c('░'.repeat(len - fill), 'gray');
    },

    money: (v) => v >= 0 ? UI.c(`$${v.toFixed(2)}`, 'green') : UI.c(`$${v.toFixed(2)}`, 'red'),

    log: (msg, type = 'INFO') => {
        const t = new Date().toLocaleTimeString();
        let color = 'white';
        if (type === 'ERR') color = 'red';
        if (type === 'WIN') color = 'green';
        if (type === 'WRN') color = 'yellow';
        
        logBox.unshiftLine(`{gray-fg}[${t}]{/} {${color}-fg}${msg}{/}`);
        if (logBox.getLines().length > 50) logBox.deleteLine(50);
        screen.render();
    }
};

// ============================================================
// 🧠 STATE MANAGEMENT
// ============================================================
const state = {
    pairs: {}, activeTrades: {}, cooldowns: {}, commonPairs: [],
    blacklist: new Set(CONFIG.BLACKLIST), flashStrikes: {},
    stats: { startTime: new Date(), realDeals: 0, netProfit: 0, feesPaid: 0, slippageLost: 0 }
};

Object.values(CONFIG.DIRS).forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ============================================================
// 🚀 LOGIC ENGINE
// ============================================================
async function init() {
    UI.log(`INITIALIZING ARBITRAGE V5...`, 'INFO');
    try {
        const [bin, mexc] = await Promise.all([
            axios.get('https://fapi.binance.com/fapi/v1/premiumIndex'),
            axios.get('https://contract.mexc.com/api/v1/contract/detail')
        ]);
        
        const binMap = {}; bin.data.forEach(i => binMap[i.symbol] = parseFloat(i.lastFundingRate));
        const mexcPairs = mexc.data.data.filter(p => p.symbol.endsWith('_USDT'));

        mexcPairs.forEach(m => {
            const norm = m.symbol.replace('_', '');
            if (binMap[norm] !== undefined) {
                state.commonPairs.push({ original: m.symbol, norm: norm });
                state.pairs[norm] = { binFund: binMap[norm], mexcFund: 0, binPrice: 0, mexcPrice: 0 };
            }
        });

        UI.log(`System Online. Monitoring ${state.commonPairs.length} pairs.`, 'WIN');
        startSockets();
        setInterval(logicLoop, 200);
        setInterval(updateUI, CONFIG.SYSTEM.REFRESH_RATE);
    } catch (e) { 
        UI.log(`INIT ERROR: ${e.message}`, 'ERR'); 
    }
}

function startSockets() {
    const binWs = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    binWs.on('message', d => JSON.parse(d).forEach(t => { if (state.pairs[t.s]) state.pairs[t.s].binPrice = parseFloat(t.c); }));

    const mexcWs = new WebSocket('wss://contract.mexc.com/edge');
    mexcWs.on('open', async () => {
        const chunk = 30;
        for (let i = 0; i < state.commonPairs.length; i += chunk) {
            state.commonPairs.slice(i, i + chunk).forEach(p => mexcWs.send(JSON.stringify({"method":"sub.ticker","param":{"symbol":p.original}})));
            await new Promise(r => setTimeout(r, 100));
        }
        setInterval(() => mexcWs.send(JSON.stringify({"method":"ping"})), 10000);
    });
    mexcWs.on('message', d => {
        const m = JSON.parse(d);
        if (m.channel === 'push.ticker') {
            const norm = m.data.symbol.replace('_', '');
            if (state.pairs[norm]) state.pairs[norm].mexcPrice = parseFloat(m.data.lastPrice);
        }
    });
}

function logicLoop() {
    state.commonPairs.forEach(p => {
        const sym = p.norm;
        if (state.blacklist.has(sym)) return;
        if (state.cooldowns[sym] && state.cooldowns[sym] > Date.now()) return;

        const d = state.pairs[sym];
        if (!d.binPrice || !d.mexcPrice) return;

        const sA = ((d.mexcPrice - d.binPrice) / d.binPrice) * 100;
        const sB = ((d.binPrice - d.mexcPrice) / d.mexcPrice) * 100;
        const best = Math.max(sA, sB);
        const dir = sA > sB ? 'L_BIN/S_MEX' : 'S_BIN/L_MEX';

        d.calc = { spread: best, dir: dir, pnl: POSITION_SIZE * (best / 100) };

        if (!state.activeTrades[sym] && best >= CONFIG.STRATEGY.ENTRY_THRESHOLD) {
            state.activeTrades[sym] = {
                entryTime: new Date(),
                entryPrices: { bin: d.binPrice, mex: d.mexcPrice },
                entrySpread: best,
                minPnl: 0,
                currentPnl: 0,
                currentSpread: best
            };
            UI.log(`ENTERED: ${sym} @ ${best.toFixed(2)}%`, 'INFO');
        }

        if (state.activeTrades[sym]) {
            const t = state.activeTrades[sym];
            const profitPct = t.entrySpread - best;
            t.currentPnl = POSITION_SIZE * (profitPct / 100);
            t.currentSpread = best;
            if (t.currentPnl < t.minPnl) t.minPnl = t.currentPnl;

            if (best <= CONFIG.STRATEGY.EXIT_THRESHOLD) closeTrade(sym, t, d);
        }
    });
}

function closeTrade(sym, trade, data) {
    const dur = new Date() - trade.entryTime;
    
    if (dur < CONFIG.STRATEGY.IGNORE_FLASH_MS) {
        if (!state.flashStrikes[sym]) state.flashStrikes[sym] = 0;
        state.flashStrikes[sym]++;
        UI.log(`FLASH SKIP: ${sym} (${dur}ms)`, 'WRN');
        if (state.flashStrikes[sym] >= CONFIG.SYSTEM.MAX_FLASH_STRIKES) {
            state.blacklist.add(sym);
            UI.log(`BLACKLIST: ${sym}`, 'ERR');
        }
        generateDealCard(sym, trade, dur, true);
    } else {
        state.stats.realDeals++;
        const cost = POSITION_SIZE * (CONFIG.COSTS.FEE_RATE + CONFIG.COSTS.SLIPPAGE_RATE);
        const net = trade.currentPnl - cost;
        state.stats.netProfit += net;
        state.stats.feesPaid += cost; 
        
        UI.log(`CLOSED: ${sym} | NET: $${net.toFixed(2)}`, net > 0 ? 'WIN' : 'ERR');
        generateDealCard(sym, trade, dur, false, net);
        state.cooldowns[sym] = Date.now() + CONFIG.STRATEGY.COOLDOWN_MS;
    }
    delete state.activeTrades[sym];
}

// ============================================================
// 🖥️ UPDATE UI (RENDER LOGIC)
// ============================================================
function updateUI() {
    // 1. HEADER
    const up = ((new Date() - state.stats.startTime) / 60000).toFixed(0) + 'm';
    const configTxt = `MARGIN: $${CONFIG.CAPITAL.MARGIN} | LEV: x${CONFIG.CAPITAL.LEVERAGE} | POS: $${POSITION_SIZE} | PESSIMISM: ON`;
    headerBox.setContent(` ARBITRAGE V5 (REALITY)   {right}UPTIME: ${up} | ${configTxt}  {/right}`);

    // 2. METRICS
    const totalCost = state.stats.feesPaid + state.stats.slippageLost;
    metricsBox.setContent(
        ` {bold}NET PROFIT:{/bold} ${UI.money(state.stats.netProfit)}   ` +
        `{bold}COSTS:{/bold} {red-fg}-$${totalCost.toFixed(2)}{/}   ` +
        `{bold}DEALS:{/bold} {cyan-fg}${state.stats.realDeals}{/}`
    );

    // 3. ACTIVE TRADES (Выровненная таблица)
    // Определяем ширину колонок
    const colW = { sym: 10, conv: 30, time: 10, pnl: 15, dd: 15 };
    
    // Заголовок таблицы (используем UI.pad для ровности)
    let activeContent = 
        `{bold}{cyan-fg}` +
        UI.pad(' SYMBOL', colW.sym) +
        UI.pad('CONVERGENCE', colW.conv) +
        UI.pad('TIME', colW.time) +
        UI.pad('PNL (GROSS)', colW.pnl) +
        UI.pad('DRAWDOWN', colW.dd) + 
        `{/}\n`;
    
    Object.keys(state.activeTrades).forEach(k => {
        const t = state.activeTrades[k];
        const sec = Math.floor((Date.now() - new Date(t.entryTime)) / 1000);
        const timeStr = `${Math.floor(sec/60)}m ${sec%60}s`;
        
        let vis = '';
        if (t.currentSpread < t.entrySpread) vis = `{green-fg}» ${t.currentSpread.toFixed(2)}%{/}`;
        else vis = `{red-fg}« ${t.currentSpread.toFixed(2)}%{/}`;
        const convergenceStr = `${t.entrySpread.toFixed(2)}% ${vis}`;
        
        const ddBar = UI.bar(Math.abs(t.minPnl), 5, 10);
        const pnl = UI.money(t.currentPnl);

        // Строка данных
        activeContent += 
            UI.pad(` ${k}`, colW.sym) +
            UI.pad(convergenceStr, colW.conv) +
            UI.pad(timeStr, colW.time) +
            UI.pad(pnl, colW.pnl) +
            UI.pad(ddBar, colW.dd) + 
            '\n';
    });
    
    if (Object.keys(state.activeTrades).length === 0) {
        activeContent += `\n{center}{gray-fg}NO ACTIVE POSITIONS - SCANNING MARKET...{/gray-fg}{/center}`;
    }
    activeBox.setContent(activeContent);

    // 4. SCANNER (Выровненная таблица)
    const scanW = { sym: 10, spread: 12, net: 15, str: 20 };
    
    let scannerContent = 
        `{bold}{cyan-fg}` +
        UI.pad(' PAIR', scanW.sym) +
        UI.pad('SPREAD', scanW.spread) +
        UI.pad('EST. NET', scanW.net) +
        UI.pad('STRENGTH', scanW.str) +
        `{/}\n`;
    
    const opps = [];
    Object.keys(state.pairs).forEach(k => { if(state.pairs[k].calc && state.pairs[k].calc.spread > 0.2) opps.push({sym: k, ...state.pairs[k].calc}); });
    const top = opps.sort((a,b) => b.spread - a.spread).slice(0, 5);

    top.forEach(o => {
        if (state.blacklist.has(o.sym) || (state.cooldowns[o.sym] > Date.now())) return;
        const est = o.pnl - (POSITION_SIZE * (CONFIG.COSTS.FEE_RATE + CONFIG.COSTS.SLIPPAGE_RATE));
        const str = UI.bar(o.spread, 2.5, 20);
        
        scannerContent += 
            UI.pad(` ${o.sym}`, scanW.sym) +
            UI.pad(`${o.spread.toFixed(2)}%`, scanW.spread) +
            UI.pad(UI.money(est), scanW.net) +
            UI.pad(str, scanW.str) + 
            '\n';
    });
    scannerBox.setContent(scannerContent);

    screen.render();
}

// ============================================================
// 📊 REPORTS
// ============================================================
function generateDealCard(sym, trade, dur, isFlash, net=0) {
    const f = `DEAL_${sym}_${Date.now()}.html`;
    const d = isFlash ? CONFIG.DIRS.FLASH : CONFIG.DIRS.DEALS;
    const html = `<h1>${sym}</h1><p>Net: ${net.toFixed(2)} Time: ${dur}ms</p>`;
    fs.writeFileSync(path.join(d, f), html);
}

init();