// Front door for the tinker hub: tinker.<you>.workers.dev/<path> -> <origin>/hub/<path>.
// Only /hub/* on the phone is reachable through it. Forwards the real visitor IP for rate limits
// and login lockouts, and strips a bot-trap link the origin zone injects (it names the origin).
const ORIGIN = "__ORIGIN__";   // filled in by render-worker.sh; kept out of the public repo

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const upstreamUrl = `https://${ORIGIN}/hub${url.pathname}${url.search}`;
    const upstream = new Request(upstreamUrl, request);
    upstream.headers.set("X-Visitor-IP", request.headers.get("CF-Connecting-IP") || "unknown");
    const resp = await fetch(upstream, { redirect: "manual" });

    const headers = new Headers(resp.headers);
    const location = headers.get("location");
    if (location) headers.set("location", location.replaceAll(`https://${ORIGIN}/hub`, "").replaceAll(ORIGIN, url.host));
    const out = new Response(resp.body, { status: resp.status, headers });
    if (!(headers.get("content-type") || "").includes("text/html")) return out;
    return new HTMLRewriter().on(`a[href*="${ORIGIN}"]`, { element: (el) => el.remove() }).transform(out);
  },
};
