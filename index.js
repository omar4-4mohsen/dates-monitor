const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const delay = ms => new Promise(res => setTimeout(res, ms));

// --- 1. CONFIGURATION ---
const CONFIG = {
    // Operational Timing (in milliseconds)
    CHECK_INTERVAL_MS: 3000,           // 3 seconds wait between checks
    NAV_TIMEOUT_MS: 10000,              // 30 seconds max wait for a page load
    MAX_CHECKS_PER_CYCLE: 500000,          // Restart the entire browser after 500000 checks (for cleanup)
    MAX_RETRIES: 3,                     // Max attempts to find a critical element if it fails
    RETRY_DELAY_MS: 1000,               // Delay between element search retries

    // Website-Specific Elements
    NEXT_BUTTON_VALUES: ['Next', 'التالى'],
    BACK_BUTTON_VALUES: ['Back', 'السابق'],
    ERROR_TEXT_SAMPLES: ['unfortunately', 'allocated', 'vergeben', 'relocate', 'alocate', 'no appointment', 'kein termin'],

    // --- WEBSITE SELECTORS (Centralized for easy maintenance) ---
    SELECTORS: {
        SERVICE_DROPDOWN: 'tbody tr:nth-child(2) td select',
        RADIO_BUTTONS: 'input[type="radio"]',
        SUBMIT_BUTTON: 'input[type="submit"]',
    },

    // File Paths
    CHAT_IDS_FILE: path.resolve(__dirname, 'chat_ids.json'),
};

// NOTE: !!! REPLACE THESE WITH ENVIRONMENT VARIABLES WHEN HOSTING !!!
const telegramToken = '7044372335:AAFotpWDVLTEUHpw1d8pkvoG_UQoXqJxy68';
const ADMIN_CHAT_ID = 7674719048;

let telegramChatIds = [ADMIN_CHAT_ID];
const bot = new TelegramBot(telegramToken, { polling: true });

// --------------------------------------------------------------------------------

// --- 2. Telegram Bot Setup & File I/O ---

bot.on('polling_error', (error) => {
    console.error('Polling error (Bot auto-retries most issues):', error.message || error);
});

// Load chat IDs from file
if (fs.existsSync(CONFIG.CHAT_IDS_FILE)) {
    try {
        const fileIds = JSON.parse(fs.readFileSync(CONFIG.CHAT_IDS_FILE, 'utf8'));
        telegramChatIds = Array.from(new Set([ADMIN_CHAT_ID, ...fileIds]));
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
    if (!telegramChatIds.includes(chatId)) {
        telegramChatIds.push(chatId);
        saveChatIds();
        bot.sendMessage(chatId, `✅ You are now subscribed to appointment updates. Your ID: ${chatId}.`);
        console.log(`New chat subscribed: ${chatId} (${msg.from.username || msg.from.first_name})`);
    }
});

// Status Command Handler
bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    const intervalSec = (CONFIG.CHECK_INTERVAL_MS / 1000).toFixed(0);

    let statusMessage = `🤖 **Bot Status: Running and Monitoring**
    
* **Check Interval:** Every ${intervalSec} seconds.
* **Browser Restarts:** Every ${CONFIG.MAX_CHECKS_PER_CYCLE} checks (for stability).
* **Subscribers:** ${telegramChatIds.length} users.
* **Last Check:** See console logs on the server.`;

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

// Accepts a Buffer (raw image data) instead of a file path
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

// --- 4. Puppeteer Automation Helpers ---

// Robust Waiter with Retries
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

        // Use robust wait and centralized selector
        await waitForElementWithRetries(page, CONFIG.SELECTORS.SUBMIT_BUTTON, CONFIG.NAV_TIMEOUT_MS);
        const buttons = await page.$$(CONFIG.SELECTORS.SUBMIT_BUTTON);

        // Find the 'Back' button correctly using Promise.all (Async Fix)
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

        // Navigate "Next" twice to get back to the current step (site specific flow)
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

// --- 5. Main Automation Logic ---

async function startBooking(browser) {
    // CRITICAL: New page/tab for the check
    const page = await browser.newPage();

    try {
        console.log('- Navigating to booking page...');
        const startUrl = 'https://appointment.bmeia.gv.at/?Office=Kairo';

        await page.goto(startUrl, {
            waitUntil: 'networkidle0',
            timeout: CONFIG.NAV_TIMEOUT_MS
        });

        // 1. Select the correct office/service type (LOOKING FOR "master")
        await waitForElementWithRetries(page, CONFIG.SELECTORS.SERVICE_DROPDOWN, CONFIG.NAV_TIMEOUT_MS);

        const masterValue = await page.evaluate((selector) => {
            const select = document.querySelector(selector);
            // *** KEYWORD CHANGED TO "master" ***
            const found = Array.from(select.options).find(opt => opt.textContent.toLowerCase().includes('master'));
            return found ? found.value : null;
        }, CONFIG.SELECTORS.SERVICE_DROPDOWN);

        if (!masterValue) throw new Error('No matching dropdown option found for service type (expected "master").');
        await page.select(CONFIG.SELECTORS.SERVICE_DROPDOWN, masterValue);

        // 2. Click 'Next' 3 times, handling errors
        for (let i = 0; i < 3; i++) {
            const ok = await clickNextButton(page);
            if (!ok) throw new Error(`Next button not found at step ${i + 1}. Aborting.`);
            await loopUntilNoUnfortunately(page);
        }

        // 3. Check for Appointment Availability (The Alarm Trigger)
        await waitForElementWithRetries(page, CONFIG.SELECTORS.RADIO_BUTTONS, CONFIG.NAV_TIMEOUT_MS);
        const radios = await page.$$(CONFIG.SELECTORS.RADIO_BUTTONS);

        if (radios.length > 0) {
            // --- SUCCESS: APPOINTMENT SLOTS ARE VISIBLE ---
            console.log('!!! APPOINTMENT FOUND !!! Direct access not possible (Static URL).');

            // Send the starting link and instructions
            await sendToAll(`🚨 **APPOINTMENT AVAILABLE!** 📅
            
The website link is static. Please click below and quickly **re-select your service and click NEXT 3 times** to reach the slot page.

**Start Link:** ${startUrl}

**Status:** Slots are OPEN! Be quick!`);

            // Capture screenshot buffer and send
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
            // Cleanly close the tab
            await page.close().catch(err => console.error('Failed to close page gracefully:', err.message));
        }
    }
}

async function run() {
    let browser;
    let checkCounter = 0;

    // --- INITIAL BROWSER LAUNCH ---
    try {
        console.log('\n--- Initializing Browser ---');
        browser = await puppeteer.launch({
            headless: 'new',
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
            // --- ERROR HANDLING & LOGGING ---
            if (error.message.includes('Appointment found')) {
                console.log('✅ ALERT SENT. Waiting for next cycle.');
            } else if (error.message.includes('No appointment slots currently available')) {
                console.log('❌ FAIL: No slots found (Normal check result).');
                checkCounter++;
            } else {
                console.error('💣 UNEXPECTED ERROR:', error.message);
                await bot.sendMessage(ADMIN_CHAT_ID, `❌ Unexpected Error during check: ${error.message}\nRestarting cycle.`);
                checkCounter++;
            }
        } finally {
            // --- PERIODIC BROWSER RESTART CHECK ---
            if (checkCounter > 0 && (checkCounter % CONFIG.MAX_CHECKS_PER_CYCLE === 0)) {
                console.log(`\n--- Reached ${CONFIG.MAX_CHECKS_PER_CYCLE} checks. Restarting browser for cleanup... ---`);

                await browser.close().catch(err => console.error('Error during scheduled browser close:', err.message));
                browser = await puppeteer.launch({ /* ... your launch options ... */ });
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

// Start the loop
run();