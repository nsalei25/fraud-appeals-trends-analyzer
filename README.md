# Appeal Trends Analyzer 📊

AI-powered weekly analysis tool for fraud appeal trends, built for Shopify's Quick platform.

## 🔗 Links
- **Live App**: https://fraud-appeals-analyzer.quick.shopify.io
- **Source Dashboard**: https://fraud-appeals.quick.shopify.io

## 📋 Features

### 📊 **Key Metrics Tracking**
- Total appeals with week-over-week changes
- LLM acceptance rates and trends  
- Average appeals per day calculation

### 🎯 **Top Appeal Rules Analysis**
- Volume-based rule ranking
- LLM acceptance rates per rule
- Clean, readable formatting

### ⚠️ **High Appeal Rate Detection**  
- Automatically flags rules with >15% appeal rates
- Identifies potential rule effectiveness issues
- Focuses on rules needing attention

### 🤖 **AI-Powered Insights**
- Uses quick.ai for trend analysis
- Week-over-week pattern detection
- Actionable recommendations

### 💬 **Slack Integration**
- Formatted weekly reports
- Professional message styling
- Direct delivery to channels/users

## 🔧 Development

### Deploy Changes
```bash
# Deploy to Quick and push to GitHub in one command
./deploy.sh "Your commit message"

# Or use default message  
./deploy.sh
```

### Manual Deployment
```bash
# Deploy to Quick only
quick deploy . fraud-appeals-analyzer

# Git operations only
git add .
git commit -m "Your message"
git push origin main
```

### Local Development
1. Edit `index.html` or `app.js`  
2. Run `./deploy.sh "Description of changes"`
3. Changes are automatically:
   - Committed to git
   - Pushed to GitHub
   - Deployed to Quick

## 📊 Data Sources

The analyzer uses BigQuery data from:
- `shopify-dw.mart_cti_data.shop_terminations__wide` - Main appeals data
- `shopify-dw.risk.trust_platform_disputes` - Appeal disputes  
- `sdp-prd-cti-data.base.base__trust_platform_sensitive_trust_assessments` - LLM decisions

## 🔐 Requirements

- Access to Shopify BigQuery datasets
- Quick platform authentication
- Slack permissions for message delivery

## 📱 Usage

1. **Fetch Current Data** - Loads last 7 days of appeals data
2. **Generate Report** - Creates formatted Slack message
3. **Send to Slack** - Delivers report to specified channel/user
4. **Schedule** - Enable weekly automated reports

## 🎯 Report Sections

### Key Metrics
- Total appeals (% change vs previous week)
- Average appeals per day  
- LLM accepted appeals (% change vs previous week)

### Top Appeal Rules  
- Rules ranked by appeal volume
- Appeals count and LLM acceptance rate for each
- Excludes "Unknown" rules

### High Appeal Rates
- Rules with >15% appeal rates
- Potential rule effectiveness issues
- Requires attention for optimization

---
🤖 **Built with Claude Code** | **Deployed on Quick**