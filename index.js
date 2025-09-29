const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const express = require('express'); // <-- ADDED: REQUIRED FOR CONTAINER HOSTING
const delay = ms => new Promise(res => setTimeout(res, ms));

// --- 1. CONFIGURATION (HARDCODED) ---
// ⚠️ WARNING: REPLACE THESE PLACEHOLDERS WITH YOUR ACTUAL VALUES
const telegramToken = '7044372335:AAFotpWDVLTEUHpw1d8pkvoG_UQoXqJxy68'; // <-- REPLACE THIS WITH YOUR REAL TOKEN
const ADMIN_CHAT_ID = 7674719048; // <-- REPLACE THIS WITH YOUR REAL NUMERIC CHAT ID

// Container-Specific Settings (Hardcoded to resolve your previous errors)
const PORT = 8080; // Must match EXPOSE in Dockerfile and Back4App config
const PUPPETEER_EXECUTABLE_PATH = '/usr/bin/chromium-browser'; // Path inside the Docker container

const CONFIG = {
    // Operational Timing (in milliseconds)
    CHECK_INTERVAL_MS: 3000,
    NAV_TIMEOUT_MS: 30000, // Increased for stability in container environments
    MAX_CHECKS_PER_CYCLE: 500000,
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000,

    // Website-Specific Elements
    NEXT_BUTTON_VALUES: ['Next', 'التالى'],
    BACK_BUTTON_VALUES: ['Back', 'السابق'],
    ERROR_TEXT_SAMPLES: ['unfortunately', 'allocated', 'vergeben', 'relocate', 'alocate', 'no appointment', 'kein termin'],

    // WEBSITE SELECTORS
    SELECTORS: {
        SERVICE_DROPDOWN: 'tbody tr:nth-child(2) td select',
        RADIO_BUTTONS: 'input[type="radio"]',
        SUBMIT_BUTTON: 'input[type="submit"]',
    },

    CHAT_IDS_FILE: path.resolve(__dirname, 'chat_ids.json'),
};

let telegramChatIds = [ADMIN_CHAT_ID];
const bot = new TelegramBot(telegramToken, { polling: true });

// --------------------------------------------------------------------------------

// --- 2. Telegram Bot Setup & File I/O ---

bot.on('polling_error', (error) => {
    console.error('Polling error (Bot auto-retries most issues):', error.message || error);
});

if (fs.existsSync(CONFIG.CHAT_IDS_FILE)) {
    try {
        const fileIds = JSON.parse(fs.readFileSync(CONFIG.CHAT_IDS_FILE, 'utf8'));
        const validFileIds = fileIds.filter(id => !isNaN(parseInt(id, 10)));
        telegramChatIds = Array.from(new Set([ADMIN_CHAT_ID, ...validFileIds]));
    } catch (err) {
        console.error('Failed to read chat_ids.json, starting with ADMIN_CHAT_ID only:', err.message);
    }
}

function saveChatIds() {
    const uniqueIds = Array.from(new Set(telegramChatIds));
    fs.writeFileSync(CONFIG.CHAT_IDS_FILE, JSON.stringify(uniqueIds, null, 2));
}

// Handle new subscribers
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    if (msg.text === '/start' || !telegramChatIds.includes(chatId)) {
        telegramChatIds.push(chatId);
        saveChatIds();
        bot.sendMessage(chatId, `✅ You are now subscribed to appointment updates. Your ID: ${chatId}.`, { parse_mode: 'Markdown' });
        console.log(`New chat subscribed: ${chatId} (${msg.from.username || msg.from.first_name})`);
    }
});

// Status Command Handler
bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    const intervalSec = (CONFIG.CHECK_INTERVAL_MS / 1000).toFixed(0);

    let statusMessage = `🤖 **Bot Status: Running and Monitoring**
\n* **Check Interval:** Every ${intervalSec} seconds.
* **Browser Restarts:** Every ${CONFIG.MAX_CHECKS_PER_CYCLE} checks (for stability).
* **Subscribers:** ${telegramChatIds.length} users.
* **Hosting Port:** ${PORT} (Listening for health checks).`; // Added PORT status

    bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

// --- 3. Telegram Helper Functions ---

async function sendToAll(message, options = {}) {
    for (const id of telegramChatIds) {
        try {
            await bot.sendMessage(id, message, options);
        } catch (err) {
            console.error(`Failed to send message to ${id}:`, err.message);
        }
    }
}

async function sendPhotoToAll(photoBuffer, options = {}) {
    for (const id of telegramChatIds) {
        try {
            if (photoBuffer.length > 50 * 1024 * 1024) {
                console.error(`Skipping photo to ${id}: File too large.`);
                continue;
            }
            await bot.sendPhoto(id, photoBuffer, options);
        } catch (err) {
            console.error(`Failed to send photo to ${id}:`, err.message);
        }
    }
}

// --------------------------------------------------------------------------------

// --- 4. Puppeteer Automation Helpers (Same as your version) ---

async function waitForElementWithRetries(page, selector, timeout) {
    for (let i = 0; i < CONFIG.MAX_RETRIES; i++) {
        try {
            await page.waitForSelector(selector, { timeout: timeout });
            return true;
        } catch (e) {
            if (i < CONFIG.MAX_RETRIES - 1) {
                console.warn(`- Element ${selector} not found. Retrying in ${CONFIG.RETRY_DELAY_MS}ms...`);
                await delay(CONFIG.RETRY_DELAY_MS);
            } else {
                throw new Error(`CRITICAL: Element ${selector} not found after ${CONFIG.MAX_RETRIES} attempts.`);
            }
        }
    }
}

async function checkUnfortunately(page) {
    const bodyText = await page.evaluate(() => document.body.innerText);
    const lowerBody = bodyText.toLowerCase();

    return CONFIG.ERROR_TEXT_SAMPLES.some(phrase => lowerBody.includes(phrase));
}

async function loopUntilNoUnfortunately(page) {
    let attempts = 0;
    while (true) {
        const hasUnfortunately = await checkUnfortunately(page);
        if (!hasUnfortunately) break;

        console.log(`- Detected error page (${++attempts}). Navigating back/forward...`);

        await waitForElementWithRetries(page, CONFIG.SELECTORS.SUBMIT_BUTTON, CONFIG.NAV_TIMEOUT_MS);
        const buttons = await page.$$(CONFIG.SELECTORS.SUBMIT_BUTTON);

        const backResults = await Promise.all(buttons.map(async btn => {
            const value = await (await btn.getProperty('value')).jsonValue();
            return CONFIG.BACK_BUTTON_VALUES.includes(value) ? btn : null;
        }));
        const back = backResults.find(b => b !== null);

        if (back) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle0', timeout: CONFIG.NAV_TIMEOUT_MS }),
                back.click()
            ]);
        } else {
            console.error('CRITICAL: Cannot find "Back" button on error page.');
            throw new Error('Navigation failed: Cannot recover from error page.');
        }

        for (let i = 0; i < 2; i++) {
            const nextClicked = await clickNextButton(page);
            if (!nextClicked) {
                throw new Error('Navigation failed: Cannot click Next button after going back.');
            }
        }
    }
}

async function clickNextButton(page) {
    const nextButtonSelector = CONFIG.SELECTORS.SUBMIT_BUTTON;

    await waitForElementWithRetries(page, nextButtonSelector, CONFIG.NAV_TIMEOUT_MS);

    const buttons = await page.$$(nextButtonSelector);

    for (const btn of buttons) {
        const val = await (await btn.getProperty('value')).jsonValue();
        if (CONFIG.NEXT_BUTTON_VALUES.includes(val)) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle0', timeout: CONFIG.NAV_TIMEOUT_MS }),
                btn.click()
            ]);
            return true;
        }
    }
    return false;
}

// --------------------------------------------------------------------------------

// --- 5. Main Automation Logic (startBooking is the same) ---

async function startBooking(browser) {
    const page = await browser.newPage();
    // ... (startBooking implementation is unchanged from your version) ...
    try {
        console.log('- Navigating to booking page...');
        const startUrl = 'https://appointment.bmeia.gv.at/?Office=Kairo';

        await page.goto(startUrl, {
            waitUntil: 'networkidle0',
            timeout: CONFIG.NAV_TIMEOUT_MS
        });

        await waitForElementWithRetries(page, CONFIG.SELECTORS.SERVICE_DROPDOWN, CONFIG.NAV_TIMEOUT_MS);

        const masterValue = await page.evaluate((selector) => {
            const select = document.querySelector(selector);
            const found = Array.from(select.options).find(opt => opt.textContent.toLowerCase().includes('master'));
            return found ? found.value : null;
        }, CONFIG.SELECTORS.SERVICE_DROPDOWN);

        if (!masterValue) throw new Error('No matching dropdown option found for service type (expected "master").');
        await page.select(CONFIG.SELECTORS.SERVICE_DROPDOWN, masterValue);

        for (let i = 0; i < 3; i++) {
            const ok = await clickNextButton(page);
            if (!ok) throw new Error(`Next button not found at step ${i + 1}. Aborting.`);
            await loopUntilNoUnfortunately(page);
        }

        await waitForElementWithRetries(page, CONFIG.SELECTORS.RADIO_BUTTONS, CONFIG.NAV_TIMEOUT_MS);
        const radios = await page.$$(CONFIG.SELECTORS.RADIO_BUTTONS);

        if (radios.length > 0) {
            console.log('!!! APPOINTMENT FOUND !!! Direct access not possible (Static URL).');

            await sendToAll(`🚨 **APPOINTMENT AVAILABLE!** 📅
\nThe website link is static. Please click below and quickly **re-select your service and click NEXT 3 times** to reach the slot page.

**Start Link:** ${startUrl}

**Status:** Slots are OPEN! Be quick!`, { parse_mode: 'Markdown' });

            const screenshotBuffer = await page.screenshot({ fullPage: true });
            await sendPhotoToAll(screenshotBuffer, { caption: 'Screenshot confirms slots are open!' });

            throw new Error('Appointment found. Alert sent.');
        } else {
            throw new Error('No appointment slots currently available.');
        }

    } catch (e) {
        throw e;
    } finally {
        if (page) {
            await page.close().catch(err => console.error('Failed to close page gracefully:', err.message));
        }
    }
}

async function runMonitor() { // Renamed from run() to avoid conflict with run() block below
    let browser;
    let checkCounter = 0;

    // --- INITIAL BROWSER LAUNCH ---
    try {
        console.log('\n--- Initializing Browser ---');
        browser = await puppeteer.launch({
            headless: 'new',
            // CRITICAL FIX: Use the hardcoded path for the Docker environment
            executablePath: PUPPETEER_EXECUTABLE_PATH, 
            args: [
                '--no-sandbox',
                '--disable-gpu',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
            ],
        });
        console.log('Browser launched successfully. Starting monitoring loop...');
    } catch (e) {
        console.error('FATAL: Could not launch browser. Application exiting.', e);
        await bot.sendMessage(ADMIN_CHAT_ID, `❌ FATAL ERROR: Cannot launch browser. Application halted.`);
        return;
    }

    // --- CONTINUOUS CHECK LOOP ---
    while (true) {
        let checkStartTime = Date.now();
        console.log(`\n--- Starting check #${checkCounter + 1} at ${new Date().toLocaleTimeString()} ---`);

        try {
            await startBooking(browser);
        } catch (error) {
            const errorMessage = error.message;
            
            // --- FIX FOR SPAM: Explicitly handle expected failures ---
            if (errorMessage.includes('Appointment found')) {
                console.log('✅ ALERT SENT. Waiting for next cycle.');
            } else if (errorMessage.includes('No appointment slots currently available')) {
                // This is the EXPECTED failure. LOG ONLY. DO NOT SEND TELEGRAM MESSAGE.
                console.log('❌ FAIL: No slots found (Normal check result).');
                checkCounter++;
            } else {
                // This catches UNEXPECTED/CRITICAL ERRORS (timeouts, missing selectors, etc.)
                console.error('💣 UNEXPECTED ERROR during check:', errorMessage);
                
                // Only send a Telegram message if it's NOT a common, self-recovering error (like a timeout)
                const isCriticalError = !(
                    errorMessage.includes('TimeoutError') || 
                    errorMessage.includes('CRITICAL: Element') || 
                    errorMessage.includes('Navigation failed')
                );

                if (isCriticalError) {
                     await bot.sendMessage(ADMIN_CHAT_ID, `❌ **CRITICAL ERROR** during check: ${errorMessage}\n\nThe system will attempt to restart the check cycle.`);
                } else {
                    console.log("⚠️ Minor error detected (Timeout/Selector failure). Skipping Telegram alert.");
                }
                checkCounter++;
            }
        } finally {
            // --- PERIODIC BROWSER RESTART CHECK ---
            if (checkCounter > 0 && (checkCounter % CONFIG.MAX_CHECKS_PER_CYCLE === 0)) {
                console.log(`\n--- Reached ${CONFIG.MAX_CHECKS_PER_CYCLE} checks. Restarting browser for cleanup... ---`);

                await browser.close().catch(err => console.error('Error during scheduled browser close:', err.message));
                
                // Re-launch browser (using fixed launch options)
                browser = await puppeteer.launch({
                    headless: 'new',
                    executablePath: PUPPETEER_EXECUTABLE_PATH,
                    args: [
                        '--no-sandbox',
                        '--disable-gpu',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                    ],
                });
                checkCounter = 0;
            }

            // --- DELAY ---
            const checkDuration = ((Date.now() - checkStartTime) / 1000).toFixed(2);
            const delaySec = (CONFIG.CHECK_INTERVAL_MS / 1000).toFixed(0);

            console.log(`--- Check finished in ${checkDuration}s. Next check in ${delaySec} seconds. ---`);
            await delay(CONFIG.CHECK_INTERVAL_MS);
        }
    }
}

// --- 6. Web Server & Execution ---

const app = express();

// Simple endpoint for Back4App to verify the app is running
app.get('/', (req, res) => {
    res.status(200).send("Appointments Monitor is running and serving Telegram updates.");
});

// Start the Express server on the required port
app.listen(PORT, () => {
    console.log(`Web server listening for health checks on port ${PORT}`);
});

// Start the core monitoring loop concurrently
runMonitor();