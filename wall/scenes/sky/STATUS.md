# Sky scene: status

Live (2026-10-19): `index.html` is the dome (zenith in the centre, north up, east left) with stars, constellations,
Sun/Moon/planets (astronomy-engine 2.1.19) and the ISS (satellite.js 5.0.0, TLE from the wall server's `/api/tle`,
CelesTrak cached 12 h, `tle.txt` as fallback). Panel: clock, what's up, sun/moon times and phase, ISS passes for 2 days
("visible" = ISS sunlit and Sun below -6°), on-screen alert 15 min before a visible pass and during it.
URL: `?t=<ISO time>`, `?demo=iss`, `?labels=0`. `home.json` (lat/lon) is private and gitignored.
Ideas not built: `?view=horizon`, `?style=neon`, Cupboard push for visible ISS passes.
