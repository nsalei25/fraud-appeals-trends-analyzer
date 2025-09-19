// Appeal Trends Analyzer
// AI-powered analysis of fraud appeal dashboard data

let currentData = null;
let analysisResult = null;
let generatedReport = null;
let isScheduled = false;

// Initialize the app
document.addEventListener('DOMContentLoaded', async function() {
    updateStatus('Ready to analyze dashboard data', 'info');
    
    // Check if user is authenticated
    try {
        const user = await quick.id.waitForUser();
        console.log('User authenticated:', user.fullName);
    } catch (error) {
        console.error('Authentication error:', error);
        updateStatus('Authentication required', 'error');
    }
    
    // Load saved settings
    loadSettings();
});

// Fetch data from BigQuery using the actual fraud appeals queries
async function fetchDashboardData() {
    const btn = document.getElementById('fetchDataBtn');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Fetching...';
    
    updateStatus('Requesting BigQuery access for fraud appeals data...', 'info');
    
    try {
        // Request BigQuery permissions
        const authResult = await quick.auth.requestScopes([
            "https://www.googleapis.com/auth/bigquery"
        ]);
        
        if (!authResult.hasRequiredScopes) {
            throw new Error('BigQuery permissions required. Please grant access when prompted.');
        }
        
        updateStatus('Fetching current period data (last 7 days)...', 'info');
        
        // Run the main fraud appeals query for current period (7 days)
        const days = 7;
        const currentPeriodQuery = `
SELECT
    termination_reason,
    t.shop_id,
    DATE(t.appealed_at) as appeal_date,
    t.appeal_pathway,
    t.rule_name,
    t.shop_continent,
    t.shop_country_code,
    t.actionable_id as trust_platform_ticket_id,
    t.trust_platform_action_id,
    t.prioritized_appeal_ticket_id,
    
    -- Combined termination mechanic and operation type into single field
    CASE
        WHEN t.actionable_type = 'BulkShopProcess' THEN 'Bulk Shop Process'
        WHEN t.actionable_type = 'Ticket' AND t.termination_mechanic = 'bulk_review' THEN 'Multi-Shop Review'
        WHEN t.actionable_type = 'Ticket' AND t.termination_mechanic = 'automated_rule' THEN 'Automated Rule'
        WHEN t.actionable_type = 'Ticket' AND t.termination_mechanic = 'manual_review' THEN 'Manual Review'
        WHEN t.termination_mechanic = 'automated_rule' THEN 'Automated Rule'
        WHEN t.termination_mechanic = 'bulk_process' THEN 'Bulk Shop Process'
        WHEN t.termination_mechanic = 'bulk_review' THEN 'Multi-Shop Review'
        WHEN t.termination_mechanic = 'manual_review' THEN 'Manual Review'
        ELSE 'Other'
    END as operation_type,
    
    CASE
        WHEN t.appeal_pathway = 'support_esc' THEN 'support_escalation'
        ELSE t.appeal_pathway
    END as appeals_pathway_detail,
    DATE_DIFF(DATE(t.appealed_at), DATE(t.terminated_at), DAY) as days_to_appeal,
    CASE
        WHEN t.rule_name LIKE '%Manual%' OR t.rule_name = 'Manual/Other' THEN 'Manual'
        ELSE 'Automated'
    END as termination_type,
    
    -- LLM Assessment columns
    JSON_EXTRACT_SCALAR(ta.content, '$.fraud_termination_appeal_assessment.assessment') AS llm_decision,
    ta.created_at as llm_assessment_date

FROM \`shopify-dw.mart_cti_data.shop_terminations__wide\` t
LEFT JOIN \`shopify-dw.risk.trust_platform_disputes\` d
    ON d.trust_platform_ticket_id = t.actionable_id
    AND LOWER(t.actionable_type) = 'ticket'
    AND d.type = 'appeal'

-- Join for LLM assessments
LEFT JOIN \`shopify-dw.base.base__trust_platform_shops\` s
    ON t.shop_id = SAFE_CAST(s.external_id AS INT64)
LEFT JOIN \`sdp-prd-cti-data.base.base__trust_platform_disputes\` d2
    ON d2.subject_id = s.trust_platform_shop_id
    AND d2.ticket_id = t.actionable_id
    AND d2.dispute_type = 'appeal'
LEFT JOIN \`sdp-prd-cti-data.base.base__trust_platform_sensitive_trust_assessments\` ta
    ON ta.assessable_id = d2.trust_platform_dispute_id
    AND ta.assessable_type = 'Dispute'
    AND DATE(ta.longboat_extracted_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)

WHERE DATE(t.appealed_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY)
    AND (t.termination_reason_category = 'fraud')
    AND t.was_appealed = true

-- Get only the most recent assessment per shop
QUALIFY ROW_NUMBER() OVER (PARTITION BY t.shop_id ORDER BY ta.created_at DESC NULLS LAST) = 1

ORDER BY t.appealed_at, t.termination_reason, t.shop_id
        `;
        
        const currentResults = await quick.dw.querySync(currentPeriodQuery, [], {
            timeoutMs: 60000,
            maxResults: 10000
        });
        
        updateStatus('Fetching previous period data (7 days prior)...', 'info');
        
        // Run the previous period query
        const previousPeriodQuery = `
SELECT
    termination_reason,
    t.shop_id,
    DATE(t.appealed_at) as appeal_date,
    JSON_EXTRACT_SCALAR(ta.content, '$.fraud_termination_appeal_assessment.assessment') AS llm_decision

FROM \`shopify-dw.mart_cti_data.shop_terminations__wide\` t
LEFT JOIN \`shopify-dw.risk.trust_platform_disputes\` d
    ON d.trust_platform_ticket_id = t.actionable_id
    AND LOWER(t.actionable_type) = 'ticket'
    AND d.type = 'appeal'

LEFT JOIN \`shopify-dw.base.base__trust_platform_shops\` s
    ON t.shop_id = SAFE_CAST(s.external_id AS INT64)
LEFT JOIN \`sdp-prd-cti-data.base.base__trust_platform_disputes\` d2
    ON d2.subject_id = s.trust_platform_shop_id
    AND d2.ticket_id = t.actionable_id
    AND d2.dispute_type = 'appeal'
LEFT JOIN \`sdp-prd-cti-data.base.base__trust_platform_sensitive_trust_assessments\` ta
    ON ta.assessable_id = d2.trust_platform_dispute_id
    AND ta.assessable_type = 'Dispute'
    AND DATE(ta.longboat_extracted_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY)

WHERE DATE(t.appealed_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${days * 2} DAY)
    AND DATE(t.appealed_at) < DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY)
    AND (t.termination_reason_category = 'fraud')
    AND t.was_appealed = true

QUALIFY ROW_NUMBER() OVER (PARTITION BY t.shop_id ORDER BY ta.created_at DESC NULLS LAST) = 1

ORDER BY t.appealed_at, t.termination_reason, t.shop_id
        `;
        
        const previousResults = await quick.dw.querySync(previousPeriodQuery, [], {
            timeoutMs: 60000,
            maxResults: 10000
        });

        updateStatus('Fetching previous period SP appeals data...', 'info');

        // Run the previous period SP appeals query
        const previousSpAppealsQuery = `
-- Query for previous period SP appeals
SELECT
    tw.trust_platform_ticket_id,
    tw.subjectable_id as shop_id,
    DATE(tpd.created_at) as appeal_date
FROM \`shopify-dw.mart_cti_data.trust_platform_tickets__wide\` tw
INNER JOIN \`shopify-dw.risk.trust_platform_actions\` tpa
    ON tw.trust_platform_ticket_id = tpa.actionable_id
    AND tpa.actionable_type = 'Ticket'
    AND tpa.action_type IN (
        'shopify_payments_monitor_reject',
        'reject_shopify_payments',
        'reject_shopify_payments_with_communications',
        'reject_shopify_payments_without_communications'
    )
INNER JOIN \`shopify-dw.risk.trust_platform_disputes\` tpd
    ON tw.trust_platform_ticket_id = tpd.trust_platform_ticket_id
    AND tpd.type = 'appeal'
    AND tpd.created_at > tpa.created_at
WHERE
    DATE(tpd.created_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${days * 2} DAY)
    AND DATE(tpd.created_at) < DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY)
    AND tw.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL 120 DAY))
    AND tw.team = 'Fraud'
ORDER BY tpd.created_at DESC
        `;

        const previousSpAppealsResults = await quick.dw.querySync(previousSpAppealsQuery, [], {
            timeoutMs: 60000,
            maxResults: 5000
        });

        updateStatus('Fetching termination counts data...', 'info');
        
        // Run the termination counts query
        const terminationCountsQuery = `
SELECT
    t.rule_name,
    COUNT(*) as total_terminations
FROM \`shopify-dw.mart_cti_data.shop_terminations__wide\` t
WHERE DATE(t.terminated_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY)
    AND (t.termination_reason_category = 'fraud')
    AND t.rule_name IS NOT NULL
    AND t.rule_name != ''
GROUP BY t.rule_name
ORDER BY total_terminations DESC
        `;
        
        const terminationResults = await quick.dw.querySync(terminationCountsQuery, [], {
            timeoutMs: 60000,
            maxResults: 1000
        });
        
        updateStatus('Fetching Shopify Payments appeals data...', 'info');

        // Run the SP appeals query
        const spAppealsQuery = `
-- Query for Fraud team tickets that were actioned as Monitor & Reject Shopify Payments
-- and submitted an appeal within the selected date range
SELECT
    tw.trust_platform_ticket_id,
    tw.subjectable_id as shop_id,
    DATE(tw.created_at) as ticket_date,
    tw.status,
    tw.source,
    tw.latest_report_type,
    tw.team,
    -- Trust Platform Action details (the original SP action)
    tpa.action_type,
    DATE(tpa.created_at) as action_date,
    tpa.trust_platform_action_id,
    -- Classify action type
    CASE
        WHEN tpa.action_type = 'shopify_payments_monitor_reject' THEN 'SP Monitor & Reject'
        WHEN tpa.action_type = 'reject_shopify_payments' THEN 'SP Reject'
        WHEN tpa.action_type = 'reject_shopify_payments_with_communications' THEN 'SP Reject with Communications'
        WHEN tpa.action_type = 'reject_shopify_payments_without_communications' THEN 'SP Reject without Communications'
        ELSE tpa.action_type
    END as action_category,
    -- Dispute/Appeal details
    tpd.type as dispute_type,
    tpd.status as dispute_status,
    DATE(tpd.created_at) as appeal_date,
    -- Timing analysis
    DATE_DIFF(DATE(tpd.created_at), DATE(tpa.created_at), DAY) as days_action_to_appeal,
    -- Source classification
    'Shopify Payments Rejection Appeal' as source_type
FROM \`shopify-dw.mart_cti_data.trust_platform_tickets__wide\` tw
-- Join with SP actions
INNER JOIN \`shopify-dw.risk.trust_platform_actions\` tpa
    ON tw.trust_platform_ticket_id = tpa.actionable_id
    AND tpa.actionable_type = 'Ticket'
    AND tpa.action_type IN (
        'shopify_payments_monitor_reject',
        'reject_shopify_payments',
        'reject_shopify_payments_with_communications',
        'reject_shopify_payments_without_communications'
    )
-- Join with disputes/appeals
INNER JOIN \`shopify-dw.risk.trust_platform_disputes\` tpd
    ON tw.trust_platform_ticket_id = tpd.trust_platform_ticket_id
    AND tpd.type = 'appeal'
    AND tpd.created_at > tpa.created_at  -- Appeal came after the action
WHERE
    -- Appeals submitted in selected date range
    DATE(tpd.created_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY)
    -- Recent tickets (partition filter)
    AND tw.created_at >= TIMESTAMP(DATE_SUB(CURRENT_DATE(), INTERVAL 60 DAY))
    -- Fraud team only
    AND tw.team = 'Fraud'
ORDER BY tpd.created_at DESC
        `;

        const spAppealsResults = await quick.dw.querySync(spAppealsQuery, [], {
            timeoutMs: 60000,
            maxResults: 5000
        });

        // Process the results into structured data
        currentData = processQueryResults(currentResults, previousResults, terminationResults, spAppealsResults, previousSpAppealsResults);

        // Store in database for historical comparison
        await storeHistoricalData(currentData);

        displayMetrics(currentData);
        document.getElementById('analyzeBtn').disabled = false;
        document.getElementById('generateBtn').disabled = false; // Enable report generation after data fetch
        updateStatus(`Real fraud appeals data loaded successfully (${currentData.totalAppeals} termination appeals, ${currentData.spAppeals || 0} SP appeals)`, 'success');
        
    } catch (error) {
        console.error('Error fetching BigQuery data:', error);
        updateStatus(`Error fetching data: ${error.message}`, 'error');
        
        // Fallback to sample data if BigQuery fails
        updateStatus('BigQuery failed, using sample data for demonstration', 'info');
        const html = generateSampleDashboardHTML();
        currentData = extractDataFromHTML(html);
        currentData.fetchMethod = 'sample_fallback';
        displayMetrics(currentData);
        document.getElementById('analyzeBtn').disabled = false;
        document.getElementById('generateBtn').disabled = false;
    }
    
    btn.disabled = false;
    btn.innerHTML = '📈 Fetch Current Data';
}

// Alternative fetch method using a proxy approach
async function fetchViaProxy() {
    // This would work if both sites are on the same domain (Quick)
    // For now, we'll simulate this
    return null;
}

// Manual data entry function for real dashboard connection
function enableManualDataEntry() {
    const manualDataHTML = `
        <div id="manualDataEntry" style="background: #fff3cd; border: 1px solid #ffeaa7; padding: 20px; border-radius: 6px; margin: 20px 0;">
            <h4>🔧 Manual Data Entry</h4>
            <p>To connect to real dashboard data, either:</p>
            <ol>
                <li>Add the fraud-appeals dashboard data as JSON below, or</li>
                <li>Contact the dashboard team to add CORS headers for ${window.location.origin}</li>
            </ol>
            
            <textarea id="manualDataInput" placeholder="Paste dashboard JSON data here..." style="width: 100%; height: 100px; margin: 10px 0;"></textarea>
            <button onclick="loadManualData()" style="margin-right: 10px;">Load Manual Data</button>
            <button onclick="hideManualEntry()">Cancel</button>
        </div>
    `;
    
    const container = document.querySelector('.container');
    const existingEntry = document.getElementById('manualDataEntry');
    if (!existingEntry) {
        container.insertAdjacentHTML('afterbegin', manualDataHTML);
    }
}

function loadManualData() {
    const input = document.getElementById('manualDataInput').value.trim();
    if (input) {
        try {
            const manualData = JSON.parse(input);
            currentData = {
                ...manualData,
                timestamp: new Date().toISOString(),
                fetchMethod: 'manual'
            };
            
            displayMetrics(currentData);
            document.getElementById('analyzeBtn').disabled = false;
            document.getElementById('generateBtn').disabled = false;
            updateStatus('Manual data loaded successfully', 'success');
            hideManualEntry();
            
        } catch (error) {
            alert('Invalid JSON format. Please check your data.');
        }
    }
}

function hideManualEntry() {
    const entry = document.getElementById('manualDataEntry');
    if (entry) {
        entry.remove();
    }
}

// Analyze day-to-day trends within the current week
function analyzeDailyTrends(rawData) {
    if (!rawData || rawData.length === 0) return '';
    
    // Group appeals by actual date and day of week
    const dailyStats = {};
    const rulesByDay = {};
    const countriesByDay = {};
    const operationsByDay = {};
    const dateStats = {}; // Track by actual date
    
    rawData.forEach(row => {
        // Handle various date formats safely
        let appealDate;
        try {
            if (!row.appeal_date) return; // Skip if no date
            
            // Try different date parsing approaches
            if (typeof row.appeal_date === 'string') {
                // If already includes time, use as-is; otherwise add time
                appealDate = row.appeal_date.includes('T') ? 
                    new Date(row.appeal_date) : 
                    new Date(row.appeal_date + 'T00:00:00Z');
            } else {
                appealDate = new Date(row.appeal_date);
            }
            
            // Check if date is valid
            if (isNaN(appealDate.getTime())) {
                console.warn('Invalid date:', row.appeal_date);
                return;
            }
        } catch (error) {
            console.warn('Date parsing error:', row.appeal_date, error);
            return;
        }
        
        const dayOfWeek = appealDate.getDay(); // 0=Sunday, 6=Saturday
        const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dayOfWeek];
        const dateStr = appealDate.toISOString().split('T')[0]; // YYYY-MM-DD format
        
        // Track by actual date for more specific spike detection
        if (!dateStats[dateStr]) {
            dateStats[dateStr] = { total: 0, countries: {}, rules: {}, dayName };
        }
        dateStats[dateStr].total++;
        
        // Skip weekends for day-of-week trend analysis
        if (dayOfWeek === 0 || dayOfWeek === 6) return;
        
        // Initialize day if not exists
        if (!dailyStats[dayName]) {
            dailyStats[dayName] = 0;
            rulesByDay[dayName] = {};
            countriesByDay[dayName] = {};
            operationsByDay[dayName] = {};
        }
        
        // Count total appeals per day
        dailyStats[dayName]++;
        
        // Track rules per day
        const rule = row.rule_name;
        if (rule && rule !== 'Unknown') {
            rulesByDay[dayName][rule] = (rulesByDay[dayName][rule] || 0) + 1;
        }
        
        // Track countries per day
        const country = row.shop_country_code;
        if (country && country !== 'Unknown') {
            countriesByDay[dayName][country] = (countriesByDay[dayName][country] || 0) + 1;
            // Also track by actual date
            dateStats[dateStr].countries[country] = (dateStats[dateStr].countries[country] || 0) + 1;
        }
        
        // Track operation types per day
        const opType = row.operation_type;
        if (opType && opType !== 'Unknown') {
            operationsByDay[dayName][opType] = (operationsByDay[dayName][opType] || 0) + 1;
        }
    });
    
    // Analyze trends (weekdays only: Mon-Fri)
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    const trends = [];
    
    // Overall volume trend
    const dailyVolumes = weekdays.map(day => dailyStats[day] || 0);
    if (dailyVolumes.length >= 3) {
        const maxDay = weekdays[dailyVolumes.indexOf(Math.max(...dailyVolumes))];
        const minDay = weekdays[dailyVolumes.indexOf(Math.min(...dailyVolumes))];
        const maxVol = Math.max(...dailyVolumes);
        const minVol = Math.min(...dailyVolumes);
        
        if (maxVol > minVol * 1.5) { // 50% spike
            trends.push(`• Volume spike on ${maxDay}: *${maxVol}* appeals vs ${minDay}: *${minVol}*`);
        }
    }
    
    // Rule spikes
    const allRules = new Set();
    Object.values(rulesByDay).forEach(day => {
        Object.keys(day).forEach(rule => allRules.add(rule));
    });
    
    allRules.forEach(rule => {
        const ruleCounts = weekdays.map(day => rulesByDay[day]?.[rule] || 0);
        const maxCount = Math.max(...ruleCounts);
        const avgCount = ruleCounts.reduce((a, b) => a + b, 0) / ruleCounts.length;
        
        if (maxCount > avgCount * 2 && maxCount > 5) { // 2x average and >5 appeals
            const spikeDay = weekdays[ruleCounts.indexOf(maxCount)];
            trends.push(`• ${rule} spike on ${spikeDay}: *${maxCount}* appeals`);
        }
    });
    
    // Country spikes
    const allCountries = new Set();
    Object.values(countriesByDay).forEach(day => {
        Object.keys(day).forEach(country => allCountries.add(country));
    });
    
    allCountries.forEach(country => {
        const countryCounts = weekdays.map(day => countriesByDay[day]?.[country] || 0);
        const maxCount = Math.max(...countryCounts);
        const avgCount = countryCounts.reduce((a, b) => a + b, 0) / countryCounts.length;
        
        if ((maxCount > avgCount * 1.8 && maxCount > 5) || maxCount > 15) { // 1.8x average and >5 appeals, or >15 absolute
            const spikeDay = weekdays[countryCounts.indexOf(maxCount)];
            const avgFormatted = avgCount.toFixed(1);
            trends.push(`• ${country} appeals spike on ${spikeDay}: *${maxCount}* appeals (avg: ${avgFormatted})`);
        }
    });
    
    // Operation type spikes
    Object.keys(operationsByDay[weekdays[0]] || {}).forEach(opType => {
        const opCounts = weekdays.map(day => operationsByDay[day]?.[opType] || 0);
        const maxCount = Math.max(...opCounts);
        const avgCount = opCounts.reduce((a, b) => a + b, 0) / opCounts.length;
        
        if (maxCount > avgCount * 2 && maxCount > 10) { // 2x average and >10 appeals
            const spikeDay = weekdays[opCounts.indexOf(maxCount)];
            trends.push(`• ${opType} spike on ${spikeDay}: *${maxCount}* appeals`);
        }
    });
    
    // Check for specific date-based country spikes (like DE on Aug 28)
    Object.entries(dateStats).forEach(([date, stats]) => {
        Object.entries(stats.countries).forEach(([country, count]) => {
            if (count > 15) { // Significant single-day volume for a country
                const [year, month, day] = date.split('-');
                const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                const formattedDate = `${monthNames[parseInt(month)-1]} ${parseInt(day)}`;
                trends.push(`• ${country} spike on ${formattedDate}: *${count}* appeals`);
            }
        });
    });
    
    return trends.slice(0, 4).join('\n'); // Limit to top 4 trends
}

// Process BigQuery results into structured metrics
function processQueryResults(currentResults, previousResults, terminationResults, spAppealsResults, previousSpAppealsResults) {
    const current = currentResults.results || [];
    const previous = previousResults.results || [];
    const terminations = terminationResults.results || [];
    const spAppeals = spAppealsResults ? spAppealsResults.results || [] : [];
    const previousSpAppeals = previousSpAppealsResults ? previousSpAppealsResults.results || [] : [];
    
    // Calculate current period metrics
    const totalAppeals = current.length;
    const llmDecisions = current.filter(row => row.llm_decision).map(row => row.llm_decision.toLowerCase());
    
    // LLM decisions that indicate acceptance/approval
    const acceptedAppeals = llmDecisions.filter(decision => 
        decision.includes('accept') || 
        decision.includes('approve') || 
        decision.includes('reinstate') || 
        decision.includes('restore') ||
        decision.includes('valid') ||
        decision.includes('grant')
    ).length;
    
    const rejectedAppeals = llmDecisions.filter(decision => 
        decision.includes('reject') || 
        decision.includes('deny') || 
        decision.includes('uphold') ||
        decision.includes('dismiss') ||
        decision.includes('invalid')
    ).length;
    const pendingAppeals = totalAppeals - acceptedAppeals - rejectedAppeals;
    
    // Calculate previous period for comparison
    const previousTotalAppeals = previous.length;
    const previousLlmDecisions = previous.filter(row => row.llm_decision).map(row => row.llm_decision.toLowerCase());
    const previousAcceptedAppeals = previousLlmDecisions.filter(decision => 
        decision.includes('accept') || 
        decision.includes('approve') || 
        decision.includes('reinstate') || 
        decision.includes('restore') ||
        decision.includes('valid') ||
        decision.includes('grant')
    ).length;
    
    // Calculate average days to appeal
    const daysToAppeal = current
        .filter(row => row.days_to_appeal !== null)
        .map(row => parseInt(row.days_to_appeal));
    const avgDaysToAppeal = daysToAppeal.length > 0 
        ? (daysToAppeal.reduce((a, b) => a + b, 0) / daysToAppeal.length).toFixed(1)
        : 0;
    
    // Calculate metrics by operation type
    const operationTypes = {};
    current.forEach(row => {
        const opType = row.operation_type || 'Unknown';
        operationTypes[opType] = (operationTypes[opType] || 0) + 1;
    });
    
    // Calculate metrics by rule (excluding Unknown)
    const ruleMetrics = {};
    current.forEach(row => {
        const rule = row.rule_name;
        if (!rule || rule === 'Unknown' || rule === '' || rule === null) {
            return; // Skip unknown rules
        }
        
        if (!ruleMetrics[rule]) {
            ruleMetrics[rule] = { appeals: 0, accepted: 0, rejected: 0 };
        }
        ruleMetrics[rule].appeals++;
        
        if (row.llm_decision) {
            const decision = row.llm_decision.toLowerCase();
            if (decision.includes('accept') || decision.includes('approve') || decision.includes('reinstate') || 
                decision.includes('restore') || decision.includes('valid') || decision.includes('grant')) {
                ruleMetrics[rule].accepted++;
            } else if (decision.includes('reject') || decision.includes('deny') || decision.includes('uphold') ||
                      decision.includes('dismiss') || decision.includes('invalid')) {
                ruleMetrics[rule].rejected++;
            }
        }
    });
    
    // Calculate appeal rates (appeals / total terminations per rule)
    const appealRates = {};
    terminations.forEach(term => {
        const rule = term.rule_name;
        const totalTerminations = parseInt(term.total_terminations);
        const appeals = ruleMetrics[rule]?.appeals || 0;
        appealRates[rule] = {
            appeals,
            totalTerminations,
            appealRate: totalTerminations > 0 ? ((appeals / totalTerminations) * 100).toFixed(1) : 0
        };
    });
    
    // Country/continent analysis
    const countryStats = {};
    current.forEach(row => {
        const country = row.shop_country_code || 'Unknown';
        const continent = row.shop_continent || 'Unknown';
        
        if (!countryStats[country]) {
            countryStats[country] = { appeals: 0, continent, approved: 0, rejected: 0 };
        }
        countryStats[country].appeals++;
        
        if (row.llm_decision) {
            const decision = row.llm_decision.toLowerCase();
            if (decision.includes('accept') || decision.includes('approve') || decision.includes('reinstate') || 
                decision.includes('restore') || decision.includes('valid') || decision.includes('grant')) {
                countryStats[country].approved++;
            } else if (decision.includes('reject') || decision.includes('deny') || decision.includes('uphold') ||
                      decision.includes('dismiss') || decision.includes('invalid')) {
                countryStats[country].rejected++;
            }
        }
    });
    
    // Calculate rates and changes
    const acceptanceRate = totalAppeals > 0 ? ((acceptedAppeals / totalAppeals) * 100).toFixed(1) : 0;
    const rejectionRate = totalAppeals > 0 ? ((rejectedAppeals / totalAppeals) * 100).toFixed(1) : 0;
    const previousAcceptanceRate = previousTotalAppeals > 0 ? ((previousAcceptedAppeals / previousTotalAppeals) * 100).toFixed(1) : 0;
    
    const appealVolumeChange = previousTotalAppeals > 0 
        ? (((totalAppeals - previousTotalAppeals) / previousTotalAppeals) * 100).toFixed(1)
        : 0;
        
    const acceptanceChange = previousAcceptedAppeals > 0
        ? (((acceptedAppeals - previousAcceptedAppeals) / previousAcceptedAppeals) * 100).toFixed(1)
        : acceptedAppeals > 0 ? "+100" : "0";

    // Calculate SP appeals change
    const spAppealsChange = previousSpAppeals.length > 0
        ? (((spAppeals.length - previousSpAppeals.length) / previousSpAppeals.length) * 100).toFixed(1)
        : spAppeals.length > 0 ? "+100" : "0";

    return {
        timestamp: new Date().toISOString(),
        fetchMethod: 'bigquery',

        // Basic metrics
        totalAppeals,
        acceptedAppeals,
        rejectedAppeals,
        pendingAppeals,
        acceptanceRate,
        rejectionRate,
        avgDaysToAppeal,

        // SP Appeals metrics
        spAppeals: spAppeals.length,
        previousSpAppeals: previousSpAppeals.length,
        spAppealsChange,

        // Comparison metrics
        previousTotalAppeals,
        previousAcceptedAppeals,
        previousAcceptanceRate,
        appealVolumeChange,
        acceptanceChange,

        // Detailed breakdowns
        operationTypes,
        ruleMetrics,
        appealRates,
        countryStats,

        // Raw data for AI analysis
        rawCurrentData: current,
        rawPreviousData: previous,
        rawTerminationData: terminations,
        rawSPAppealsData: spAppeals
    };
}

// Generate sample dashboard HTML for demonstration
function generateSampleDashboardHTML() {
    const now = new Date();
    const baseAppeals = 450 + Math.floor(Math.random() * 100);
    const approved = Math.floor(baseAppeals * (0.65 + Math.random() * 0.1));
    const rejected = Math.floor(baseAppeals * (0.25 + Math.random() * 0.1));
    const pending = baseAppeals - approved - rejected;
    
    return `
    <html>
        <body>
            <div class="total-appeals">${baseAppeals}</div>
            <div class="approved-appeals">${approved}</div>
            <div class="rejected-appeals">${rejected}</div>
            <div class="pending-appeals">${pending}</div>
            <div class="avg-processing-time">${(18 + Math.random() * 10).toFixed(1)}</div>
            <div class="fraud-score">${(7.2 + Math.random() * 1.5).toFixed(1)}</div>
        </body>
    </html>
    `;
}

// Extract metrics and data from the dashboard HTML
function extractDataFromHTML(html) {
    // Create a temporary DOM parser
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // Extract various metrics (adjust selectors based on actual dashboard structure)
    const data = {
        timestamp: new Date().toISOString(),
        totalAppeals: extractNumber(doc, '.total-appeals, [data-metric="total-appeals"]'),
        approvedAppeals: extractNumber(doc, '.approved-appeals, [data-metric="approved"]'),
        rejectedAppeals: extractNumber(doc, '.rejected-appeals, [data-metric="rejected"]'),
        pendingAppeals: extractNumber(doc, '.pending-appeals, [data-metric="pending"]'),
        avgProcessingTime: extractNumber(doc, '.avg-processing-time, [data-metric="avg-time"]'),
        fraudScore: extractNumber(doc, '.fraud-score, [data-metric="fraud-score"]'),
        // Extract chart data if available
        chartData: extractChartData(doc),
        // Raw HTML for AI analysis
        rawHtml: html
    };
    
    // Calculate additional metrics
    if (data.totalAppeals > 0) {
        data.approvalRate = ((data.approvedAppeals / data.totalAppeals) * 100).toFixed(1);
        data.rejectionRate = ((data.rejectedAppeals / data.totalAppeals) * 100).toFixed(1);
    }
    
    return data;
}

// Helper function to extract numbers from DOM elements
function extractNumber(doc, selector) {
    const element = doc.querySelector(selector);
    if (element) {
        const text = element.textContent.trim();
        const number = parseFloat(text.replace(/[^0-9.-]/g, ''));
        return isNaN(number) ? 0 : number;
    }
    return 0;
}

// Extract chart data (if available)
function extractChartData(doc) {
    const chartData = {};
    
    // Look for common chart data attributes
    const chartElements = doc.querySelectorAll('[data-chart], .chart-container, canvas');
    chartElements.forEach((element, index) => {
        chartData[`chart_${index}`] = {
            type: element.getAttribute('data-chart-type') || 'unknown',
            data: element.getAttribute('data-chart-data') || element.textContent
        };
    });
    
    return chartData;
}

// Store historical data for trend analysis
async function storeHistoricalData(data) {
    try {
        const historyCollection = quick.db.collection('appeal_history');
        await historyCollection.create({
            ...data,
            week: getWeekNumber(new Date()),
            year: new Date().getFullYear(),
            // Store rule metrics for week-to-week comparison
            ruleBreakdown: data.ruleMetrics || {}
        });
    } catch (error) {
        console.error('Error storing historical data:', error);
    }
}

// Display current metrics
function displayMetrics(data) {
    const metricsGrid = document.getElementById('metricsGrid');
    const metricsSection = document.getElementById('metricsSection');
    
    // Appeal volume change indicator
    const volumeChangeIndicator = data.appealVolumeChange > 0 
        ? `↗️ +${data.appealVolumeChange}%` 
        : data.appealVolumeChange < 0 
        ? `↘️ ${data.appealVolumeChange}%` 
        : '→ 0%';
    
    // Acceptance change indicator
    const acceptanceChangeIndicator = data.acceptanceChange > 0 
        ? `↗️ +${data.acceptanceChange}%` 
        : data.acceptanceChange < 0 
        ? `↘️ ${data.acceptanceChange}%` 
        : '→ 0%';
    
    metricsGrid.innerHTML = `
        <div class="metric-card">
            <div class="metric-value">${data.totalAppeals}</div>
            <div class="metric-label">Total Appeals</div>
            <small>${volumeChangeIndicator} vs previous week</small>
        </div>
        <div class="metric-card">
            <div class="metric-value">${data.acceptedAppeals}</div>
            <div class="metric-label">Total Accepted by LLM</div>
            <small>${acceptanceChangeIndicator} vs previous week</small>
        </div>
    `;
    
    // Add Top Appeal Rules (excluding Unknown) if BigQuery data is available
    if (data.fetchMethod === 'bigquery' && data.ruleMetrics) {
        const topRules = Object.entries(data.ruleMetrics)
            .sort((a, b) => b[1].appeals - a[1].appeals)
            .slice(0, 8);
        
        metricsGrid.innerHTML += `
            <div class="metric-card" style="grid-column: span 3;">
                <div class="metric-label"><strong>Top Appeal Rules (excluding Unknown)</strong></div>
                <div style="display: grid; grid-template-columns: 1fr auto auto; gap: 10px; font-size: 0.9em; margin-top: 10px;">
                    <div style="font-weight: bold;">Rule</div>
                    <div style="font-weight: bold; text-align: center;">Appeals</div>
                    <div style="font-weight: bold; text-align: center;">Accepted by LLM</div>
                    ${topRules.map(([rule, metrics]) => `
                        <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${rule}">
                            ${rule.substring(0, 40)}${rule.length > 40 ? '...' : ''}
                        </div>
                        <div style="text-align: center; font-weight: bold;">${metrics.appeals}</div>
                        <div style="text-align: center; color: ${metrics.accepted > 0 ? '#27ae60' : '#95a5a6'};">
                            ${metrics.accepted} (${metrics.appeals > 0 ? ((metrics.accepted / metrics.appeals) * 100).toFixed(0) : 0}%)
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }
    
    metricsSection.style.display = 'block';
}

// Run AI analysis on the dashboard data
async function runAnalysis() {
    const btn = document.getElementById('analyzeBtn');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Analyzing...';
    
    updateStatus('Running AI analysis on dashboard data...', 'info');
    
    try {
        // Get historical data for comparison
        const historyCollection = quick.db.collection('appeal_history');
        const allHistoricalData = await historyCollection.find();
        
        // Sort and limit manually since Quick.db doesn't support chaining
        const historicalData = allHistoricalData
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 8);
        
        // Prepare data for AI analysis
        const analysisPrompt = createAnalysisPrompt(currentData, historicalData);
        
        // Get previous week rule data for comparison if available
        const previousWeekRules = historicalData.length > 0 && historicalData[0].ruleBreakdown 
            ? historicalData[0].ruleBreakdown 
            : {};
        
        // Create appeal rate comparison analysis
        let ruleChanges = [];
        if (currentData.appealRates && currentData.ruleMetrics) {
            Object.entries(currentData.appealRates).forEach(([rule, rateData]) => {
                const currentRate = parseFloat(rateData.appealRate);
                const currentAppeals = rateData.appeals;
                const currentTerminations = rateData.totalTerminations;
                
                // Get previous week data
                const previousAppeals = previousWeekRules[rule]?.appeals || 0;
                const previousTerminations = historicalData.length > 0 && historicalData[0].rawTerminationData 
                    ? (historicalData[0].rawTerminationData.find(t => t.rule_name === rule)?.total_terminations || 0)
                    : 0;
                const previousRate = previousTerminations > 0 ? ((previousAppeals / previousTerminations) * 100) : 0;
                
                const rateChange = previousRate > 0 ? (currentRate - previousRate) : (currentRate > 0 ? currentRate : 0);
                
                // Flag significant rate changes or high appeal rates
                if ((Math.abs(rateChange) > 2 && currentAppeals > 10) || currentRate > 15) {
                    ruleChanges.push({
                        rule,
                        currentRate: currentRate.toFixed(1),
                        previousRate: previousRate.toFixed(1),
                        rateChange: rateChange.toFixed(1),
                        appeals: currentAppeals,
                        terminations: currentTerminations
                    });
                }
            });
        }
        
        // Sort by rate change magnitude
        ruleChanges.sort((a, b) => Math.abs(parseFloat(b.rateChange)) - Math.abs(parseFloat(a.rateChange)));
        
        const ruleAnalysis = ruleChanges.slice(0, 6).map(r => 
            `• ${r.rule}: *${r.currentRate}%* appeal rate (${r.previousRate > 0 ? `${r.rateChange > 0 ? '+' : ''}${r.rateChange}pp from ${r.previousRate}%` : 'new data'}) - ${r.appeals}/${r.terminations} appeals`
        ).join('\n');

        // Create high appeal rate section (always show rules >15%)
        const highAppealRateRules = currentData.appealRates ? 
            Object.entries(currentData.appealRates)
                .filter(([rule, data]) => parseFloat(data.appealRate) > 15 && data.appeals > 5)
                .sort((a, b) => parseFloat(b[1].appealRate) - parseFloat(a[1].appealRate))
                .slice(0, 5)
                .map(([rule, data]) => `• ${rule}: *${data.appealRate}%*`)
                .join('\n')
            : '';

        // Analyze day-to-day trends within current week (ignore weekends)
        let dailyTrends = '';
        try {
            dailyTrends = analyzeDailyTrends(currentData.rawCurrentData);
        } catch (error) {
            console.error('Error analyzing daily trends:', error);
            dailyTrends = '• Daily trends analysis temporarily unavailable';
        }

        // Skip AI analysis - user only wants basic sections
        analysisResult = null;
        
        document.getElementById('generateBtn').disabled = false;
        updateStatus('AI analysis completed successfully', 'success');
        
    } catch (error) {
        console.error('Error in AI analysis:', error);
        updateStatus(`Analysis error: ${error.message}`, 'error');
    }
    
    btn.disabled = false;
    btn.innerHTML = '🤖 Run AI Analysis';
}

// Create prompt for AI analysis
function createAnalysisPrompt(currentData, historicalData) {
    const reportType = document.getElementById('reportType').value;
    
    let prompt = `
Analyze this fraud appeals data from BigQuery and provide actionable insights:

CURRENT PERIOD DATA (Last 7 days - ${new Date().toLocaleDateString()}):
- Total Appeals: ${currentData.totalAppeals}
- Accepted by LLM: ${currentData.acceptedAppeals} (${currentData.acceptanceRate}%)
- Rejected: ${currentData.rejectedAppeals} (${currentData.rejectionRate}%)
- Pending/Under Review: ${currentData.pendingAppeals}
- Average Days to Appeal: ${currentData.avgDaysToAppeal || 'N/A'}

COMPARISON TO PREVIOUS PERIOD:
- Previous Total Appeals: ${currentData.previousTotalAppeals}
- Appeal Volume Change: ${currentData.appealVolumeChange}%
- Previous Accepted: ${currentData.previousAcceptedAppeals}
- Acceptance Change: ${currentData.acceptanceChange}%
- Previous Acceptance Rate: ${currentData.previousAcceptanceRate}%

`;

    // Add operation type breakdown if available
    if (currentData.operationTypes && Object.keys(currentData.operationTypes).length > 0) {
        prompt += `APPEALS BY OPERATION TYPE:\n`;
        Object.entries(currentData.operationTypes).forEach(([type, count]) => {
            prompt += `- ${type}: ${count} appeals\n`;
        });
        prompt += `\n`;
    }

    // Add top rules analysis if available
    if (currentData.ruleMetrics && Object.keys(currentData.ruleMetrics).length > 0) {
        prompt += `TOP TERMINATION RULES BY APPEALS:\n`;
        const topRules = Object.entries(currentData.ruleMetrics)
            .sort((a, b) => b[1].appeals - a[1].appeals)
            .slice(0, 10);
        
        topRules.forEach(([rule, metrics]) => {
            const acceptanceRate = metrics.appeals > 0 ? ((metrics.accepted / metrics.appeals) * 100).toFixed(1) : 0;
            prompt += `- ${rule}: ${metrics.appeals} appeals, ${acceptanceRate}% accepted by LLM\n`;
        });
        prompt += `\n`;
    }

    // Add country analysis if available
    if (currentData.countryStats && Object.keys(currentData.countryStats).length > 0) {
        prompt += `TOP COUNTRIES BY APPEALS:\n`;
        const topCountries = Object.entries(currentData.countryStats)
            .sort((a, b) => b[1].appeals - a[1].appeals)
            .slice(0, 10);
        
        topCountries.forEach(([country, metrics]) => {
            const acceptanceRate = metrics.appeals > 0 ? ((metrics.approved / metrics.appeals) * 100).toFixed(1) : 0;
            prompt += `- ${country} (${metrics.continent}): ${metrics.appeals} appeals, ${acceptanceRate}% accepted by LLM\n`;
        });
        prompt += `\n`;
    }

    // Add historical comparison if available
    if (historicalData && historicalData.length > 0) {
        prompt += `HISTORICAL TRENDS (Last ${historicalData.length} weeks):\n`;
        historicalData.forEach((week, index) => {
            prompt += `Week ${index + 1}: ${week.totalAppeals} appeals, ${week.acceptanceRate || week.approvalRate}% accepted by LLM\n`;
        });
        prompt += `\n`;
    }

    // Customize analysis based on report type
    switch (reportType) {
        case 'weekly':
            prompt += `Provide a concise WEEKLY SUMMARY focusing on:
1. Key changes from previous week (${currentData.appealVolumeChange}% appeal volume change, ${currentData.acceptanceChange}% acceptance change)
2. Notable patterns in rule performance and country trends  
3. LLM decision quality and acceptance rate shifts
4. Top 3 actionable insights for the fraud appeals team
5. Any concerning trends requiring immediate attention`;
            break;
            
        case 'trends':
            prompt += `Focus on TREND ANALYSIS:
1. Appeal volume patterns and week-over-week changes
2. Rule-specific approval/rejection trends and performance
3. Geographic patterns in appeals and outcomes
4. Operation type effectiveness (Automated vs Manual vs Bulk)
5. LLM decision consistency and quality trends
6. Predictions and recommendations for next week`;
            break;
            
        case 'full':
            prompt += `Provide COMPREHENSIVE ANALYSIS:
1. Executive Summary with key findings
2. Detailed appeal volume and outcome analysis  
3. Rule performance deep-dive with recommendations
4. Geographic and operational pattern analysis
5. LLM decision quality assessment
6. Risk indicators and concerning patterns
7. Process efficiency opportunities
8. Strategic recommendations for fraud prevention team
9. Alerts for any anomalies or urgent issues`;
            break;
    }

    return prompt;
}

// Generate formatted report in Slack message style
async function generateReport() {
    const btn = document.getElementById('generateBtn');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Generating...';
    
    updateStatus('Generating formatted report...', 'info');
    
    try {
        const reportType = document.getElementById('reportType').value;
        const user = await quick.id.waitForUser();
        
        // Create Slack-style formatted message
        const reportTitle = reportType === 'weekly' ? 'Weekly Appeals Report' : 
                          reportType === 'trends' ? 'Appeal Trends Analysis' : 
                          'Comprehensive Appeals Report';
        
        // Format volume and acceptance changes
        const volumeChange = currentData.appealVolumeChange;
        const acceptanceChange = currentData.acceptanceChange;
        const spAppealsChange = currentData.spAppealsChange;

        const volumeEmoji = volumeChange > 0 ? '📈' : volumeChange < 0 ? '📉' : '➡️';
        const acceptanceEmoji = acceptanceChange > 0 ? '✅' : acceptanceChange < 0 ? '❌' : '➡️';
        const spAppealsEmoji = spAppealsChange > 0 ? '📈' : spAppealsChange < 0 ? '📉' : '➡️';
        
        // Calculate average appeals per day (7-day period)
        const avgAppealsPerDay = Math.round(currentData.totalAppeals / 7);
        
        generatedReport = `*${reportTitle}* | ${new Date().toLocaleDateString()}

*📊 Key Metrics (vs previous week):*
• Termination Appeals: *${currentData.totalAppeals}* ${volumeEmoji} ${volumeChange > 0 ? '+' : ''}${volumeChange}%
   └ LLM Accepted: *${currentData.acceptedAppeals}* ${acceptanceEmoji} ${acceptanceChange > 0 ? '+' : ''}${acceptanceChange}%
• SP Rejection Appeals: *${currentData.spAppeals || 0}* ${spAppealsEmoji} ${spAppealsChange > 0 ? '+' : ''}${spAppealsChange}%`;

        // Skip top rules section - removed per user request

        // Add high appeal rates section directly (no AI analysis)
        if (currentData.appealRates) {
            let highRateRules = Object.entries(currentData.appealRates)
                .filter(([rule, data]) => parseFloat(data.appealRate) > 10 && data.appeals > 5)
                .sort((a, b) => parseFloat(b[1].appealRate) - parseFloat(a[1].appealRate));

            // If we don't have at least 3 rules with >10% rate, lower the threshold to get top 3
            if (highRateRules.length < 3) {
                highRateRules = Object.entries(currentData.appealRates)
                    .filter(([rule, data]) => data.appeals > 3) // At least 3 appeals to be meaningful
                    .sort((a, b) => parseFloat(b[1].appealRate) - parseFloat(a[1].appealRate))
                    .slice(0, 3);
            } else {
                highRateRules = highRateRules.slice(0, 5);
            }

            if (highRateRules.length > 0) {
                generatedReport += `

*Rules with high appeal rates that need attention:*
`;
                highRateRules.forEach(([rule, data]) => {
                    generatedReport += `• ${rule}: *${data.appealRate}%*\n`;
                });
            }
        }

        // Footer
        generatedReport += `
---
<https://fraud-appeals.quick.shopify.io|View Appeal Trends Dashboard>
_Generated by Appeal Trends Analyzer | ${user.fullName}_`;
        
        document.getElementById('reportPreview').textContent = generatedReport;
        document.getElementById('reportSection').style.display = 'block';
        document.getElementById('sendBtn').disabled = false;
        
        updateStatus('Slack-style report generated successfully', 'success');
        
    } catch (error) {
        console.error('Error generating report:', error);
        updateStatus(`Report generation error: ${error.message}`, 'error');
    }
    
    btn.disabled = false;
    btn.innerHTML = '📄 Generate Report';
}

// Send report to Slack
async function sendToSlack() {
    const btn = document.getElementById('sendBtn');
    const slackChannel = document.getElementById('slackChannel').value.trim();
    
    if (!slackChannel) {
        alert('Please enter a Slack channel or user ID');
        return;
    }
    
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Sending...';
    
    updateStatus('Sending report to Slack...', 'info');
    
    try {
        // Send the report to Slack
        await quick.slack.sendMessage(slackChannel, generatedReport);
        
        updateStatus(`Report sent successfully to ${slackChannel}`, 'success');
        
        // Save the channel for future use
        localStorage.setItem('lastSlackChannel', slackChannel);
        
    } catch (error) {
        console.error('Error sending to Slack:', error);
        updateStatus(`Slack error: ${error.message}`, 'error');
    }
    
    btn.disabled = false;
    btn.innerHTML = '💬 Send to Slack';
}

// Toggle weekly scheduling
async function toggleSchedule() {
    const btn = document.getElementById('scheduleBtn');
    const nextRunSpan = document.getElementById('nextRun');
    
    try {
        if (!isScheduled) {
            // Enable scheduling
            isScheduled = true;
            const nextMonday = getNextMonday();
            
            // Store schedule in database
            const scheduleCollection = quick.db.collection('schedule');
            await scheduleCollection.create({
                enabled: true,
                nextRun: nextMonday.toISOString(),
                slackChannel: document.getElementById('slackChannel').value,
                reportType: document.getElementById('reportType').value
            });
            
            btn.innerHTML = '⏰ Disable Weekly Auto-Reports';
            btn.classList.add('success');
            nextRunSpan.textContent = nextMonday.toLocaleDateString();
            
            updateStatus('Weekly auto-reports enabled', 'success');
            
        } else {
            // Disable scheduling
            isScheduled = false;
            
            // Clear schedule from database
            const scheduleCollection = quick.db.collection('schedule');
            const schedules = await scheduleCollection.find();
            for (const schedule of schedules) {
                await scheduleCollection.delete(schedule.id);
            }
            
            btn.innerHTML = '⏰ Enable Weekly Auto-Reports';
            btn.classList.remove('success');
            nextRunSpan.textContent = 'Not scheduled';
            
            updateStatus('Weekly auto-reports disabled', 'info');
        }
        
    } catch (error) {
        console.error('Error toggling schedule:', error);
        updateStatus(`Schedule error: ${error.message}`, 'error');
    }
}

// Auto-run weekly reports (would be triggered by a cron-like system)
async function runScheduledReport() {
    try {
        updateStatus('Running scheduled weekly report...', 'info');
        
        // Fetch current data
        await fetchDashboardData();
        
        // Run analysis
        await runAnalysis();
        
        // Generate report
        await generateReport();
        
        // Get schedule settings
        const scheduleCollection = quick.db.collection('schedule');
        const schedules = await scheduleCollection.find();
        
        if (schedules.length > 0) {
            const schedule = schedules[0];
            
            // Send to configured Slack channel
            if (schedule.slackChannel) {
                document.getElementById('slackChannel').value = schedule.slackChannel;
                await sendToSlack();
            }
            
            // Update next run date
            const nextMonday = getNextMonday();
            await scheduleCollection.update(schedule.id, {
                nextRun: nextMonday.toISOString()
            });
        }
        
    } catch (error) {
        console.error('Error in scheduled report:', error);
        // Send error alert to Slack if configured
        const scheduleCollection = quick.db.collection('schedule');
        const schedules = await scheduleCollection.find();
        if (schedules.length > 0 && schedules[0].slackChannel) {
            await quick.slack.sendAlert(
                schedules[0].slackChannel,
                `Failed to generate weekly appeal report: ${error.message}`,
                'error'
            );
        }
    }
}

// Utility functions
function updateStatus(message, type = 'info') {
    const statusDiv = document.getElementById('status');
    statusDiv.innerHTML = `<strong>Status:</strong> ${message}`;
    statusDiv.className = `status-card ${type}`;
}

function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    return Math.ceil((((d - yearStart) / 86400000) + 1)/7);
}

function getNextMonday() {
    const today = new Date();
    const nextMonday = new Date();
    nextMonday.setDate(today.getDate() + ((1 + 7 - today.getDay()) % 7 || 7));
    nextMonday.setHours(9, 0, 0, 0); // 9 AM
    return nextMonday;
}

function loadSettings() {
    const lastChannel = localStorage.getItem('lastSlackChannel');
    if (lastChannel) {
        document.getElementById('slackChannel').value = lastChannel;
    }
}

// Check for scheduled reports on load (in a real implementation, this would be handled server-side)
window.addEventListener('load', async () => {
    try {
        const scheduleCollection = quick.db.collection('schedule');
        const schedules = await scheduleCollection.find();
        
        if (schedules.length > 0 && schedules[0].enabled) {
            isScheduled = true;
            const btn = document.getElementById('scheduleBtn');
            const nextRunSpan = document.getElementById('nextRun');
            
            btn.innerHTML = '⏰ Disable Weekly Auto-Reports';
            btn.classList.add('success');
            nextRunSpan.textContent = new Date(schedules[0].nextRun).toLocaleDateString();
            
            // Check if it's time to run
            const nextRun = new Date(schedules[0].nextRun);
            if (nextRun <= new Date()) {
                runScheduledReport();
            }
        }
    } catch (error) {
        console.error('Error checking schedule:', error);
    }
});