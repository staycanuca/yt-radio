/**
 * Proxy Manager - Phase 3
 * Automatic proxy scraping, testing, and rotation
 */

const axios = require("axios");
const cheerio = require("cheerio");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

// Proxy sources for scraping
const PROXY_SOURCES = [
  "https://spys.me/proxy.txt",
  "https://free-proxy-list.net/",
  "https://www.us-proxy.org/",
  "https://www.sslproxies.org/",
  "https://free-proxy-list.net/anonymous-proxy.html",
  "https://www.freeproxy.world/?type=http&anonymity=4&country=&speed=400&port=&page=1",
  "https://www.freeproxy.world/?type=http&anonymity=4&country=&speed=400&port=&page=2",
  "https://www.freeproxy.world/?type=http&anonymity=4&country=&speed=400&port=&page=3",
  "https://www.freeproxy.world/?type=http&anonymity=4&country=&speed=400&port=&page=4",
  "https://www.freeproxy.world/?type=http&anonymity=4&country=&speed=400&port=&page=5"
];

// YouTube test URL
const YOUTUBE_TEST_URL = "https://www.youtube.com/";

class ProxyManager {
  constructor(logger, config = {}) {
    this.logger = logger;
    this.config = {
      enabled: config.enabled || false,
      scrapeInterval: config.scrapeInterval || 1000 * 60 * 30, // 30 minutes
      testInterval: config.testInterval || 1000 * 60 * 5, // 5 minutes
      testTimeout: config.testTimeout || 5000, // 5 seconds
      maxProxies: config.maxProxies || 50,
      minWorkingProxies: config.minWorkingProxies || 5,
      ...config
    };
    
    this.proxies = new Map(); // Map<proxyUrl, proxyInfo>
    this.workingProxies = [];
    this.currentProxyIndex = 0;
    this.scrapeTimer = null;
    this.testTimer = null;
    this.isInitialized = false;
    this.stats = {
      totalScraped: 0,
      totalTested: 0,
      totalWorking: 0,
      totalFailed: 0,
      lastScrape: null,
      lastTest: null
    };
  }

  /**
   * Initialize proxy manager
   */
  async initialize() {
    if (!this.config.enabled) {
      this.logger.info("Proxy manager is disabled");
      return;
    }

    this.logger.info("Initializing proxy manager...");
    
    // Initial scrape and test
    await this.scrapeProxies();
    await this.testAllProxies();
    
    // Schedule periodic scraping and testing
    this.scrapeTimer = setInterval(() => {
      void this.scrapeProxies();
    }, this.config.scrapeInterval);
    
    this.testTimer = setInterval(() => {
      void this.testAllProxies();
    }, this.config.testInterval);
    
    this.isInitialized = true;
    this.logger.info(`Proxy manager initialized with ${this.workingProxies.length} working proxies`);
  }

  /**
   * Shutdown proxy manager
   */
  shutdown() {
    if (this.scrapeTimer) {
      clearInterval(this.scrapeTimer);
      this.scrapeTimer = null;
    }
    
    if (this.testTimer) {
      clearInterval(this.testTimer);
      this.testTimer = null;
    }
    
    this.logger.info("Proxy manager shut down");
  }

  /**
   * Scrape proxies from all sources
   */
  async scrapeProxies() {
    this.logger.info("Scraping proxies from sources...");
    const startTime = Date.now();
    let scrapedCount = 0;

    for (const source of PROXY_SOURCES) {
      try {
        const proxies = await this.scrapeSource(source);
        
        for (const proxy of proxies) {
          if (!this.proxies.has(proxy.url) && this.proxies.size < this.config.maxProxies) {
            this.proxies.set(proxy.url, {
              url: proxy.url,
              host: proxy.host,
              port: proxy.port,
              protocol: proxy.protocol,
              source,
              addedAt: Date.now(),
              lastTested: null,
              lastWorking: null,
              testCount: 0,
              successCount: 0,
              failCount: 0,
              avgResponseTime: null,
              status: "untested"
            });
            scrapedCount++;
          }
        }
      } catch (err) {
        this.logger.debug(`Failed to scrape ${source}:`, err.message);
      }
    }

    const duration = Date.now() - startTime;
    this.stats.totalScraped += scrapedCount;
    this.stats.lastScrape = new Date().toISOString();
    
    this.logger.info(`Scraped ${scrapedCount} new proxies in ${duration}ms (total: ${this.proxies.size})`);
  }

  /**
   * Scrape proxies from a single source
   */
  async scrapeSource(url) {
    const proxies = [];
    
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      });

      const content = response.data;

      // Try different parsing strategies
      if (url.includes("spys.me")) {
        // Plain text format: IP:PORT
        const matches = content.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g);
        if (matches) {
          matches.forEach(match => {
            const [host, port] = match.split(":");
            proxies.push({
              url: `http://${host}:${port}`,
              host,
              port: parseInt(port),
              protocol: "http"
            });
          });
        }
      } else {
        // HTML table format
        const $ = cheerio.load(content);
        
        $("table tbody tr").each((i, row) => {
          const cells = $(row).find("td");
          if (cells.length >= 2) {
            const host = $(cells[0]).text().trim();
            const port = $(cells[1]).text().trim();
            
            // Validate IP and port
            if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && /^\d{2,5}$/.test(port)) {
              proxies.push({
                url: `http://${host}:${port}`,
                host,
                port: parseInt(port),
                protocol: "http"
              });
            }
          }
        });
      }
    } catch (err) {
      this.logger.debug(`Error scraping ${url}:`, err.message);
    }

    return proxies;
  }

  /**
   * Test all proxies
   */
  async testAllProxies() {
    if (this.proxies.size === 0) {
      this.logger.warn("No proxies to test");
      return;
    }

    this.logger.info(`Testing ${this.proxies.size} proxies...`);
    const startTime = Date.now();
    const testPromises = [];

    for (const [url, proxy] of this.proxies.entries()) {
      testPromises.push(this.testProxy(proxy));
    }

    await Promise.allSettled(testPromises);

    // Update working proxies list
    this.workingProxies = Array.from(this.proxies.values())
      .filter(p => p.status === "working")
      .sort((a, b) => (a.avgResponseTime || 9999) - (b.avgResponseTime || 9999));

    const duration = Date.now() - startTime;
    this.stats.lastTest = new Date().toISOString();
    
    this.logger.info(`Tested ${this.proxies.size} proxies in ${duration}ms: ${this.workingProxies.length} working, ${this.proxies.size - this.workingProxies.length} failed`);

    // Remove old failed proxies
    this.cleanupFailedProxies();
  }

  /**
   * Test a single proxy
   */
  async testProxy(proxy) {
    const startTime = Date.now();
    
    try {
      const agent = new HttpsProxyAgent(proxy.url);
      
      const response = await axios.get(YOUTUBE_TEST_URL, {
        timeout: this.config.testTimeout,
        httpAgent: agent,
        httpsAgent: agent,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      });

      const responseTime = Date.now() - startTime;

      if (response.status === 200) {
        proxy.testCount++;
        proxy.successCount++;
        proxy.lastTested = Date.now();
        proxy.lastWorking = Date.now();
        proxy.status = "working";
        
        // Update average response time
        if (proxy.avgResponseTime === null) {
          proxy.avgResponseTime = responseTime;
        } else {
          proxy.avgResponseTime = (proxy.avgResponseTime + responseTime) / 2;
        }

        this.stats.totalWorking++;
        this.logger.debug(`✓ Proxy working: ${proxy.url} (${responseTime}ms)`);
        return true;
      }
    } catch (err) {
      proxy.testCount++;
      proxy.failCount++;
      proxy.lastTested = Date.now();
      proxy.status = "failed";
      this.stats.totalFailed++;
      this.logger.debug(`✗ Proxy failed: ${proxy.url} - ${err.message}`);
    }

    return false;
  }

  /**
   * Cleanup failed proxies
   */
  cleanupFailedProxies() {
    const now = Date.now();
    const maxAge = 1000 * 60 * 60; // 1 hour
    let removed = 0;

    for (const [url, proxy] of this.proxies.entries()) {
      // Remove if:
      // 1. Failed more than 3 times
      // 2. Never worked and older than 1 hour
      // 3. Last working more than 1 hour ago
      if (
        proxy.failCount > 3 ||
        (proxy.status === "failed" && proxy.successCount === 0 && now - proxy.addedAt > maxAge) ||
        (proxy.lastWorking && now - proxy.lastWorking > maxAge)
      ) {
        this.proxies.delete(url);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.info(`Cleaned up ${removed} failed proxies`);
    }
  }

  /**
   * Get next working proxy (rotation)
   */
  getNextProxy() {
    if (!this.config.enabled || this.workingProxies.length === 0) {
      return null;
    }

    const proxy = this.workingProxies[this.currentProxyIndex];
    this.currentProxyIndex = (this.currentProxyIndex + 1) % this.workingProxies.length;
    
    return proxy;
  }

  /**
   * Get proxy agent for HTTP requests
   */
  getProxyAgent() {
    const proxy = this.getNextProxy();
    
    if (!proxy) {
      return null;
    }

    try {
      if (proxy.protocol === "socks" || proxy.protocol === "socks5") {
        return new SocksProxyAgent(proxy.url);
      } else {
        return new HttpsProxyAgent(proxy.url);
      }
    } catch (err) {
      this.logger.warn(`Failed to create proxy agent for ${proxy.url}:`, err.message);
      return null;
    }
  }

  /**
   * Get proxy statistics
   */
  getStats() {
    return {
      enabled: this.config.enabled,
      initialized: this.isInitialized,
      totalProxies: this.proxies.size,
      workingProxies: this.workingProxies.length,
      currentIndex: this.currentProxyIndex,
      stats: this.stats,
      topProxies: this.workingProxies.slice(0, 5).map(p => ({
        url: p.url,
        avgResponseTime: Math.round(p.avgResponseTime || 0),
        successRate: p.testCount > 0 ? Math.round((p.successCount / p.testCount) * 100) : 0
      }))
    };
  }

  /**
   * Check if proxy manager has enough working proxies
   */
  hasEnoughProxies() {
    return this.workingProxies.length >= this.config.minWorkingProxies;
  }

  /**
   * Force immediate scrape and test
   */
  async refresh() {
    this.logger.info("Forcing proxy refresh...");
    await this.scrapeProxies();
    await this.testAllProxies();
  }
}

module.exports = { ProxyManager };
