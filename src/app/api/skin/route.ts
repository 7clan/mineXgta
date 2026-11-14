import { NextRequest, NextResponse } from "next/server";

/**
 * Project Hyperion — server-side TLauncher skin proxy.
 *
 * Reverse-engineered TLauncher skin service contract:
 *   profile:  https://auth.tlauncher.org/skin/profile/texture/login/<NAME>
 *             -> { "SKIN": { "url": "<file url>", "metadata": { "model": "slim"|"classic" } } }
 *   skin file: http://auth.tlauncher.org/skin/fileservice/skins/skin_<NAME>.png
 *
 * The browser cannot call these directly: auth.tlauncher.org sends no CORS
 * headers and the skin file itself is served over plain HTTP (mixed content
 * on an HTTPS site). Fetching server-side here solves both, and the returned
 * PNG is base64-embedded so the client gets a data URL in a single request.
 *
 * The proxy is locked down: only the profile endpoint is queried, and the
 * file we follow must live on a *.tlauncher.org host — it can never become
 * an open SSRF relay.
 */

const PROFILE = "https://auth.tlauncher.org/skin/profile/texture/login/";

export async function GET(request: NextRequest) {
  const name = (request.nextUrl.searchParams.get("name") ?? "").trim();
  // TLauncher nicknames: letters, digits, underscore, dash, dot — bounded length.
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name)) {
    return NextResponse.json({ error: "Invalid nickname." }, { status: 400 });
  }

  try {
    const profileRes = await fetch(PROFILE + encodeURIComponent(name), {
      headers: { "User-Agent": "mineXgta-hyperion/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!profileRes.ok) {
      return NextResponse.json(
        { error: `No TLauncher profile for "${name}" (HTTP ${profileRes.status}).` },
        { status: 404 },
      );
    }

    const profile = (await profileRes.json()) as {
      SKIN?: { url?: string; metadata?: { model?: string } };
    };
    const fileUrl = profile?.SKIN?.url;
    if (!fileUrl) {
      return NextResponse.json({ error: "That profile has no skin set." }, { status: 404 });
    }

    // SSRF guard: only follow TLauncher-hosted files.
    const parsed = new URL(fileUrl);
    if (!/(^|\.)tlauncher\.org$/.test(parsed.hostname.toLowerCase())) {
      return NextResponse.json({ error: "Skin file host not allowed." }, { status: 502 });
    }

    const skinRes = await fetch(parsed.toString(), {
      headers: { "User-Agent": "mineXgta-hyperion/1.0" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!skinRes.ok || !skinRes.body) {
      return NextResponse.json({ error: "Skin download failed on the TLauncher side." }, { status: 502 });
    }

    const buf = Buffer.from(await skinRes.arrayBuffer());
    const pngMagic = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!pngMagic) {
      return NextResponse.json({ error: "TLauncher returned a file that is not a PNG skin." }, { status: 502 });
    }

    const model = profile.SKIN?.metadata?.model === "slim" ? "slim" : "classic";
    return NextResponse.json(
      { model, png: `data:image/png;base64,${buf.toString("base64")}` },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `TLauncher skin service unreachable (${msg}).` }, { status: 504 });
  }
}
