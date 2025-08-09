#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ChildProcess, spawn } from "child_process";
import CDP from "chrome-remote-interface";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";

// Create the MCP server
const server = new McpServer({
  name: "browser-tools",
  version: "1.0.0",
});

// Global state for Chrome process and network tracking
let chromeProcess: ChildProcess | null = null;
let networkRequests = new Map<string, any>();
let cdpClient: any = null;

// Helper function to detect Chrome executable path
function getChromeExecutablePath(): string {
  const platform = process.platform;

  if (platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  } else if (platform === "win32") {
    return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  } else {
    return "google-chrome"; // Linux
  }
}

// Helper function to check if Chrome is accessible and get target info
async function isChromeAccessible(): Promise<{ accessible: boolean; targets?: any[] }> {
  try {
    const targets = await CDP.List({ port: 9222 });
    return { accessible: targets.length > 0, targets };
  } catch (error) {
    return { accessible: false };
  }
}

// Helper function to kill existing Chrome debug processes
async function killChromeDebugProcesses(): Promise<void> {
  try {
    const { spawn } = await import("child_process");
    await new Promise<void>((resolve) => {
      const killProcess = spawn("pkill", ["-f", "remote-debugging-port=9222"]);
      killProcess.on("close", () => {
        setTimeout(resolve, 1000); // Wait for processes to fully terminate
      });
    });
  } catch (error) {
    // Ignore errors - process might not exist
  }
}

// Helper function to wait for Chrome to be accessible with retries
async function waitForChromeAccessible(maxRetries = 10, delayMs = 500): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    const { accessible } = await isChromeAccessible();
    if (accessible) return true;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return false;
}

// Tool: Start Chrome in debug mode
server.tool(
  "start-chrome-debug",
  "Start Chrome browser with remote debugging enabled. Use this tool to view network traffic and request details.",
  {
    userDataDir: z
      .string()
      .optional()
      .describe("Custom user data directory path (optional)"),
    headless: z
      .boolean()
      .optional()
      .default(false)
      .describe("Run Chrome in headless mode"),
  },
  async ({ userDataDir, headless }) => {
    try {
      // Check if Chrome is already running and working
      const chromeStatus = await isChromeAccessible();
      if (chromeStatus.accessible) {
        return {
          content: [
            {
              type: "text",
              text: `Chrome debug instance is already running on port 9222\nActive targets: ${chromeStatus.targets?.length || 0}`,
            },
          ],
        };
      }

      // Kill any existing Chrome debug processes that might be stuck
      await killChromeDebugProcesses();

      const chromePath = getChromeExecutablePath();
      const tempUserDataDir =
        userDataDir || join(tmpdir(), `chrome-debug-${Date.now()}`);

      const chromeArgs = [
        "--remote-debugging-port=9222",
        `--user-data-dir=${tempUserDataDir}`,
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=TranslateUI",
        "--disable-ipc-flooding-protection",
        "--no-first-run",
        "--no-default-browser-check",
      ];

      if (headless) {
        chromeArgs.push("--headless=new", "--disable-gpu");
      }

      chromeProcess = spawn(chromePath, chromeArgs, {
        stdio: "pipe",
        detached: false,
      });

      // Handle process errors
      chromeProcess.on("error", (error) => {
        throw new Error(`Failed to start Chrome: ${error.message}`);
      });

      // Wait for Chrome to be accessible with retries
      const isAccessible = await waitForChromeAccessible(15, 500);
      
      if (isAccessible) {
        const { targets } = await isChromeAccessible();
        return {
          content: [
            {
              type: "text",
              text: `Chrome debug instance started successfully!\nPID: ${chromeProcess?.pid}\nDebugging port: 9222\nUser data directory: ${tempUserDataDir}\nActive targets: ${targets?.length || 0}`,
            },
          ],
        };
      } else {
        // Clean up failed process
        if (chromeProcess) {
          chromeProcess.kill();
          chromeProcess = null;
        }
        throw new Error(
          "Failed to start Chrome: Chrome started but debugging interface is not accessible after 7.5 seconds"
        );
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to start Chrome: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

// Tool: Query network traffic
server.tool(
  "query-network-traffic",
  "Query network requests by URL pattern or time range from the active Chrome debugging session. Pages take a few seconds to load, so wait a few seconds before querying.",
  {
    urlFilter: z
      .string()
      .optional()
      .describe("URL pattern to filter requests (supports wildcards)"),
    method: z
      .string()
      .optional()
      .describe("HTTP method filter (GET, POST, etc.)"),
    statusCode: z.number().optional().describe("HTTP status code filter"),
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Maximum number of requests to return"),
  },
  async ({ urlFilter, method, statusCode, limit }) => {
    try {
      const chromeStatus = await isChromeAccessible();
      if (!chromeStatus.accessible) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Chrome debug instance is not running. Please start Chrome with the 'start-chrome-debug' tool first.",
            },
          ],
        };
      }

      // Connect to Chrome DevTools Protocol
      if (!cdpClient) {
        const targets = await CDP.List({ port: 9222 });
        const pageTarget =
          targets.find((target: any) => target.type === "page") || targets[0];

        if (!pageTarget) {
          return {
            content: [
              {
                type: "text",
                text: "Error: No page targets available in Chrome debug session.",
              },
            ],
          };
        }

        cdpClient = await CDP({ target: pageTarget.webSocketDebuggerUrl });

        // Enable Network domain and start collecting requests
        await cdpClient.Network.enable();

        cdpClient.Network.requestWillBeSent(
          ({ requestId, request, timestamp }: any) => {
            networkRequests.set(requestId, {
              requestId,
              url: request.url,
              method: request.method,
              headers: request.headers,
              postData: request.postData,
              timestamp,
              type: "request",
            });
          }
        );

        cdpClient.Network.responseReceived(
          ({ requestId, response, timestamp }: any) => {
            const existing = networkRequests.get(requestId) || {};
            networkRequests.set(requestId, {
              ...existing,
              requestId,
              response: {
                url: response.url,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                mimeType: response.mimeType,
              },
              responseTimestamp: timestamp,
            });
          }
        );
      }

      // Filter requests based on criteria
      const requests = Array.from(networkRequests.values());
      let filteredRequests = requests;

      if (urlFilter) {
        const pattern = new RegExp(urlFilter.replace(/\*/g, ".*"), "i");
        filteredRequests = filteredRequests.filter((req) =>
          pattern.test(req.url)
        );
      }

      if (method) {
        filteredRequests = filteredRequests.filter(
          (req) => req.method?.toLowerCase() === method.toLowerCase()
        );
      }

      if (statusCode) {
        filteredRequests = filteredRequests.filter(
          (req) => req.response?.status === statusCode
        );
      }

      // Sort by timestamp and limit results
      filteredRequests = filteredRequests
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, limit);

      // Format as compressed markdown
      const formatMarkdown = (requests: any[]) => {
        if (requests.length === 0) {
          return "## No network requests found";
        }

        let markdown = `## Network Traffic (${requests.length} requests)\n\n`;

        // Group by domain
        const domains = new Map<string, any[]>();
        requests.forEach((req) => {
          try {
            const domain = new URL(req.url).hostname;
            if (!domains.has(domain)) {
              domains.set(domain, []);
            }
            domains.get(domain)!.push(req);
          } catch {
            // Fallback for invalid URLs
            if (!domains.has("invalid-url")) {
              domains.set("invalid-url", []);
            }
            domains.get("invalid-url")!.push(req);
          }
        });

        // Sort domains by request count
        const sortedDomains = Array.from(domains.entries()).sort(
          (a, b) => b[1].length - a[1].length
        );

        for (const [domain, domainRequests] of sortedDomains) {
          markdown += `${domain} (${domainRequests.length}):\n`;

          domainRequests.forEach((req) => {
            const status = req.response?.status || "⏳";
            const method = req.method || "GET";
            const path = req.url.replace(/^https?:\/\/[^\/]+/, "") || "/";

            markdown += `${method} ${status} ${path} [${req.requestId}]\n`;
          });

          markdown += "\n";
        }

        return markdown;
      };

      return {
        content: [
          {
            type: "text",
            text: formatMarkdown(filteredRequests),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error querying network traffic: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

// Tool: Get detailed network request information
server.tool(
  "get-network-details",
  "Get detailed information about a specific network request including headers, payload, and response body",
  {
    requestId: z.string().describe("The request ID to get details for"),
    includeHeaders: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include request and response headers in the output"),
  },
  async ({ requestId, includeHeaders }) => {
    try {
      const chromeStatus = await isChromeAccessible();
      if (!chromeStatus.accessible) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Chrome debug instance is not running. Please start Chrome with the 'start-chrome-debug' tool first.",
            },
          ],
        };
      }

      if (!cdpClient) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No active CDP connection. Please run 'query-network-traffic' first to establish connection.",
            },
          ],
        };
      }

      const request = networkRequests.get(requestId);
      if (!request) {
        return {
          content: [
            {
              type: "text",
              text: `Error: No request found with ID: ${requestId}`,
            },
          ],
        };
      }

      let responseBody = null;
      let postData = null;

      try {
        // Get response body
        const bodyResult = await cdpClient.Network.getResponseBody({
          requestId,
        });
        responseBody = {
          body: bodyResult.body,
          base64Encoded: bodyResult.base64Encoded,
        };
      } catch (error) {
        responseBody = { error: "Could not retrieve response body" };
      }

      try {
        // Get request post data if available
        if (request.postData) {
          postData = request.postData;
        } else if (
          request.method === "POST" ||
          request.method === "PUT" ||
          request.method === "PATCH"
        ) {
          const postDataResult = await cdpClient.Network.getRequestPostData({
            requestId,
          });
          postData = postDataResult.postData;
        }
      } catch (error) {
        // Post data not available
      }

      const details = {
        requestId,
        url: request.url,
        method: request.method,
        timestamp: new Date(request.timestamp || 0).toISOString(),
        requestHeaders: request.headers,
        postData,
        response: request.response,
        responseBody,
      };

      // Format as compressed markdown
      const formatDetails = (details: any) => {
        let md = `## ${details.method} ${details.url}\n\n`;
        md += `Status: ${details.response?.status || "pending"}\n\n`;

        if (
          includeHeaders &&
          details.requestHeaders &&
          Object.keys(details.requestHeaders).length > 0
        ) {
          md += `### Request Headers:\n`;
          Object.entries(details.requestHeaders).forEach(([key, value]) => {
            md += `${key}: ${value}\n`;
          });
          md += `\n`;
        }

        if (details.postData) {
          md += `### Request Body:\n\`\`\`\n${details.postData}\n\`\`\`\n\n`;
        }

        if (
          includeHeaders &&
          details.response?.headers &&
          Object.keys(details.response.headers).length > 0
        ) {
          md += `### Response Headers:\n`;
          Object.entries(details.response.headers).forEach(([key, value]) => {
            md += `${key}: ${value}\n`;
          });
          md += `\n`;
        }

        if (details.responseBody?.body) {
          md += `### Response Body:\n\`\`\`\n${details.responseBody.body}\n\`\`\`\n`;
        }

        return md;
      };

      return {
        content: [
          {
            type: "text",
            text: formatDetails(details),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error getting network details: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

// Tool: Open URL in Chrome debug browser
server.tool(
  "open-url",
  "Open a specific URL in the Chrome debug browser window and wait for network traffic to settle",
  {
    url: z.string().describe("The URL to navigate to"),
  },
  async ({ url }) => {
    try {
      const chromeStatus = await isChromeAccessible();
      if (!chromeStatus.accessible) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Chrome debug instance is not running. Please start Chrome with the 'start-chrome-debug' tool first.",
            },
          ],
        };
      }

      const targets = await CDP.List({ port: 9222 });
      const pageTarget =
        targets.find((target: any) => target.type === "page") || targets[0];

      if (!pageTarget) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No page targets available in Chrome debug session.",
            },
          ],
        };
      }

      // Initialize global CDP client if needed or if connection is closed
      if (!cdpClient || cdpClient._ws?.readyState !== 1) {
        if (cdpClient) {
          try {
            await cdpClient.close();
          } catch {
            // Ignore close errors
          }
          cdpClient = null;
        }
        
        cdpClient = await CDP({ target: pageTarget.webSocketDebuggerUrl });
        await cdpClient.Page.enable();
        await cdpClient.Network.enable();

        // Set up persistent network request tracking
        cdpClient.Network.requestWillBeSent(
          ({ requestId, request, timestamp }: any) => {
            const reqData = {
              requestId,
              url: request.url,
              method: request.method,
              headers: request.headers,
              postData: request.postData,
              timestamp,
              type: "request",
            };
            networkRequests.set(requestId, reqData);
          }
        );

        cdpClient.Network.responseReceived(
          ({ requestId, response, timestamp }: any) => {
            const existing = networkRequests.get(requestId) || {};
            const updatedReq = {
              ...existing,
              requestId,
              response: {
                url: response.url,
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
                mimeType: response.mimeType,
              },
              responseTimestamp: timestamp,
            };
            networkRequests.set(requestId, updatedReq);
          }
        );
      }

      // Track network requests for this specific page load
      const pageLoadRequests = new Map<string, any>();
      let lastNetworkActivity = Date.now();

      // Temporary handlers for this page load to track activity
      const tempRequestHandler = ({ requestId, request, timestamp }: any) => {
        lastNetworkActivity = Date.now();
        const reqData = {
          requestId,
          url: request.url,
          method: request.method,
          headers: request.headers,
          postData: request.postData,
          timestamp,
          type: "request",
        };
        pageLoadRequests.set(requestId, reqData);
      };

      const tempResponseHandler = ({ requestId, response, timestamp }: any) => {
        lastNetworkActivity = Date.now();
        const existing = pageLoadRequests.get(requestId) || {};
        const updatedReq = {
          ...existing,
          requestId,
          response: {
            url: response.url,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            mimeType: response.mimeType,
          },
          responseTimestamp: timestamp,
        };
        pageLoadRequests.set(requestId, updatedReq);
      };

      // Add temporary listeners for page load tracking
      cdpClient.Network.requestWillBeSent(tempRequestHandler);
      cdpClient.Network.responseReceived(tempResponseHandler);

      // Navigate to the URL
      await cdpClient.Page.navigate({ url });

      // Wait for network traffic to settle (1 second of no activity)
      const waitForNetworkSettle = async (): Promise<void> => {
        return new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            const timeSinceLastActivity = Date.now() - lastNetworkActivity;
            if (timeSinceLastActivity >= 1000) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 100);
        });
      };

      await waitForNetworkSettle();

      // Remove temporary event listeners (keep global ones active)
      cdpClient.Network.requestWillBeSent(() => {});
      cdpClient.Network.responseReceived(() => {});

      // Analyze network requests
      const requests = Array.from(pageLoadRequests.values());
      const totalRequests = requests.length;
      
      // Get the domain from the target URL
      const targetDomain = new URL(url).hostname;
      
      // Find API requests (requests to the same domain that aren't for HTML/CSS/JS/images)
      const apiRequests = requests.filter((req) => {
        try {
          const reqDomain = new URL(req.url).hostname;
          const isTargetDomain = reqDomain === targetDomain;
          const mimeType = req.response?.mimeType || '';
          const isApiRequest = !mimeType.includes('text/html') && 
                              !mimeType.includes('text/css') && 
                              !mimeType.includes('javascript') && 
                              !mimeType.includes('image/') &&
                              !req.url.endsWith('.css') &&
                              !req.url.endsWith('.js') &&
                              !req.url.match(/\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf)$/i);
          return isTargetDomain && isApiRequest;
        } catch {
          return false;
        }
      });

      // Format API request details
      const apiRequestDetails = apiRequests.map(req => {
        const method = req.method || 'GET';
        const uri = req.url;
        const requestId = req.requestId;
        const status = req.response?.status || 'pending';
        return `  ${method} ${status} ${uri} [${requestId}]`;
      }).join('\n');

      return {
        content: [
          {
            type: "text",
            text: `Successfully loaded page: ${url}

Network Traffic Summary:
- Total network requests: ${totalRequests}

API Requests (same domain):
${apiRequestDetails || '  None'}

Page loaded and network traffic settled after 1 second of inactivity.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error opening URL: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

// Start the server
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Browser Tools MCP Server running...");
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

main().catch(console.error);
