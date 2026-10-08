// Renders a tailored resume as one-page HTML in the style of the owner's LaTeX resume (Jake's template).
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function resumeHtml(r) {
  const c = r.contact;
  const link = (t) => `<a href="https://${esc(t)}">${esc(t)}</a>`;
  const bullets = (bs) => `<ul>${bs.map((b) => `<li>${esc(b.text)}</li>`).join('')}</ul>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.name)} — Resume</title><style>
@page { size: Letter; margin: 0.45in 0.5in; }
* { box-sizing: border-box; }
body { margin: 0; font: 10.4pt/1.28 "Latin Modern Roman", "CMU Serif", "Liberation Serif", "Times New Roman", serif; color: #000; }
a { color: inherit; }
h1 { font-size: 24pt; text-align: center; margin: 0 0 2pt; font-weight: 700; letter-spacing: .2pt; }
.contact { text-align: center; font-size: 9.6pt; margin-bottom: 4pt; }
.contact a { text-decoration: underline; }
.summary { margin: 4pt 0 0; text-align: center; font-style: italic; }
h2 { font-variant: small-caps; font-weight: 400; font-size: 12.5pt; border-bottom: .6pt solid #000;
     margin: 9pt 0 3pt; padding-bottom: 1pt; letter-spacing: .3pt; }
.row { display: flex; justify-content: space-between; gap: 12pt; }
.row > :last-child { white-space: nowrap; }
.row > :first-child { min-width: 0; }
.item { margin: 0 0 4pt 6pt; }
.item b { font-weight: 700; }
.sub { font-style: italic; font-size: 9.8pt; }
ul { margin: 1pt 0 2pt; padding-left: 20pt; }
li { margin: 0 0 1.2pt; font-size: 9.8pt; }
.skills { margin-left: 6pt; font-size: 9.8pt; }
.skills div { margin-bottom: 1pt; }
</style></head><body>
<h1>${esc(r.name)}</h1>
<div class="contact">${esc(c.phone)} | <a href="mailto:${esc(c.email)}">${esc(c.email)}</a> | ${link(c.linkedin)} | ${link(c.github)}</div>
${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ''}

<h2>Experience</h2>
${r.experience.map((e, i) => {
  const sameOrg = i > 0 && r.experience[i - 1].org === e.org;
  return `<div class="item">
    ${sameOrg
      ? `<div class="row sub"><span>${esc(e.title)}</span><span>${esc(e.dates)}</span></div>`
      : `<div class="row"><b>${esc(e.title)}</b><span>${esc(e.dates)}</span></div>
         <div class="row sub"><span>${esc(e.org)}</span><span>${esc(e.place)}</span></div>`}
    ${bullets(e.bullets)}</div>`;
}).join('')}

<h2>Projects</h2>
${r.projects.map((p) => `<div class="item">
  <div class="row"><span><b>${esc(p.name)}</b> | <i>${esc(p.stack)}</i></span>${p.link ? `<span>${link(p.link)}</span>` : ''}</div>
  ${bullets(p.bullets)}</div>`).join('')}

<h2>Education</h2>
${r.education.map((e) => `<div class="item">
  <div class="row"><b>${esc(e.school)}</b><span>${esc(e.place)}</span></div>
  <div class="row sub"><span>${esc(e.degree)}</span><span>${esc(e.dates)}</span></div></div>`).join('')}

<h2>Technical Skills</h2>
<div class="skills">${Object.entries(r.skills).map(([k, v]) => `<div><b>${esc(k)}</b>: ${esc(v.join(', '))}</div>`).join('')}</div>
</body></html>`;
}
