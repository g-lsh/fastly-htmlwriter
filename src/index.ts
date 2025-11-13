//! Default Compute template program.

/// <reference types="@fastly/js-compute" />
// import { CacheOverride } from "fastly:cache-override";
// import { Logger } from "fastly:logger";
import { env } from "fastly:env";
import { includeBytes } from "fastly:experimental";
import {type Element, HTMLRewritingStream} from "fastly:html-rewriter";

// Load a static file as a Uint8Array at compile time.
// File path is relative to root of project, not to this file
// const welcomePage = includeBytes("./src/welcome-to-compute.html");

// The entry point for your application.
//
// Use this fetch event listener to define your main request handling logic. It
// could be used to route based on the request properties (such as method or
// path), send the request to a backend, make completely new requests, and/or
// generate synthetic responses.

// Utility to escape HTML
const escapeHtml = (s = "") =>
    s.replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );


addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));


function monitorStream(stream, onDone) {
    const reader = stream.getReader();
    return new ReadableStream({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
                onDone();              // <-- fires exactly once when stream closes
                controller.close();
                return;
            }
            controller.enqueue(value);
        },
    });
}


async function handleRequest(event: FetchEvent) {
  // Log service version
  // console.log("FASTLY_SERVICE_VERSION:", env('FASTLY_SERVICE_VERSION') || 'local');
  const t0 = performance.now()

  // Get the client request.
  let req = event.request;

  // Filter requests that have unexpected methods.
  if (!["HEAD", "GET", "PURGE"].includes(req.method)) {
    console.log(`[htmlrewriter] fatal error - total time`, performance.now() - t0, "ms");
    return new Response("This method is not allowed", {
      status: 405,
    });
  }

  let url = new URL(req.url);

  // If request is to the `/` path...
  if (url.pathname == "/") {
      // Below are some common patterns for Fastly Compute services using JavaScript.
      // Head to https://developer.fastly.com/learning/compute/javascript/ to discover more.

      // Create a new request.
      // let bereq = new Request("http://example.com");

      // Add request headers.
      // req.headers.set("X-Custom-Header", "Welcome to Fastly Compute!");
      // req.headers.set(
      //   "X-Another-Custom-Header",
      //   "Recommended reading: https://developer.fastly.com/learning/compute"
      // );

      // Create a cache override.
      // To use this, uncomment the import statement at the top of this file for CacheOverride.
      // let cacheOverride = new CacheOverride("override", { ttl: 60 });

      // Forward the request to a backend.
      // let beresp = await fetch(req, {
      //   backend: "backend_name",
      //   cacheOverride,
      // });

      // Remove response headers.
      // beresp.headers.delete("X-Another-Custom-Header");

      // Log to a Fastly endpoint.
      // To use this, uncomment the import statement at the top of this file for Logger.
      // const logger = new Logger("my_endpoint");
      // logger.log("Hello from the edge!");

      console.log("[htmlrewriter] Starting fetch to backend");
      const t1 = performance.now();
      let response = await fetch("http://localhost:8080", {
          backend: "pageworkers-local",
      });
      console.log("[htmlrewriter] Completed fetch to backend in", performance.now() - t1, "ms");
      console.log("[htmlrewriter] Time since start:", performance.now() - t0, "ms");

      const pageState = {description: ""}
      let titleSeen = false;
      const linkStats = { linksModified: 0, linksAlreadySuffixed: 0 };

      if (response.ok && response.body) {
          // Need to "clone" the body stream for two passes
          const [body1, body2] = response.body.tee();

          let extractorStreamer = new HTMLRewritingStream()
              .onElement('meta[name="description"]', (el: Element) => {
                  if (pageState.description) return;
                  const content = (el.getAttribute("content") || "").trim();
                  if (content) pageState.description = content;
              })


          let firstRewriteTime = 0;
          let lastRewriteTime = 0;
          const rewritingStreamer = new HTMLRewritingStream()
              .onElement("title", (el: Element) => {
                  const now = performance.now();
                  if (!firstRewriteTime) firstRewriteTime = now;
                  titleSeen = true;
                  if (pageState.description) {
                      el.replaceChildren(pageState.description, { escapeHTML: true });
                  }
                  lastRewriteTime = performance.now();
              })
              .onElement("head", (el) => {
                  // inject <title> if missing
                  const now = performance.now();
                  if (!firstRewriteTime) firstRewriteTime = now;
                  if (pageState.description && !titleSeen) {
                      const safeTitle = escapeHtml(pageState.description);
                      el.append(`<title>${safeTitle}</title>`, { escapeHTML: false });
                      titleSeen = true;
                  }
                  lastRewriteTime = performance.now();
              })
              .onElement("a", (el: Element) => {
                  const now = performance.now();
                  if (!firstRewriteTime) firstRewriteTime = now;

                  const href = el.getAttribute("href");
                  if(!href) return;
                  const raw = href.trim()

                  if(raw.endsWith("#link")) {
                      linkStats.linksAlreadySuffixed++;
                      return
                  }
                  linkStats.linksModified++;
                  el.setAttribute("href", raw + "#link");
                  el.replaceChildren("Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.", {escapeHTML: false});
                  lastRewriteTime = performance.now();
              })

          console.log("[htmlrewriter] Begin extraction pass");
          const t2 = performance.now();
          await body1.pipeThrough(extractorStreamer).pipeTo(new WritableStream()); // drain the stream to trigger processing
          console.log("[htmlrewriter] Completed extraction pass in", performance.now() - t2, "ms");
          console.log("[htmlrewriter] Time since start:", performance.now() - t0, "ms");


          // Now do a new stream for writing
          // let body = body2.pipeThrough(rewritingStreamer);
          const t3 = performance.now();
          const monitoredBody = monitorStream(
              body2.pipeThrough(rewritingStreamer),
              () => {
                  console.log("[htmlrewriter] Rewrite stream fully finished in", performance.now() - t3, "ms")
                  console.log("[htmlrewriter] Links modified:", linkStats.linksModified);
                  console.log("[htmlrewriter] Time since start:", performance.now() - t0, "ms");
                  console.log("[htmlrewriter] Time to rewrite as computed by granular timers", lastRewriteTime - firstRewriteTime, "ms after rewrite start");
              }
          );

          const res =  new Response(monitoredBody, {
              status: 200,
              headers: response.headers
          });
          return res
      } else {
          return new Response("Error fetching from backend", {status: 404})
      }
  }
    return new Response(req.url, {
        status: 308,
        headers: {
            Location: "http://localhost:8080" + url.pathname
        },
    });

    // return new Response(req.url, {
    //     status: 308,
    //     headers: {
    //         Location: "https://pageworkers-demo.ftl.page" + url.pathname
    //     },
    // });

    // Send a default synthetic response.
    // return new Response(req.url, {
    //   status: 308,
    //     headers: {
    //         Location: "https://fr.ulule.com" + url.pathname
    //     },
    // });


    // // Catch all other requests and return a 404.
  // return new Response("The page you requested could not be found", {
  //   status: 404,
  // });
}
