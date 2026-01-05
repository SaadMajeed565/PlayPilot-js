# Site Configuration

This directory contains site-specific configuration for web automation.

## `sites-config.json`

This JSON file allows you to configure site-specific settings without modifying code. Simply add new sites or modify existing ones.

### Configuration Structure

```json
{
  "sites": {
    "domain.com": {
      "highActivity": true,
      "navigationTimeout": 60000,
      "waitUntil": "load",
      "postLoadWait": 2000,
      "customWaitSelectors": ["selector1", "selector2"],
      "customWaitTimeout": 45000,
      "customWaitFallbackSelectors": ["fallback1"],
      "customWaitFallbackTimeout": 30000,
      "additionalWaitAfterLoad": 3000,
      "fallbackWait": 5000
    }
  },
  "defaults": {
    "normalSiteTimeout": 30000,
    "normalSiteWaitUntil": "networkidle",
    "highActivityTimeout": 60000,
    "highActivityWaitUntil": "load",
    "postLoadWait": 2000,
    "fallbackTimeout": 30000
  }
}
```

### Configuration Options

#### Site-Specific Settings

- **`highActivity`** (boolean): If `true`, treats the site as high-activity (e.g., Facebook, Instagram) that never reaches `networkidle` due to continuous background requests. Uses `load` instead of `networkidle`.

- **`navigationTimeout`** (number): Timeout in milliseconds for initial page navigation. Default: 60000 for high-activity sites, 30000 for normal sites.

- **`waitUntil`** (string): Playwright wait strategy:
  - `"load"` - Wait for load event
  - `"domcontentloaded"` - Wait for DOMContentLoaded event
  - `"networkidle"` - Wait until network is idle (not recommended for high-activity sites)

- **`postLoadWait`** (number): Additional wait time in milliseconds after page load event. Default: 2000ms.

- **`customWaitSelectors`** (array): CSS selectors to wait for after navigation. Useful for sites like WhatsApp Web that need specific UI elements to load.

- **`customWaitTimeout`** (number): Timeout for custom wait selectors in milliseconds. Default: 45000ms.

- **`customWaitFallbackSelectors`** (array): Fallback CSS selectors if primary selectors fail.

- **`customWaitFallbackTimeout`** (number): Timeout for fallback selectors in milliseconds. Default: 30000ms.

- **`additionalWaitAfterLoad`** (number): Extra wait time after custom selectors load. Default: 3000ms.

- **`fallbackWait`** (number): Fallback wait time if custom selectors fail completely. Default: 5000ms.

#### Default Settings

Default values are used when a site doesn't have specific configuration or when a property is not specified for a site.

### Adding a New Site

1. Open `sites-config.json`
2. Add a new entry in the `"sites"` object with the domain (partial match works, e.g., `"example.com"` matches `"https://example.com/page"`)
3. Configure the desired settings
4. Save the file - no code changes needed!

### Example: Adding WhatsApp Web Configuration

```json
{
  "sites": {
    "web.whatsapp.com": {
      "highActivity": true,
      "navigationTimeout": 60000,
      "waitUntil": "load",
      "postLoadWait": 2000,
      "customWaitSelectors": [
        "[data-testid=\"chatlist\"]",
        "[data-testid=\"conversation-panel\"]",
        "[aria-label*=\"Chat\"]"
      ],
      "customWaitTimeout": 45000,
      "additionalWaitAfterLoad": 3000
    }
  }
}
```

### How It Works

The `SiteConfigManager` class loads this configuration file and provides methods to:
- Check if a site is high-activity
- Get navigation timeouts and wait strategies
- Retrieve custom wait selectors for specific sites

The `TaskExecutor` uses these configurations automatically when navigating to websites.

