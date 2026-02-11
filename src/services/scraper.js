/**
 * Google Review Scraper Service
 * Uses Puppeteer to scrape review text from Google Maps review URLs
 * Designed to run fully async — never blocks HTTP request/response cycle
 */

const puppeteerCore = require('puppeteer-core');
const puppeteerFull = require('puppeteer');
const chromium = require('@sparticuz/chromium');

// Simple mutex to ensure only one scrape runs at a time
let isScrapingActive = false;
const scrapeQueue = [];

/**
 * Get browser launch options
 * Uses @sparticuz/chromium for serverless/container environments
 * Falls back to local Chrome for development
 */
async function getBrowserOptions() {
    const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
    
    if (isProduction) {
        // Use @sparticuz/chromium in production (Railway, serverless)
        return {
            usePuppeteerCore: true,
            launchOptions: {
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath(),
                headless: chromium.headless,
            }
        };
    }
    
    // Local development — try to find system Chrome first
    const possiblePaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',  // macOS
        '/usr/bin/google-chrome',                                         // Linux
        '/usr/bin/chromium-browser',                                      // Linux alt
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',     // Windows
    ];
    
    const fs = require('fs');
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            return {
                usePuppeteerCore: true,
                launchOptions: {
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
                    defaultViewport: { width: 1280, height: 800 },
                    executablePath: p,
                    headless: 'new',
                }
            };
        }
    }
    
    // No system Chrome found — use puppeteer's bundled Chromium
    console.log('ℹ️  No system Chrome found, using puppeteer bundled Chromium');
    return {
        usePuppeteerCore: false,
        launchOptions: {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            defaultViewport: { width: 1280, height: 800 },
            headless: 'new',
        }
    };
}

/**
 * Scrape a Google Maps review page to extract review text
 * @param {string} url - Google Maps review URL
 * @returns {Promise<{success: boolean, reviewText?: string, merchantName?: string, error?: string}>}
 */
async function scrapeGoogleReview(url) {
    let browser = null;
    
    try {
        console.log(`🔍 Scraping review: ${url}`);
        
        const options = await getBrowserOptions();
        const launcher = options.usePuppeteerCore ? puppeteerCore : puppeteerFull;
        browser = await launcher.launch(options.launchOptions);
        
        const page = await browser.newPage();
        
        // Set a realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Force English language to avoid Google auto-translating reviews
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9'
        });
        
        // Set timeout for navigation
        page.setDefaultNavigationTimeout(30000);
        page.setDefaultTimeout(30000);
        
        // Navigate to the review URL first (let short URLs redirect)
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // After redirect, get the final URL and re-navigate with hl=en if needed
        const currentUrl = page.url();
        if (!currentUrl.includes('hl=en')) {
            const separator = currentUrl.includes('?') ? '&' : '?';
            const urlWithLang = `${currentUrl}${separator}hl=en`;
            console.log(`🌐 Re-navigating with English locale: ${urlWithLang.substring(0, 100)}...`);
            await page.goto(urlWithLang, { waitUntil: 'networkidle2', timeout: 30000 });
        }
        
        // Wait a bit for dynamic content to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Click "See original" button if Google auto-translated the review
        try {
            const seeOriginalClicked = await page.evaluate(() => {
                // Look for "See original" or similar buttons/links
                const allElements = document.querySelectorAll('button, span[role="button"], a, span[jsaction]');
                for (const el of allElements) {
                    const text = el.textContent.trim().toLowerCase();
                    if (text === 'see original' || text === 'show original' || text.includes('see original')) {
                        el.click();
                        return true;
                    }
                }
                return false;
            });
            if (seeOriginalClicked) {
                console.log('📝 Clicked "See original" to get untranslated review');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (e) {
            // Ignore — button may not exist if review isn't translated
        }
        
        // Debug: log the page title and URL to help diagnose issues
        const pageTitle = await page.title();
        const finalUrl = page.url();
        console.log(`📄 Page: "${pageTitle}" at ${finalUrl.substring(0, 80)}...`);
        
        // Try to extract review text and merchant name using multiple strategies
        const result = await page.evaluate(() => {
            let reviewText = null;
            let merchantName = null;
            
            // Strategy 1: Look for review text in common Google Maps selectors
            const reviewSelectors = [
                // Individual review text containers
                '.MyEned span.wiI7pd',
                '.wiI7pd',
                '[data-review-id] .wiI7pd',
                '.review-full-text',
                // Review body text
                '[class*="review"] span[class*="text"]',
                '.rsqaWe',
                // Fallback: any span with substantial text in a review context
                '.DU9Pgb .wiI7pd',
                '.jftiEf .wiI7pd',
            ];
            
            for (const selector of reviewSelectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    // Get the first review text (usually the highlighted/linked one)
                    const texts = Array.from(elements)
                        .map(el => el.textContent.trim())
                        .filter(t => t.length > 10);
                    
                    if (texts.length > 0) {
                        reviewText = texts[0];
                        break;
                    }
                }
            }
            
            // Strategy 2: Look for merchant/place name
            const nameSelectors = [
                'h1.DUwDvf',
                '.DUwDvf',
                'h1[class*="header"]',
                '.lMbq3e h1',
                '.qBF1Pd',
                '[data-attrid="title"]',
            ];
            
            for (const selector of nameSelectors) {
                const el = document.querySelector(selector);
                if (el && el.textContent.trim().length > 0) {
                    merchantName = el.textContent.trim();
                    break;
                }
            }
            
            // Strategy 3: If no review text found, try to get all visible text from review cards
            if (!reviewText) {
                const reviewCards = document.querySelectorAll('.jftiEf, .gws-localreviews__google-review');
                for (const card of reviewCards) {
                    const text = card.textContent.trim();
                    if (text.length > 20) {
                        reviewText = text.substring(0, 2000); // Cap at 2000 chars
                        break;
                    }
                }
            }
            
            return { reviewText, merchantName };
        });
        
        await browser.close();
        browser = null;
        
        if (result.reviewText) {
            console.log(`✅ Scraped review text (${result.reviewText.length} chars) for merchant: ${result.merchantName || 'unknown'}`);
            return {
                success: true,
                reviewText: result.reviewText,
                merchantName: result.merchantName || null
            };
        } else {
            console.log(`⚠️  Could not extract review text from: ${url}`);
            return {
                success: false,
                error: 'Could not extract review text from the page. The review may be private or the URL format is not supported.',
                merchantName: result.merchantName || null
            };
        }
        
    } catch (error) {
        console.error(`❌ Scraping error for ${url}:`, error.message);
        return {
            success: false,
            error: `Scraping failed: ${error.message}`
        };
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                // Ignore close errors
            }
        }
    }
}

/**
 * Queue a scrape job — ensures only one runs at a time
 * @param {string} url - Google Maps review URL
 * @returns {Promise<{success: boolean, reviewText?: string, merchantName?: string, error?: string}>}
 */
function queueScrape(url) {
    return new Promise((resolve) => {
        scrapeQueue.push({ url, resolve });
        processQueue();
    });
}

/**
 * Process the scrape queue — one at a time
 */
async function processQueue() {
    if (isScrapingActive || scrapeQueue.length === 0) return;
    
    isScrapingActive = true;
    const { url, resolve } = scrapeQueue.shift();
    
    try {
        const result = await scrapeGoogleReview(url);
        resolve(result);
    } catch (error) {
        resolve({ success: false, error: error.message });
    } finally {
        isScrapingActive = false;
        // Process next item in queue
        if (scrapeQueue.length > 0) {
            processQueue();
        }
    }
}

/**
 * Scrape and validate a review — the main entry point
 * Scrapes the review text, then sends it to AI for validation
 * @param {number} ticketId - The ticket ID to update
 * @param {string} reviewUrl - The Google review URL
 * @param {object} db - Database service reference
 * @param {object} anthropic - Anthropic service reference
 */
async function scrapeAndValidateReview(ticketId, reviewUrl, db, anthropic) {
    try {
        console.log(`🔄 Starting scrape+validate for ticket #${ticketId}: ${reviewUrl}`);
        
        // Step 1: Scrape the review
        const scrapeResult = await queueScrape(reviewUrl);
        
        if (!scrapeResult.success) {
            console.log(`⚠️  Scrape failed for ticket #${ticketId}: ${scrapeResult.error}`);
            db.validateTicket(ticketId, false, `Scrape failed: ${scrapeResult.error}`);
            
            // Still update review text if we got merchant name
            if (scrapeResult.merchantName) {
                db.updateTicketMerchant(ticketId, scrapeResult.merchantName);
            }
            return;
        }
        
        // Step 2: Update ticket with scraped data
        db.updateTicketReviewText(ticketId, scrapeResult.reviewText);
        if (scrapeResult.merchantName) {
            db.updateTicketMerchant(ticketId, scrapeResult.merchantName);
        }
        
        // Step 3: AI validation
        const validation = await anthropic.validateReview(scrapeResult.reviewText, scrapeResult.merchantName);
        
        console.log(`🤖 AI validation for ticket #${ticketId}: valid=${validation.isValid}, reason=${validation.reason}`);
        
        // Step 4: Update ticket with validation result
        db.validateTicket(ticketId, validation.isValid, validation.reason);
        
        console.log(`✅ Ticket #${ticketId} validation complete: ${validation.isValid ? 'VALID' : 'INVALID'}`);
        
    } catch (error) {
        console.error(`❌ scrapeAndValidateReview error for ticket #${ticketId}:`, error.message);
        db.validateTicket(ticketId, false, `Validation error: ${error.message}`);
    }
}

/**
 * Re-validate all pending/unvalidated tickets
 * Useful for processing existing tickets that were auto-approved
 * @param {object} db - Database service reference
 * @param {object} anthropic - Anthropic service reference
 */
async function revalidateAllPending(db, anthropic) {
    const pendingTickets = db.getUnvalidatedTickets();
    console.log(`🔄 Re-validating ${pendingTickets.length} pending tickets...`);
    
    for (const ticket of pendingTickets) {
        await scrapeAndValidateReview(ticket.id, ticket.review_link, db, anthropic);
    }
    
    console.log(`✅ Re-validation complete for ${pendingTickets.length} tickets`);
}

module.exports = {
    scrapeGoogleReview,
    queueScrape,
    scrapeAndValidateReview,
    revalidateAllPending
};
