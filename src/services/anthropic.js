/**
 * Anthropic API service for review validation
 * Uses Claude to verify reviews mention Bitcoin purchases
 */

const Anthropic = require('@anthropic-ai/sdk');

let client = null;

/**
 * Initialize Anthropic client
 */
function initializeAnthropic() {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.log('⚠️  Anthropic API not configured (ANTHROPIC_API_KEY missing)');
        return;
    }
    
    const options = {
        apiKey: process.env.ANTHROPIC_API_KEY
    };
    
    if (process.env.ANTHROPIC_BASE_URL) {
        options.baseURL = process.env.ANTHROPIC_BASE_URL;
        // PPQ proxy uses Authorization: Bearer instead of x-api-key
        options.defaultHeaders = {
            'Authorization': `Bearer ${process.env.ANTHROPIC_API_KEY}`
        };
        console.log(`📡 Using custom API endpoint: ${process.env.ANTHROPIC_BASE_URL}`);
    }
    
    client = new Anthropic(options);
    
    console.log('✅ Anthropic API initialized');
}

/**
 * Validate a review mentions Bitcoin payment
 * Returns { isValid: boolean, reason: string }
 */
async function validateReview(reviewText, merchantName = null) {
    if (!client) {
        console.log('⚠️  Anthropic not configured, auto-approving review');
        return {
            isValid: true,
            reason: 'Auto-approved (AI validation not configured)',
            confidence: 'low'
        };
    }
    
    if (!reviewText || reviewText.trim().length < 10) {
        return {
            isValid: false,
            reason: 'Review text is too short or empty',
            confidence: 'high'
        };
    }
    
    const prompt = `You are a review validator for a Bitcoin adoption program. Your job is to determine if a Google review mentions that the reviewer paid with Bitcoin (or Lightning Network, sats, etc.).

Review to analyze:
"""
${reviewText}
"""

${merchantName ? `Merchant name: ${merchantName}` : ''}

Analyze this review and determine:
1. Does the review mention paying with Bitcoin, Lightning, sats, or any cryptocurrency?
2. Does it seem like a genuine review of a real experience?

Respond in JSON format:
{
    "mentions_bitcoin_payment": true/false,
    "is_genuine_review": true/false,
    "confidence": "high"/"medium"/"low",
    "reason": "Brief explanation of your decision"
}

Only respond with the JSON, no other text.`;

    try {
        const response = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 256,
            messages: [
                { role: 'user', content: prompt }
            ]
        });
        
        const content = response.content[0].text.trim();
        
        // Parse JSON response
        let result;
        try {
            result = JSON.parse(content);
        } catch (parseError) {
            console.error('Failed to parse Anthropic response:', content);
            return {
                isValid: false,
                reason: 'Failed to validate review (AI response error)',
                confidence: 'low'
            };
        }
        
        const isValid = result.mentions_bitcoin_payment && result.is_genuine_review;
        
        return {
            isValid,
            reason: result.reason,
            confidence: result.confidence,
            details: result
        };
        
    } catch (error) {
        console.error('Anthropic API error:', error.message);
        return {
            isValid: false,
            reason: `Validation error: ${error.message}`,
            confidence: 'low'
        };
    }
}

/**
 * Extract review text from a Google review URL
 * Note: This is a placeholder - Google doesn't allow scraping
 * In practice, users will need to paste their review text
 */
async function extractReviewFromUrl(url) {
    // Validate it's a Google review URL
    const googleReviewPatterns = [
        /google\.com\/maps\/contrib\/\d+\/reviews/,
        /google\.com\/maps\/place\/.+\/reviews/,
        /maps\.app\.goo\.gl\//,
        /g\.page\//,
        /goo\.gl\/maps\//
    ];
    
    const isGoogleReview = googleReviewPatterns.some(pattern => pattern.test(url));
    
    if (!isGoogleReview) {
        return {
            success: false,
            error: 'URL does not appear to be a Google review link'
        };
    }
    
    // We can't actually scrape Google reviews
    // Return indication that manual text entry is needed
    return {
        success: false,
        error: 'Please paste your review text - we cannot automatically fetch Google reviews',
        isValidUrl: true
    };
}

/**
 * Validate a Google review URL format
 */
function isValidGoogleReviewUrl(url) {
    if (!url) return false;
    
    const patterns = [
        /google\.com\/maps/,
        /maps\.app\.goo\.gl/,
        /g\.page/,
        /goo\.gl\/maps/
    ];
    
    return patterns.some(pattern => pattern.test(url));
}

module.exports = {
    initializeAnthropic,
    validateReview,
    extractReviewFromUrl,
    isValidGoogleReviewUrl
};
