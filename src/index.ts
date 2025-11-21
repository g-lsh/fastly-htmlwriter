//! Default Compute template program.

/// <reference types="@fastly/js-compute" />
// import { CacheOverride } from "fastly:cache-override";
// import { Logger } from "fastly:logger";
import { env } from "fastly:env";
import { includeBytes } from "fastly:experimental";
import {type Element, HTMLRewritingStream} from "fastly:html-rewriter";
import { Liquid } from 'liquidjs'

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

const EXAMPLE_TEMPLATE_NO_EXTRACTS = `<ul>
{%- for person in people %}
  <li>
    <a href="{{person | prepend: "https://example.com/"}}">
      {{ person | capitalize }}
    </a>
  </li>
{%- endfor%}
</ul>
`

const INSERT_VARIABLE_TEMPLATE = `<div class="inserted-variable">
  <p>This is an inserted variable content.</p>
  <p>Description: {{ introBody }}</p>
</div>
`

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

const engine = new Liquid();

function getQueryParams(req: Request): Record<string, string | string[]> {
    const u = new URL(req.url);
    const out: Record<string, string | string[]> = {};
    u.searchParams.forEach((value, key) => {
        if (Object.prototype.hasOwnProperty.call(out, key)) {
            const existing = out[key];
            if (Array.isArray(existing)) {
                existing.push(value);
            } else {
                out[key] = [existing as string, value];
            }
        } else {
            out[key] = value;
        }
    });
    return out;
}

const BASE_URL = "https://remunerative-euhemeristically-liane.ngrok-free.dev"
const BACKEND = "pageworkers-ngrok"

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

  const queryParams = getQueryParams(req);

    // If request is to the `/` path...
  if (!url.pathname.startsWith("/favicon") && !url.pathname.startsWith("/assets") && !url.pathname.startsWith("/.11ty") && !url.pathname.startsWith("/bundle") && !url.pathname.startsWith("/site.webmanifest") && !url.pathname.startsWith("/.well-known")) {
      // Log to a Fastly endpoint.
      // To use this, uncomment the import statement at the top of this file for Logger.
      // const logger = new Logger("my_endpoint");
      // logger.log("Hello from the edge!");
      console.log(`============================================= NEW REQUEST ON ${url.pathname} =============================================`);

      console.log("[htmlrewriter] Starting fetch to backend");
      const t1 = performance.now();
      const request = new Request(BASE_URL + url.pathname + "?" + Date.now().toString(), {
          backend: BACKEND,
          headers: {
              ["ngrok-skip-browser-warning"]: 'any_value'
          }
      });

      request.setCacheOverride({ mode: "pass" });

      let response = await fetch(request);

      console.log("[htmlrewriter] Completed fetch to backend in", performance.now() - t1, "ms");
      console.log("[htmlrewriter] Time since start:", performance.now() - t0, "ms");

      console.log("[htmlrewriter] Starting basic template parsing");
      const tempParseStart = performance.now();
      const n = Number.parseInt(queryParams['numberOfBasicTemplates'] as string ?? '1', 10);
      const templatesWithNoExtracts = Array.from({ length: n }, () => engine.parse(EXAMPLE_TEMPLATE_NO_EXTRACTS));

      console.log(`[htmlrewriter] Completed parsing of ${templatesWithNoExtracts.length} basic templates in: `, performance.now() - tempParseStart, "ms");
      const tpl2 = engine.parse(INSERT_VARIABLE_TEMPLATE)

      // Prepare to hold rendered templates that will be rendered once the extractions are done
      let renderedBasicTemplates = []
      let renderedTemplate2 = '';

      const pageState = {description: ""}
      let titleSeen = false;
      const linkStats = { linksModified: 0, linksAlreadySuffixed: 0 };

      if (response.ok && response.body) {
          // Need to "clone" the body stream for two passes
          const [body1, body2] = response.body.tee();

          const extracts = (queryParams['extracts'] as string ?? "").split(",").map(s => s.trim())
          console.log("[htmlrewriter] Extractors to apply:", extracts);
          const extractValues = extracts.reduce((acc, curr) => ({...acc, [curr]: "" }), {})

          // Prepare per-extract capture state
          const captureState: Record<string, { capturing: boolean; buffer: string }> = {};
          extracts.forEach(e => (captureState[e] = { capturing: false, buffer: "" }));
          const decoder = new TextDecoder();

          const captureStream = new TransformStream({
              transform(chunk, controller) {
                  let text = decoder.decode(chunk);

                  // Process each extract independently
                  for (const extract of extracts) {
                      if (!extract) continue;
                      const startMarker = `__EXTRACT_START__${extract}`;
                      const endMarker = `__EXTRACT_END__${extract}`;
                      let state = captureState[extract];

                      // Loop while there is something to find for this extract in current text
                      while (text.length) {
                          if (!state.capturing) {
                              const sIdx = text.indexOf(startMarker);
                              if (sIdx === -1) break; // no start marker, done for this extract
                              // Begin capture after start marker
                              text = text.slice(sIdx + startMarker.length);
                              state.capturing = true;
                          }
                          // We are capturing
                          const eIdx = text.indexOf(endMarker);
                          if (eIdx === -1) {
                              // No end marker yet, accumulate all and wait for next chunk
                              state.buffer += text;
                              text = ""; // consumed
                          } else {
                              // End marker found; store captured segment
                              state.buffer += text.slice(0, eIdx);
                              extractValues[extract] = state.buffer;
                              // Reset state for potential subsequent occurrences
                              state.capturing = false;
                              state.buffer = "";
                              // Continue scanning after end marker (could be another start)
                              text = text.slice(eIdx + endMarker.length);
                              continue;
                          }
                      }
                  }

                  controller.enqueue(chunk); // pass original bytes downstream
              },
              flush() {
                  // Finalize any unterminated captures
                  for (const extract of extracts) {
                      const st = captureState[extract];
                      if (st.capturing && st.buffer) {
                          extractValues[extract] = st.buffer;
                      }
                  }
              },
          });


          const extractorStreamer = new HTMLRewritingStream()
              .onElement('meta[name="description"]', (el: Element) => {
                  if (pageState.description) return;
                  const content = (el.getAttribute("content") || "").trim();
                  if (content) pageState.description = content;
              });

          extracts.forEach((selector) => {
              if(!selector) return;
              extractorStreamer.onElement(selector, (el: Element) => {
                  const now = performance.now();
                  if (!firstRewriteTime) firstRewriteTime = now;

                  const extractStart = `__EXTRACT_START__${selector}`;
                  const extractEnd = `__EXTRACT_END__${selector}`;

                  el.prepend(extractStart, { escapeHTML: false });
                  el.append(extractEnd, { escapeHTML: false });
              });
          });


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
                  if(linkStats.linksModified >= Number.parseInt(queryParams['maxLinksUpdated'] as string)) return
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
                  el.append(`&nbsp<strong>Link updated number: ${linkStats.linksModified - 1}</strong>`, {escapeHTML: false});
                  lastRewriteTime = performance.now();
              })
              .onElement("body", async (el: Element) => {
                  const now = performance.now();
                  if (!firstRewriteTime) firstRewriteTime = now;
                  renderedBasicTemplates.forEach((renderedBasicTemplate) =>
                  {
                      el.append(renderedBasicTemplate, { escapeHTML: false });
                  })
                  lastRewriteTime = performance.now();
              })

              extracts.forEach((extract, index) => {
                  if(!extract) return;
                  rewritingStreamer.onElement(extract, (el: Element) => {
                      const now = performance.now();
                      if (!firstRewriteTime) firstRewriteTime = now;
                      // NOTE: el.replaceChildren is very sensitive to correct HTML semantics.
                      // For instance, if you attempt to render a div as a child of a p tag, it won't do it.
                      // instead it will empty and close the p tag and insert the new element after it, and adding another empty
                      // p after it.
                      el.replaceChildren(renderedExtractTemplates[index], {escapeHTML: false});
                      lastRewriteTime = performance.now()
                  })
              });

          console.log("[htmlrewriter] Begin extraction pass");
          const t2 = performance.now();
          await body1.pipeThrough(extractorStreamer).pipeThrough(captureStream).pipeTo(new WritableStream()); // drain the stream to trigger processing
          console.log("[htmlrewriter] Completed extraction pass in", performance.now() - t2, "ms");
          console.log("[htmlrewriter] Time since start:", performance.now() - t0, "ms");

          console.log("[htmlrewriter] Begin basic templates rendering");
          const tempRenderStart2 = performance.now();
          renderedBasicTemplates = await Promise.all(templatesWithNoExtracts.map((template) => engine.render(template, {
              "people": [
                  "alice",
                  "bob",
                  "carol"
              ]
          })));
          console.log(`[htmlrewriter] Rendered ${renderedBasicTemplates.length} basic templates in: `, performance.now() - tempRenderStart2, "ms");

          console.log("[htmlrewriter] Begin extract templates rendering");
          const tempRenderStart3 = performance.now();
          // Later when rendering the template that expects introBody (example):
          const renderedExtractTemplates = await Promise.all(extracts.map((extract) => {
                return engine.render(tpl2, {
                    introBody: extractValues[extract] || ""
                });
          }));
          console.log(`[htmlrewriter] Rendered ${renderedExtractTemplates.length} extract template in: `, performance.now() - tempRenderStart3, "ms");

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
            Location: BASE_URL + url.pathname
        },
    });
}
