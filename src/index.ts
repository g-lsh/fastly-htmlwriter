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
function logPerf(perf: Record<string, number | string>) {
    Object.entries(perf).forEach(([k, v]) => {
        console.log(`[perf] ${k}: ${Number.isFinite(v) || typeof v !== 'string' ? (v as number).toFixed(2) : v}${k.toLowerCase().includes("links") ? "" : "ms"}`);
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

// In `src/index.ts` replace the metricsFragment function with this version.
function metricsFragment(obj: Record<string, number | string>): string {
    // Preserve insertion order of groups
    const groups: Record<string, { label: string; value: number | string }[]> = {};
    const groupOrder: string[] = [];

    Object.entries(obj).forEach(([rawKey, v]) => {
        const m = rawKey.match(/^\[([^\]]+)\]\s*(.*)$/);
        const group = m ? m[1] : "Ungrouped";
        const label = m ? m[2] : rawKey;
        if (!groups[group]) {
            groups[group] = [];
            groupOrder.push(group);
        }
        groups[group].push({ label, value: v });
    });

    const esc = (s: string) =>
        s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

    const groupHtml = groupOrder
        .map((g, idx) => {
            const measures = groups[g]
                .map(({ label, value }) => {
                    const needsUnit = !/\blinks\b|\bchunk\b|\bhtml\b/i.test(label);
                    const formatted =
                        (Number.isFinite(value) && typeof value !== "string")
                            ? (value as number).toFixed(3) + (needsUnit ? " ms" : "")
                            : value;
                    return `<p><strong>${esc(label)}</strong>: ${formatted}</p>`;
                })
                .join("");
            const separator = idx === 0
                ? ""
                : `<div style="margin:12px 0;border-top:1px solid #444;"></div>`;
            // Optional group header; keep the bracket style for clarity
            return `${separator}<div class="perf-group"><h4 style="margin:4px 0 8px 0;font:14px sans-serif;">${esc(g)}</h4>${measures}</div>`;
        })
        .join("");

    return `<div id="perf-metrics" style="position:absolute;right:0;top:0;background:#fff;z-index:1000;border:2px solid #000;padding:10px;overflow:auto;width:700px">${groupHtml}</div>`;
}

const BASE_URL = "https://remunerative-euhemeristically-liane.ngrok-free.dev"
const BACKEND = "pageworkers-ngrok"

async function handleRequest(event: FetchEvent) {
    const t0 = performance.now();
    const perf: Record<string, number|string> = {}; // central perf collection

    let req = event.request;
    if (!["HEAD", "GET", "PURGE"].includes(req.method)) {
        perf["[TOTAL] Total time since start"] = performance.now() - t0;
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
        perf["[NETWORK] Backend fetch"] = performance.now() - t1;

        const dummyApiCallStart = performance.now();
        await fetch(new Request("https://5qrxlg.api.jb3.pw.adn-test.cloud/hc"), { backend: "dapi" });
        perf["[NETWORK] Delivery API fetch"] = performance.now() - dummyApiCallStart;

        const n = Number.parseInt(queryParams['numberOfBasicTemplates'] as string ?? '1', 10);
        const tempParseStart = performance.now();
        let templatesWithNoExtracts: any[] = [];
        for (let i = 0; i < n; i++) {
            templatesWithNoExtracts.push(engine.parse(EXAMPLE_TEMPLATE_NO_EXTRACTS));
        }
        perf[`[TEMPLATES] Parse extract templates`] = performance.now() - tempParseStart;

        let renderedBasicTemplates: string[] = [];

        const pageState = { description: "" }
        let titleSeen = false;
        const linkStats = { linksModified: 0, linksAlreadySuffixed: 0 };
        const htmlSizeStats = { total: 0, count: 0, max: 0 };

        if (response.ok && response.body) {
            const [body1, body2] = response.body.tee();

            const extracts = (queryParams['extracts'] as string ?? "").split(",").map(s => s.trim()).filter((s) => s.length > 0);
            const extractValues = extracts.reduce((acc, curr) => ({ ...acc, [curr]: "" }), {})

            const tempParseExtractTemplate = performance.now();
            const tpl2 = extracts.length > 0 ? engine.parse(INSERT_VARIABLE_TEMPLATE): null;
            perf["[TEMPLATES] Parse extract template (a single template)"] = performance.now() - tempParseExtractTemplate;

            // Capture stream
            const captureState: Record<string, { capturing: boolean; buffer: string }> = {};
            extracts.forEach(e => (captureState[e] = { capturing: false, buffer: "" }));
            const decoder = new TextDecoder();

            let firstCaptureTime = 0;
            let lastCaptureTime = 0;
            const captureStream = new TransformStream({
                transform(chunk, controller) {
                    const now = performance.now();
                    if (!firstCaptureTime) firstCaptureTime = now;
                    // Compute size stats
                    const size = chunk.byteLength;
                    htmlSizeStats.total += size;
                    htmlSizeStats.count++;
                    if (size > htmlSizeStats.max) htmlSizeStats.max = size;

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
                    lastCaptureTime = performance.now();
                    controller.enqueue(chunk);
                },
                flush() {
                    perf["[STREAMS] Capture stream estimated CPU time"] = (lastCaptureTime && firstCaptureTime) ? (lastCaptureTime - firstCaptureTime) : 0;
                    for (const extract of extracts) {
                        const st = captureState[extract];
                        if (st.capturing && st.buffer) {
                            extractValues[extract] = st.buffer;
                        }
                    }
                },
            });

            let extractorFirstTime = 0;
            let extractorLastTime = 0;
            let totalHtmlExtracts = 0;
            const extractorStreamer = new HTMLRewritingStream()
                .onElement('meta[name="description"]', (el: Element) => {
                    if(!extractorFirstTime) extractorFirstTime = performance.now();
                    if (!pageState.description) {
                        totalHtmlExtracts++;
                        const content = (el.getAttribute("content") || "").trim();
                        if (content) pageState.description = content;
                    };
                    extractorLastTime = performance.now();
                });

            extracts.forEach((selector) => {
                if (!selector) return;
                extractorStreamer.onElement(selector, (el: Element) => {
                    if(!extractorFirstTime) extractorFirstTime = performance.now();
                    const extractStart = `__EXTRACT_START__${selector}`;
                    const extractEnd = `__EXTRACT_END__${selector}`;
                    el.prepend(extractStart, { escapeHTML: false });
                    el.append(extractEnd, { escapeHTML: false });
                    extractorLastTime = performance.now();
                    totalHtmlExtracts++
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
            perf["[MISC] Total HTML extracts made"] = totalHtmlExtracts;
            perf["[STREAMS] Extraction and capture stream wall time"] = performance.now() - t2;
            perf["[STREAMS] Extractor stream estimated CPU time"] = (extractorLastTime && extractorFirstTime) ? (extractorLastTime - extractorFirstTime) : 0;

            const tempRenderStart2 = performance.now();
            renderedBasicTemplates = await Promise.all(
                templatesWithNoExtracts.map((template) =>
                    engine.render(template, {
                        people: ["alice", "bob", "carol"]
                    })
                )
            );
            perf["[TEMPLATES] Number of no extract templates rendered"] = renderedBasicTemplates.length;
            perf["[TEMPLATES] Render no extract templates"] = performance.now() - tempRenderStart2;

            const tempRenderStart3 = performance.now();
            console.log("EXTRACT VALUES:", extracts);
            renderedExtractTemplates = tpl2 !== null ? await Promise.all(
                extracts.map((extract) =>
                    engine.render(tpl2, {
                        introBody: extractValues[extract] || ""
                    })
                )
            ) : [];
            perf["[MISC] Extracts selector values"] = extracts.join(",")
            perf["[TEMPLATES] Number of extract templates rendered"] = renderedExtractTemplates.length;
            perf["[TEMPLATES] Render extract templates"] = performance.now() - tempRenderStart3;

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
            let rewriteFinished = false;

            const monitoredBody = monitorStream(
                body2.pipeThrough(rewritingStreamer),
                () => {
                    const rewriteSteamCpuTime = (lastRewriteTime && firstRewriteTime) ? (lastRewriteTime - firstRewriteTime) : 0;
                    const totalStreamCpuTime = (perf["[STREAMS] Capture stream estimated CPU time"] as number) + (perf["[STREAMS] Extractor stream estimated CPU time"] as number) + rewriteSteamCpuTime
                    const totalTemplateCpuTime = (perf["[TEMPLATES] Render extract templates"] as number) + (perf["[TEMPLATES] Render no extract templates"] as number) + (perf[`[TEMPLATES] Parse extract templates`] as number) + (perf["[TEMPLATES] Parse extract template (a single template)"] as number);

                    rewriteFinished = true;
                    perf["[STREAMS] Rewrite stream wall time"] = performance.now() - t3;
                    perf["[STREAMS] Rewrite stream estimated CPU time"] = (lastRewriteTime && firstRewriteTime) ? (lastRewriteTime - firstRewriteTime) : 0;
                    perf["[TOTAL] Total templates parsing and rendering estimated CPU time"] = totalTemplateCpuTime
                    perf["[TOTAL] Estimated all stream operations CPU time"] = totalStreamCpuTime
                    perf["[TOTAL] Estimated TOTAL CPU time"] = totalTemplateCpuTime + totalStreamCpuTime
                    perf["[MISC] Links modified"] = linkStats.linksModified;
                    perf["[MISC] Total run time"] = performance.now() - t0;
                    // Populate size metrics
                    perf["[HTML] HTML size in KB"] = htmlSizeStats.total / 1024;
                    perf["[HTML] HTML chunk count"] = htmlSizeStats.count;
                    perf["[HTML] Largest chunk bytes"] = htmlSizeStats.max;
                    perf["[HTML] Average chunk bytes"] = htmlSizeStats.count ? (htmlSizeStats.total / htmlSizeStats.count) : 0;
                    perf["[TOTAL] Total time since start"] = performance.now() - t0;
                }
            );

            // Append metrics after original HTML stream ends
            const appendPerfStream = new TransformStream({
                transform(chunk, controller) {
                    controller.enqueue(chunk);
                },
                flush(controller) {
                    const rewriteSteamCpuTime = (lastRewriteTime && firstRewriteTime) ? (lastRewriteTime - firstRewriteTime) : 0;
                    const totalStreamCpuTime = (perf["[STREAMS] Capture stream estimated CPU time"] as number) + (perf["[STREAMS] Extractor stream estimated CPU time"] as number) + rewriteSteamCpuTime
                    const totalTemplateCpuTime = (perf["[TEMPLATES] Render extract templates"] as number) + (perf["[TEMPLATES] Render no extract templates"] as number) + (perf[`[TEMPLATES] Parse extract templates`] as number) + (perf["[TEMPLATES] Parse extract template (a single template)"] as number);
                    if (!rewriteFinished) {
                        // ensure metrics populated even if onDone somehow not fired yet
                        perf["[STREAMS] Rewrite stream wall time"] = performance.now() - t3;
                        perf["[STREAMS] Rewrite stream estimated CPU time"] = (lastRewriteTime && firstRewriteTime) ? (lastRewriteTime - firstRewriteTime) : 0;
                        perf["[TOTAL] Total templates parsing and rendering estimated CPU time"] = totalTemplateCpuTime
                        perf["[TOTAL] Estimated all stream operations CPU time"] = totalStreamCpuTime
                        perf["[TOTAL] Estimated TOTAL CPU time"] = totalTemplateCpuTime + totalStreamCpuTime
                        perf["[MISC] Links modified"] = linkStats.linksModified;
                        perf["[MISC] Total run time"] = performance.now() - t0;
                        // Populate size metrics
                        perf["[HTML] HTML size in KB"] = htmlSizeStats.total / 1024;
                        perf["[HTML] HTML chunk count"] = htmlSizeStats.count;
                        perf["[HTML] Largest chunk bytes"] = htmlSizeStats.max;
                        perf["[HTML] Average chunk bytes"] = htmlSizeStats.count ? (htmlSizeStats.total / htmlSizeStats.count) : 0;
                        perf["[TOTAL] Total time since start"] = performance.now() - t0;
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