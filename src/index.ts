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

async function handleRequest(event: FetchEvent) {
  // Log service version
  console.log("FASTLY_SERVICE_VERSION:", env('FASTLY_SERVICE_VERSION') || 'local');

  // Get the client request.
  let req = event.request;

  // Filter requests that have unexpected methods.
  if (!["HEAD", "GET", "PURGE"].includes(req.method)) {
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

      // let response = await fetch("https://fr.ulule.com/", {
      //     backend: "ulule",
      // });

      let response = await fetch("http://localhost:8080", {
          backend: "pageworkers-local",
      });

      // let response = await fetch("https://pageworkers-demo.ftl.page", {
      //     backend: "pageworkers-demo",
      //     headers: {
      //         "User-Agent":
      //             "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
      //     },
      // });


      const pageState = {description: ""}
      let titleSeen = false;

      if (response.ok && response.body) {
          // Need to fully buffer the HTML to make two passes
          const html = await response.text();

          const resForPass1 = new Response(html, {
              headers: { "content-type": "text/html; charset=utf-8" }
          })

          console.log("====== HTML =====", html.slice(0, 200));

          let extractorStreamer = new HTMLRewritingStream()
              .onElement('meta[name="description"]', (el: Element) => {
                  if (pageState.description) return;
                  const content = (el.getAttribute("content") || "").trim();
                  if (content) pageState.description = content;
              })
              // .onElement("title", e => {
              //     const content = e.getAttribute("content")
              //     e.prepend("Added title")
              // })
              // .onElement("div", e => {
              //     e.setAttribute("special-attribute", "top-secret")
              // });

          const rewritingStreamer = new HTMLRewritingStream()
              .onElement("title", (el: Element) => {
                  titleSeen = true;
                  if (pageState.description) {
                      el.replaceChildren(pageState.description, { escapeHTML: true });
                  }
              })
              .onElement("head", (el) => {
                  // inject <title> if missing
                  if (pageState.description && !titleSeen) {
                      const safeTitle = escapeHtml(pageState.description);
                      el.append(`<title>${safeTitle}</title>`, { escapeHTML: false });
                      titleSeen = true;
                  }
              })

          await resForPass1.body.pipeThrough(extractorStreamer).pipeTo(new WritableStream()); // drain the stream to trigger processing

          // Now do a new stream for pass 2
          const resForPass2 = new Response(html)

          let body = resForPass2.body.pipeThrough(rewritingStreamer);
          return new Response(body, {
              status: 200,
              headers: response.headers
          });
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
