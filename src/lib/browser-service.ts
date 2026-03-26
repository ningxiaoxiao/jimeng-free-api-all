import { chromium, Browser, BrowserContext, Page } from "playwright-core";
import logger from "@/lib/logger.ts";
import { getCookiesForBrowser } from "@/api/controllers/core.ts";

// bdms SDK 相关脚本的白名单域名
const SCRIPT_WHITELIST_DOMAINS = [
  "vlabstatic.com",
  "bytescm.com",
  "jianying.com",
  "byteimg.com",
];

// 需要屏蔽的资源类型（加速加载、减少内存）
const BLOCKED_RESOURCE_TYPES = ["image", "font", "stylesheet", "media"];

// 会话空闲超时时间（毫秒）
const SESSION_IDLE_TIMEOUT = 10 * 60 * 1000;

// bdms SDK 就绪等待超时（毫秒）
const BDMS_READY_TIMEOUT = 30000;

// 浏览器内 fetch 超时（毫秒）
const PAGE_FETCH_TIMEOUT = 45000;

// 对“页面/上下文/浏览器已关闭”类错误做一次透明重试
const MAX_RECOVERABLE_RETRIES = 1;

interface BrowserSession {
  id: number;
  context: BrowserContext;
  page: Page;
  lastUsed: number;
  idleTimer: NodeJS.Timeout | null;
  inFlightRequests: number;
  requestQueue: Promise<void>;
}

class BrowserService {
  private browser: Browser | null = null;
  private sessions: Map<string, BrowserSession> = new Map();
  private launching: Promise<Browser> | null = null;
  private sessionCreations: Map<string, Promise<BrowserSession>> = new Map();
  private nextSessionId = 1;

  private getTokenLabel(token: string) {
    return `${token.substring(0, 8)}...`;
  }

  private isBrowserConnected(browser: Browser | null = this.browser) {
    return !!browser?.isConnected();
  }

  private clearIdleTimer(session: BrowserSession) {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  private armIdleTimer(token: string, session: BrowserSession) {
    this.clearIdleTimer(session);
    if (session.inFlightRequests > 0) return;

    session.idleTimer = setTimeout(() => {
      void this.closeSession(token, "idle_timeout", session);
    }, SESSION_IDLE_TIMEOUT);
  }

  private isSessionUsable(session: BrowserSession) {
    return this.isBrowserConnected(session.context.browser()) && !session.page.isClosed();
  }

  private isRecoverableBrowserError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /Target page, context or browser has been closed|Target closed|Browser has been closed|Page closed|page has been closed|Execution context was destroyed|navigation.*page was closed|crash|browser disconnected/i
      .test(message);
  }

  private async runInSessionQueue<T>(session: BrowserSession, task: () => Promise<T>): Promise<T> {
    const previous = session.requestQueue.catch(() => undefined);
    let release!: () => void;
    session.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await task();
    } finally {
      release();
    }
  }

  private handleBrowserDisconnected() {
    logger.warn("BrowserService: 浏览器已断开连接");
    this.browser = null;

    for (const session of this.sessions.values()) {
      this.clearIdleTimer(session);
    }

    this.sessions.clear();
    this.sessionCreations.clear();
  }

  /**
   * 懒启动浏览器实例
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.isBrowserConnected()) {
      return this.browser as Browser;
    }

    // 防止并发启动
    if (this.launching) {
      return this.launching;
    }

    this.launching = (async () => {
      logger.info("BrowserService: 正在启动 Chromium 浏览器...");
      try {
        const browser = await chromium.launch({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-first-run",
          ],
        });

        browser.on("disconnected", () => {
          this.handleBrowserDisconnected();
        });

        this.browser = browser;
        logger.info("BrowserService: Chromium 浏览器启动成功");
        return browser;
      } finally {
        this.launching = null;
      }
    })();

    return this.launching;
  }

  /**
   * 获取或创建指定 token 的浏览器会话
   */
  private async getSession(token: string): Promise<BrowserSession> {
    const existing = this.sessions.get(token);
    if (existing && this.isSessionUsable(existing)) {
      existing.lastUsed = Date.now();
      this.armIdleTimer(token, existing);
      return existing;
    }

    if (existing) {
      logger.warn(`BrowserService: 检测到失效会话 ${this.getTokenLabel(token)}，准备重建`);
      await this.closeSession(token, "stale_session", existing, true);
    }

    const creating = this.sessionCreations.get(token);
    if (creating) {
      return creating;
    }

    const creationPromise = this.createSession(token);
    this.sessionCreations.set(token, creationPromise);

    try {
      return await creationPromise;
    } finally {
      if (this.sessionCreations.get(token) === creationPromise) {
        this.sessionCreations.delete(token);
      }
    }
  }

  /**
   * 创建新的浏览器会话
   */
  private async createSession(token: string): Promise<BrowserSession> {
    const browser = await this.ensureBrowser();

    logger.info(`BrowserService: 为 token ${this.getTokenLabel(token)} 创建新会话`);

    let context: BrowserContext | null = null;

    try {
      context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
        viewport: { width: 1920, height: 1080 },
        locale: "zh-CN",
      });

      // 注入 cookies
      const cookies = getCookiesForBrowser(token);
      await context.addCookies(cookies);

      // 配置资源拦截
      await context.route("**/*", (route) => {
        const request = route.request();
        const resourceType = request.resourceType();
        const url = request.url();

        // 屏蔽不需要的资源类型
        if (BLOCKED_RESOURCE_TYPES.includes(resourceType)) {
          return route.abort();
        }

        // 对于脚本资源，只允许白名单域名
        if (resourceType === "script") {
          const isWhitelisted = SCRIPT_WHITELIST_DOMAINS.some((domain) =>
            url.includes(domain)
          );
          if (!isWhitelisted) {
            return route.abort();
          }
        }

        return route.continue();
      });

      const page = await context.newPage();
      page.on("close", () => {
        logger.warn(`BrowserService: 会话页面已关闭 ${this.getTokenLabel(token)}`);
      });
      page.on("crash", () => {
        logger.error(`BrowserService: 会话页面已崩溃 ${this.getTokenLabel(token)}`);
      });

      // 导航到即梦页面，让 bdms SDK 加载
      logger.info("BrowserService: 正在导航到 jimeng.jianying.com ...");
      await page.goto("https://jimeng.jianying.com", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // 等待 bdms SDK 就绪
      logger.info("BrowserService: 等待 bdms SDK 就绪...");
      try {
        await page.waitForFunction(
          () => {
            // bdms SDK 会替换 window.fetch，检测其是否被替换
            return (
              (window as any).bdms?.init ||
              (window as any).byted_acrawler ||
              window.fetch.toString().indexOf("native code") === -1
            );
          },
          { timeout: BDMS_READY_TIMEOUT }
        );
        logger.info("BrowserService: bdms SDK 已就绪");
      } catch (error) {
        if (this.isRecoverableBrowserError(error)) {
          throw error;
        }
        logger.warn("BrowserService: bdms SDK 等待超时，可能未完全加载，继续尝试...");
      }

      const session: BrowserSession = {
        id: this.nextSessionId++,
        context,
        page,
        lastUsed: Date.now(),
        idleTimer: null,
        inFlightRequests: 0,
        requestQueue: Promise.resolve(),
      };

      this.sessions.set(token, session);
      this.armIdleTimer(token, session);
      return session;
    } catch (error) {
      if (context) {
        try {
          await context.close();
        } catch {
          // 忽略关闭错误
        }
      }
      throw error;
    }
  }

  /**
   * 关闭指定 token 的会话
   */
  private async closeSession(
    token: string,
    reason = "manual",
    expectedSession?: BrowserSession,
    force = false
  ) {
    const currentSession = this.sessions.get(token);
    const session = expectedSession || currentSession;
    if (!session) return;

    if (!force && session.inFlightRequests > 0) {
      logger.info(
        `BrowserService: 会话 ${this.getTokenLabel(token)} 仍有 ${session.inFlightRequests} 个请求，延后关闭`
      );
      this.armIdleTimer(token, session);
      return;
    }

    this.clearIdleTimer(session);

    if (currentSession === session) {
      this.sessions.delete(token);
    }

    logger.info(`BrowserService: 关闭会话 ${this.getTokenLabel(token)}，原因: ${reason}`);

    try {
      await session.context.close();
    } catch {
      // 忽略关闭错误
    }
  }

  private async executePageFetch(
    session: BrowserSession,
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
  ) {
    return session.page.evaluate(
      async ({ url: fetchUrl, options: fetchOptions, timeoutMs }) => {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => {
          controller.abort(new Error(`fetch timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        try {
          const res = await fetch(fetchUrl, {
            method: fetchOptions.method || "GET",
            headers: {
              "Content-Type": "application/json",
              ...(fetchOptions.headers || {}),
            },
            body: fetchOptions.body,
            credentials: "include",
            signal: controller.signal,
          });
          const text = await res.text();
          return { ok: res.ok, status: res.status, text };
        } catch (err: any) {
          return { ok: false, status: 0, text: "", error: err?.message || String(err) };
        } finally {
          window.clearTimeout(timeoutId);
        }
      },
      { url, options, timeoutMs: PAGE_FETCH_TIMEOUT }
    );
  }

  private async fetchWithRetry(
    token: string,
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string },
    attempt = 0
  ): Promise<any> {
    const session = await this.getSession(token);

    try {
      return await this.runInSessionQueue(session, async () => {
        if (!this.isSessionUsable(session)) {
          throw new Error("浏览器会话已失效");
        }

        session.inFlightRequests += 1;
        session.lastUsed = Date.now();
        this.clearIdleTimer(session);

        try {
          const result = await this.executePageFetch(session, url, options);

          if (result.error) {
            throw new Error(`浏览器 fetch 失败: ${result.error}`);
          }

          logger.info(`BrowserService: 响应状态 ${result.status}`);

          try {
            return JSON.parse(result.text);
          } catch {
            logger.warn(`BrowserService: 响应不是有效 JSON: ${result.text.substring(0, 200)}`);
            return result.text;
          }
        } finally {
          session.inFlightRequests = Math.max(0, session.inFlightRequests - 1);
          session.lastUsed = Date.now();

          if (this.sessions.get(token) === session && this.isSessionUsable(session)) {
            this.armIdleTimer(token, session);
          }
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recoverable = this.isRecoverableBrowserError(error);

      logger.error(`BrowserService: 请求执行失败: ${message}`);
      await this.closeSession(
        token,
        recoverable ? "recoverable_request_failure" : "request_failure",
        session,
        true
      );

      if (recoverable && attempt < MAX_RECOVERABLE_RETRIES) {
        logger.warn(`BrowserService: 会话 ${this.getTokenLabel(token)} 已自动重建，准备重试请求`);
        return this.fetchWithRetry(token, url, options, attempt + 1);
      }

      throw error;
    }
  }

  /**
   * 通过浏览器代理发送 fetch 请求
   * bdms SDK 会自动拦截 fetch 并注入 a_bogus 签名
   *
   * @param token sessionid
   * @param url 完整的请求 URL
   * @param options fetch 选项 (method, headers, body)
   * @returns 解析后的 JSON 响应
   */
  async fetch(
    token: string,
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<any> {
    logger.info(`BrowserService: 代理请求 ${options.method || "GET"} ${url.substring(0, 100)}...`);
    return this.fetchWithRetry(token, url, options);
  }

  /**
   * 健康检查：验证浏览器是否在线，断开则自动重启
   * 该方法是安全的，失败时不会抛出异常
   */
  async healthCheck(): Promise<{
    connected: boolean;
    sessionsCount: number;
    restarted: boolean;
    error?: string;
  }> {
    const wasConnected = this.isBrowserConnected();
    const sessionsCount = this.sessions.size;

    if (wasConnected) {
      logger.info(`BrowserService: 健康检查通过，浏览器在线，活跃会话数: ${sessionsCount}`);
      return { connected: true, sessionsCount, restarted: false };
    }

    // 浏览器不在线，尝试重启
    logger.warn("BrowserService: 健康检查发现浏览器离线，正在尝试重启...");
    try {
      await this.ensureBrowser();
      logger.info("BrowserService: 浏览器重启成功");
      return { connected: true, sessionsCount: 0, restarted: true };
    } catch (err) {
      logger.error(`BrowserService: 浏览器重启失败: ${(err as Error).message}`);
      return {
        connected: false,
        sessionsCount: 0,
        restarted: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * 关闭所有会话和浏览器实例
   */
  async close() {
    logger.info("BrowserService: 正在关闭所有会话和浏览器...");

    for (const [token, session] of [...this.sessions.entries()]) {
      await this.closeSession(token, "service_shutdown", session, true);
    }

    this.sessionCreations.clear();

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // 忽略关闭错误
      }
      this.browser = null;
    }

    logger.info("BrowserService: 已关闭");
  }
}

// 单例导出
const browserService = new BrowserService();
export default browserService;
