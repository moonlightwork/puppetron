const fs = require("fs");
const http = require("http");
const { URL } = require("url");
const { DEBUG, HEADFUL, CHROME_BIN, PORT } = process.env;

const puppeteer = require("puppeteer");
const jimp = require("jimp");
const pTimeout = require("p-timeout");
const LRU = require("lru-cache");
const cache = LRU({
  max: process.env.CACHE_SIZE || Infinity,
  maxAge: 1000 * 60, // 1 minute
  noDisposeOnSet: true,
  dispose: async (url, page) => {
    try {
      if (page && page.close) {
        console.log("🗑 Disposing " + url);
        page.removeAllListeners();
        await page.deleteCookie(await page.cookies());
        await page.close();
      }
    } catch (e) {}
  }
});
setInterval(() => cache.prune(), 1000 * 60); // Prune every minute

const blocked = require("./blocked.json");
const blockedRegExp = new RegExp("(" + blocked.join("|") + ")", "i");

const truncate = (str, len) =>
  str.length > len ? str.slice(0, len) + "…" : str;

let browser;

require("http")
  .createServer(async (req, res) => {
    const { host } = req.headers;

    if (req.url == "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public,max-age=31536000"
      });
      res.end(fs.readFileSync("index.html"));
      return;
    }

    if (req.url == "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url == "/status") {
      res.writeHead(200, {
        "content-type": "application/json"
      });
      res.end(
        JSON.stringify(
          {
            pages: cache.keys(),
            process: {
              versions: process.versions,
              memoryUsage: process.memoryUsage()
            }
          },
          null,
          "\t"
        )
      );
      return;
    }

    const [_, action, url] = req.url.match(
      /^\/(screenshot|render|pdf)?\/?(.*)/i
    ) || ["", "", ""];

    if (!url) {
      res.writeHead(400, {
        "content-type": "text/plain"
      });
      res.end("Something is wrong. Missing URL.");
      return;
    }

    /*
  if (cache.itemCount > 20){
    res.writeHead(420, {
      'content-type': 'text/plain',
    });
    res.end(`There are ${cache.itemCount} pages in the current instance now. Please try again in few minutes.`);
    return;
  }
  */

    let page, pageURL;
    try {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("Invalid URL");
      }

      const { origin, hostname, pathname, searchParams } = new URL(url);
      const path = decodeURIComponent(pathname);

      await new Promise((resolve, reject) => {
        const req = http.request(
          {
            method: "HEAD",
            host: hostname,
            path
          },
          ({ statusCode, headers }) => {
            if (
              !headers ||
              (statusCode == 200 &&
                !/text\/html/i.test(headers["content-type"]))
            ) {
              reject(new Error("Not a HTML page"));
            } else {
              resolve();
            }
          }
        );
        req.on("error", reject);
        req.end();
      });

      pageURL = origin + path;
      let actionDone = false;
      const width = parseInt(searchParams.get("width"), 10) || 1024;
      const height = parseInt(searchParams.get("height"), 10) || 768;

      page = cache.get(pageURL);
      if (!page) {
        if (!browser) {
          console.log("🚀 Launch browser!");
          const config = {
            ignoreHTTPSErrors: true,
            args: [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
              "--enable-features=NetworkService",
              "-—disable-dev-tools"
            ],
            devtools: false
          };
          if (DEBUG) config.dumpio = true;
          if (HEADFUL) {
            config.headless = false;
            config.args.push("--auto-open-devtools-for-tabs");
          }
          if (CHROME_BIN) config.executablePath = CHROME_BIN;
          browser = await puppeteer.launch(config);
        }
        page = await browser.newPage();

        const nowTime = +new Date();
        let reqCount = 0;
        await page.setRequestInterception(true);
        page.on("request", request => {
          const url = request.url();
          const method = request.method();
          const resourceType = request.resourceType();

          // Skip data URIs
          if (/^data:/i.test(url)) {
            request.continue();
            return;
          }

          const seconds = (+new Date() - nowTime) / 1000;
          const shortURL = truncate(url, 70);
          const otherResources = /^(manifest)$/i.test(resourceType);
          // Abort requests that exceeds 15 seconds
          // Also abort if more than 100 requests
          if (seconds > 15 || reqCount > 100 || actionDone) {
            console.log(`❌⏳ ${method} ${shortURL}`);
            request.abort();
          } else if (blockedRegExp.test(url)) {
            console.log(`❌🛑 ${method} ${shortURL}`);
            request.abort();
          } else if (otherResources) {
            console.log(`❌other ${method} ${shortURL} ${resourceType}`);
            request.abort();
          } else {
            console.log(`✅ ${method} ${shortURL}`);
            request.continue();
            reqCount++;
          }
        });

        let responseReject;
        const responsePromise = new Promise((_, reject) => {
          responseReject = reject;
        });
        page.on("response", ({ headers }) => {
          const location = headers["location"];
          if (location && location.includes(host)) {
            responseReject(new Error("Possible infinite redirects detected."));
          }
        });

        await page.setViewport({
          width,
          height
        });

        console.log("⬇️ Fetching " + pageURL);
        await Promise.race([
          responsePromise,
          page.goto(pageURL, {
            waitUntil: "networkidle0"
          })
        ]);

        // Pause all media and stop buffering
        page.frames().forEach(frame => {
          frame.evaluate(() => {
            document.querySelectorAll("video, audio").forEach(m => {
              if (!m) return;
              if (m.pause) m.pause();
              m.preload = "none";
            });
          });
        });
      } else {
        await page.setViewport({
          width,
          height
        });
      }

      console.log("💥 Perform action: " + action);

      switch (action) {
        case "render": {
          const raw = searchParams.get("raw") || false;

          let content = await pTimeout(
            raw
              ? page.content()
              : page.evaluate(() => {
                  let content = "";
                  if (document.doctype) {
                    content = new XMLSerializer().serializeToString(
                      document.doctype
                    );
                  }

                  const doc = document.documentElement.cloneNode(true);

                  /*
          // Remove scripts except JSON-LD
          const scripts = doc.querySelectorAll('script:not([type="application/ld+json"])');
          scripts.forEach(s => s.parentNode.removeChild(s));

          // Remove import tags
          const imports = doc.querySelectorAll('link[rel=import]');
          imports.forEach(i => i.parentNode.removeChild(i));
          */

                  const { origin, pathname } = location;
                  // Inject <base> for loading relative resources
                  if (!doc.querySelector("base")) {
                    const base = document.createElement("base");
                    base.href = origin + pathname;
                    doc.querySelector("head").appendChild(base);
                  }

                  // Try to fix absolute paths
                  const absEls = doc.querySelectorAll(
                    'link[href^="/"], script[src^="/"], img[src^="/"]'
                  );
                  absEls.forEach(el => {
                    const href = el.getAttribute("href");
                    const src = el.getAttribute("src");
                    if (src && /^\/[^/]/i.test(src)) {
                      el.src = origin + src;
                    } else if (href && /^\/[^/]/i.test(href)) {
                      el.href = origin + href;
                    }
                  });

                  content += doc.outerHTML;

                  // Remove comments
                  content = content.replace(/<!--[\s\S]*?-->/g, "");

                  return content;
                }),
            10 * 1000,
            "Render timed out"
          );

          // moonlight internal stuff
          content = content
            .split("http://sitemirror-local")
            .join("http://www.moonlight.local");
          content = content
            .split("http://sitemirror-prod")
            .join("https://www.moonlightwork.com");
          content = content
            .split("http://sitemirror-namespace")
            .join("https://mnlt.dev");

          res.writeHead(200, {
            "content-type": "text/html; charset=UTF-8",
            "cache-control": "public,max-age=31536000"
          });
          res.end(content);
          break;
        }
        case "pdf": {
          const format = searchParams.get("format") || null;
          const pageRanges = searchParams.get("pageRanges") || null;

          const pdf = await pTimeout(
            page.pdf({
              format,
              pageRanges
            }),
            10 * 1000,
            "PDF timed out"
          );

          res.writeHead(200, {
            "content-type": "application/pdf",
            "cache-control": "public,max-age=31536000"
          });
          res.end(pdf, "binary");
          break;
        }
        default: {
          const thumbWidth =
            parseInt(searchParams.get("thumbWidth"), 10) || null;
          const fullPage = searchParams.get("fullPage") == "true" || false;
          const clipSelector = searchParams.get("clipSelector");

          let screenshot;
          if (clipSelector) {
            const handle = await page.$(clipSelector);
            if (handle) {
              screenshot = await pTimeout(
                handle.screenshot({
                  type: "jpeg"
                }),
                20 * 1000,
                "Screenshot timed out"
              );
            }
          } else {
            screenshot = await pTimeout(
              page.screenshot({
                type: "jpeg",
                fullPage
              }),
              20 * 1000,
              "Screenshot timed out"
            );
          }

          res.writeHead(200, {
            "content-type": "image/jpeg",
            "cache-control": "public,max-age=31536000"
          });

          if (thumbWidth && thumbWidth < width) {
            const image = await jimp.read(screenshot);
            image
              .resize(thumbWidth, jimp.AUTO)
              .quality(90)
              .getBuffer(jimp.MIME_JPEG, (err, buffer) => {
                res.end(buffer, "binary");
              });
          } else {
            res.end(screenshot, "binary");
          }
        }
      }

      actionDone = true;
      console.log("💥 Done action: " + action);
      if (!cache.has(pageURL)) {
        // cache.set(pageURL, page);

        // Try to stop all execution
        page.frames().forEach(frame => {
          frame.evaluate(() => {
            // Clear all timer intervals https://stackoverflow.com/a/6843415/20838
            for (var i = 1; i < 99999; i++) window.clearInterval(i);
            // Disable all XHR requests
            XMLHttpRequest.prototype.send = _ => _;
            // Disable all RAFs
            requestAnimationFrame = _ => _;
          });
        });
      }
    } catch (e) {
      if (!DEBUG && page) {
        console.error(e);
        console.log("💔 Force close " + pageURL);
        page.removeAllListeners();
        try {
          browser.close();
          browser = null;
          page.close();
        } catch (err) {
          res.writeHead(500, {
            "content-type": "text/plain"
          });
          res.end("Oops. Something is wrong.\n\n" + err);
          console.warn(`Chrome could not be killed ${err.message}`);
          process.exit(1);
        }
      }
      cache.del(pageURL);
      const { message = "" } = e;
      res.writeHead(400, {
        "content-type": "text/plain"
      });
      res.end("Oops. Something is wrong.\n\n" + message);

      // Handle websocket not opened error
      if (/not opened/i.test(message) && browser) {
        console.error("🕸 Web socket failed");
        try {
          browser.close();
          browser = null;
        } catch (err) {
          console.warn(`Chrome could not be killed ${err.message}`);
          browser = null;
        }
      }
    }
  })
  .listen(PORT || 3000);

process.on("SIGINT", () => {
  if (browser) browser.close();
  process.exit();
});

process.on("unhandledRejection", (reason, p) => {
  console.log("Unhandled Rejection at:", p, "reason:", reason);
});
