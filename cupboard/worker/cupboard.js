// Front door for Cupboard: cupboard.<you>.workers.dev/<path> -> <origin>/cupboard/<path>. Only /cupboard/* on the
// phone is reachable through it. Forwards the visitor IP for rate limits and login lockouts, streams responses
// (live chat updates), and strips a bot-trap link the origin zone injects (it names the origin).
const ORIGIN = "__ORIGIN__";   // filled in by render-worker.sh; kept out of the public repo

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const upstream = new Request(`https://${ORIGIN}/cupboard${url.pathname}${url.search}`, request);
    upstream.headers.set("X-Visitor-IP", request.headers.get("CF-Connecting-IP") || "unknown");
    const resp = await fetch(upstream, { redirect: "manual" });
    const headers = new Headers(resp.headers);
    const location = headers.get("location");
    if (location) headers.set("location", location.replaceAll(`https://${ORIGIN}/cupboard`, "").replaceAll(ORIGIN, url.host));
    const out = new Response(resp.body, { status: resp.status, headers });
    if (!(headers.get("content-type") || "").includes("text/html")) return out;
    return new HTMLRewriter().on(`a[href*="${ORIGIN}"]`, { element: (el) => el.remove() }).transform(out);
  },
};
