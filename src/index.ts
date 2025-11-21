/// <reference types="@fastly/js-compute" />
import { env } from "fastly:env";
import { includeBytes } from "fastly:experimental";
import { type Element, HTMLRewritingStream } from "fastly:html-rewriter";
import { Liquid } from 'liquidjs'

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

function monitorStream(stream: ReadableStream, onDone: () => void) {
    const reader = stream.getReader();
    return new ReadableStream({
        async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
                onDone();
                controller.close();
                return;
            }
            controller.enqueue(value);
        },
    });
}

const engine = new Liquid();

// Added helper
function logPerf(perf: Record<string, number>) {
    Object.entries(perf).forEach(([k, v]) => {
        console.log(`[perf] ${k}: ${Number.isFinite(v) ? v.toFixed(2) : v}${k.toLowerCase().includes("links") ? "" : "ms"}`);
    });
}

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
    const t0 = performance.now();
    const perf: Record<string, number> = {}; // central perf collection

    let req = event.request;
    if (!["HEAD", "GET", "PURGE"].includes(req.method)) {
        perf["Total time since start"] = performance.now() - t0;
        return new Response("This method is not allowed", { status: 405 });
    }

    let url = new URL(req.url);
    const queryParams = getQueryParams(req);

    if (
        !url.pathname.startsWith("/favicon") &&
        !url.pathname.startsWith("/assets") &&
        !url.pathname.startsWith("/.11ty") &&
        !url.pathname.startsWith("/bundle") &&
        !url.pathname.startsWith("/site.webmanifest") &&
        !url.pathname.startsWith("/.well-known")
    ) {
        const t1 = performance.now();
        const request = new Request(BASE_URL + url.pathname + "?" + Date.now().toString(), {
            backend: BACKEND,
            headers: { ["ngrok-skip-browser-warning"]: 'any_value' }
        });
        request.setCacheOverride({ mode: "pass" });
        let response = await fetch(request);
        perf["Backend fetch"] = performance.now() - t1;

        const dummyApiCallStart = performance.now();
        await fetch(new Request("https://5qrxlg.api.jb3.pw.adn-test.cloud/hc"))
        perf["Delivery API fetch"] = performance.now() - dummyApiCallStart;

        const n = Number.parseInt(queryParams['numberOfBasicTemplates'] as string ?? '1', 10);

        const tempParseStart = performance.now();
        let templatesWithNoExtracts: any[] = [];
        for (let i = 0; i < n; i++) {
            templatesWithNoExtracts.push(engine.parse(EXAMPLE_TEMPLATE_NO_EXTRACTS));
        }
        perf[`Parse ${n} basic templates`] = performance.now() - tempParseStart;

        const tempParseExtractTemplate = performance.now();
        const tpl2 = engine.parse(INSERT_VARIABLE_TEMPLATE)
        perf["Parse extract template (a single template)"] = performance.now() - tempParseExtractTemplate;

        let renderedBasicTemplates: string[] = [];

        const pageState = { description: "" }
        let titleSeen = false;
        const linkStats = { linksModified: 0, linksAlreadySuffixed: 0 };

        if (response.ok && response.body) {
            const [body1, body2] = response.body.tee();

            const extracts = (queryParams['extracts'] as string ?? "").split(",").map(s => s.trim())
            const extractValues = extracts.reduce((acc, curr) => ({ ...acc, [curr]: "" }), {})

            // Capture stream
            const captureState: Record<string, { capturing: boolean; buffer: string }> = {};
            extracts.forEach(e => (captureState[e] = { capturing: false, buffer: "" }));
            const decoder = new TextDecoder();

            const captureStream = new TransformStream({
                transform(chunk, controller) {
                    let text = decoder.decode(chunk);
                    for (const extract of extracts) {
                        if (!extract) continue;
                        const startMarker = `__EXTRACT_START__${extract}`;
                        const endMarker = `__EXTRACT_END__${extract}`;
                        let state = captureState[extract];
                        while (text.length) {
                            if (!state.capturing) {
                                const sIdx = text.indexOf(startMarker);
                                if (sIdx === -1) break;
                                text = text.slice(sIdx + startMarker.length);
                                state.capturing = true;
                            }
                            const eIdx = text.indexOf(endMarker);
                            if (eIdx === -1) {
                                state.buffer += text;
                                text = "";
                            } else {
                                state.buffer += text.slice(0, eIdx);
                                extractValues[extract] = state.buffer;
                                state.capturing = false;
                                state.buffer = "";
                                text = text.slice(eIdx + endMarker.length);
                                continue;
                            }
                        }
                    }
                    controller.enqueue(chunk);
                },
                flush() {
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
                if (!selector) return;
                extractorStreamer.onElement(selector, (el: Element) => {
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
                    if (linkStats.linksModified >= Number.parseInt(queryParams['maxLinksUpdated'] as string)) return
                    const now = performance.now();
                    if (!firstRewriteTime) firstRewriteTime = now;
                    const href = el.getAttribute("href");
                    if (!href) return;
                    const raw = href.trim()
                    if (raw.endsWith("#link")) {
                        linkStats.linksAlreadySuffixed++;
                        return
                    }
                    linkStats.linksModified++;
                    el.setAttribute("href", raw + "#link");
                    el.append(`&nbsp<strong>Link updated number: ${linkStats.linksModified - 1}</strong>`, { escapeHTML: false });
                    lastRewriteTime = performance.now();
                })
                .onElement("body", async (el: Element) => {
                    const now = performance.now();
                    if (!firstRewriteTime) firstRewriteTime = now;
                    renderedBasicTemplates.forEach((renderedBasicTemplate) => {
                        el.append(renderedBasicTemplate, { escapeHTML: false });
                    })
                    lastRewriteTime = performance.now();
                });

            let renderedExtractTemplates: string[] = [];

            const t2 = performance.now();
            await body1.pipeThrough(extractorStreamer).pipeThrough(captureStream).pipeTo(new WritableStream());
            perf["Extraction pass"] = performance.now() - t2;

            const tempRenderStart2 = performance.now();
            renderedBasicTemplates = await Promise.all(
                templatesWithNoExtracts.map((template) =>
                    engine.render(template, {
                        people: ["alice", "bob", "carol"]
                    })
                )
            );
            // console.log("Rendered basic templates count:", templatesWithNoExtracts[0]);
            perf["Render basic templates"] = performance.now() - tempRenderStart2;

            const tempRenderStart3 = performance.now();
            renderedExtractTemplates = await Promise.all(
                extracts.map((extract) =>
                    engine.render(tpl2, {
                        introBody: extractValues[extract] || ""
                    })
                )
            );
            perf["Render extract templates"] = performance.now() - tempRenderStart3;

            extracts.forEach((extract, index) => {
                if (!extract) return;
                rewritingStreamer.onElement(extract, (el: Element) => {
                    const now = performance.now();
                    if (!firstRewriteTime) firstRewriteTime = now;
                    el.replaceChildren(renderedExtractTemplates[index], { escapeHTML: false });
                    lastRewriteTime = performance.now();
                })
            });

            const t3 = performance.now();
            function metricsFragment(obj: Record<string, number>): string {
                return `<div id="perf-metrics" style="position: absolute;right:0;top:0;background:#fff;z-index:1000;border:2px solid black;padding:10px;">${Object.entries(obj).map(([k, v]) =>
                    `<p><strong>${escapeHtml(k)}</strong>: ${Number.isFinite(v) ? v.toFixed(5) : v}${k.toLowerCase().includes("links") ? "" : "ms"}</p>`).join("")}</div>`;
            }

            let rewriteFinished = false;

            const monitoredBody = monitorStream(
                body2.pipeThrough(rewritingStreamer),
                () => {
                    rewriteFinished = true;
                    perf["Rewrite stream finished"] = performance.now() - t3;
                    perf["Granular rewrite duration"] = (lastRewriteTime && firstRewriteTime) ? (lastRewriteTime - firstRewriteTime) : 0;
                    perf["Links modified"] = linkStats.linksModified;
                    perf["Total time since start"] = performance.now() - t0;
                }
            );

            // Append metrics after original HTML stream ends
            const appendPerfStream = new TransformStream({
                transform(chunk, controller) {
                    controller.enqueue(chunk);
                },
                flush(controller) {
                    if (!rewriteFinished) {
                        // ensure metrics populated even if onDone somehow not fired yet
                        perf["Rewrite stream finished"] = performance.now() - t3;
                        perf["Granular rewrite duration"] = (lastRewriteTime && firstRewriteTime) ? (lastRewriteTime - firstRewriteTime) : 0;
                        perf["Links modified"] = linkStats.linksModified;
                        perf["Total time since start"] = performance.now() - t0;
                    }
                    const fragment = metricsFragment(perf);
                    controller.enqueue(new TextEncoder().encode(fragment));
                }
            });

            const finalBody = monitoredBody.pipeThrough(appendPerfStream);
            logPerf(perf)

            return new Response(finalBody, {
                status: 200,
                headers: response.headers
            });
        } else {
            perf["Total time since start"] = performance.now() - t0;
            return new Response("Error fetching from backend", { status: 404 });
        }
    }
    // perf["Total time since start"] = performance.now() - t0;

    return new Response(req.url, {
        status: 308,
        headers: {
            Location: BASE_URL + url.pathname
        },
    });
}