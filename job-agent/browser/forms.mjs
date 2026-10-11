// Generic application-form engine used by every site module.
// collect() labels every visible field, resolveFields() asks the agent's memory for answers,
// fill() types/selects/uploads them. Unknown required fields stop the run so the owner can be asked.

const AGENT = `${process.env.AGENT_URL || 'http://127.0.0.1:8083'}/internal/resolve`;

// Runs in the page: tag each visible field with data-ja-key and describe it.
function describeFields(rootSel) {
  const root = rootSel ? document.querySelector(rootSel) : document;
  if (!root) return [];
  const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  // Styled radios/checkboxes hide the real input behind their label: visible if the label is.
  const visible = (el) => el.type === 'file' || shown(el)
    || ((el.type === 'radio' || el.type === 'checkbox') && [...(el.labels || []), el.closest('label')].some(shown));
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\*/g, '').trim();
  const labelOf = (el) => {
    if (el.type === 'radio' || el.type === 'checkbox') {
      // Smallest box around this one option (contains no other option): its text is the option's name.
      let box = el.parentElement;
      while (box && box.parentElement && box.parentElement.querySelectorAll('input[type="radio"], input[type="checkbox"]').length === 1) box = box.parentElement;
      const t = clean(box?.innerText || box?.textContent);
      if (t && t.length < 120) return t;
    }
    if (el.id) { const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`); const t = clean(l?.innerText || l?.textContent); if (t) return t; }
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(' ').map((id) => document.getElementById(id)?.innerText).filter(Boolean).join(' '); if (t) return clean(t); }
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    const wrap = el.closest('label'); if (wrap && clean(wrap.innerText || wrap.textContent)) return clean(wrap.innerText || wrap.textContent);
    const fs = el.closest('fieldset'); if (fs?.querySelector('legend')) return clean(fs.querySelector('legend').innerText);
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const l = p.querySelector('label, legend, .label, [class*="label"], [class*="question"]');
      if (l && !l.contains(el) && clean(l.innerText)) return clean(l.innerText);
    }
    return clean(el.placeholder || el.name || el.id);
  };
  // Text just before an element (question heading above an option list), up to 3 levels up.
  const textBefore = (n) => { for (let k = 0; n && k < 3; k++, n = n.parentElement) {
    for (let p = n.previousElementSibling; p; p = p.previousElementSibling) { const t = clean(p.innerText); if (t && t.length > 2) return t; } } return ''; };
  const fields = [];
  const groups = new Map();
  const pfx = Math.random().toString(36).slice(2, 6);   // keys stay unique across repeated collect() passes
  let n = 0;
  for (const el of root.querySelectorAll('input, select, textarea, [role="combobox"]')) {
    if (el.dataset.jaKey || !visible(el) || el.disabled || el.readOnly && el.getAttribute('role') !== 'combobox') continue;
    const t = (el.getAttribute('role') === 'combobox' && el.tagName !== 'SELECT') ? 'combobox' : (el.type || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(t)) continue;
    const required = el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(el.closest('div, fieldset')?.querySelector('label, legend')?.innerText || '');
    if (t === 'radio' || t === 'checkbox') {
      // The question's container: nearest fieldset/group, else the nearest ancestor holding 2+ options of this type.
      let fs = el.closest('fieldset, [role="radiogroup"], [role="group"]');
      if (!fs) { let a = el.parentElement; while (a && a !== root && a.querySelectorAll(`input[type="${t}"]`).length < 2) a = a.parentElement; fs = a && a !== root ? a : null; }
      const opts = fs ? [...fs.querySelectorAll(`input[type="${t}"]`)].map(labelOf) : [];
      // Question text = the container's first text that isn't one of its options.
      const lead = fs ? [...fs.querySelectorAll('legend, label, span, p, div, h3, h4')].map((n) => clean(n.childElementCount ? n.firstChild?.textContent : n.innerText))
        .find((x) => x && x.length > 2 && !opts.includes(x)) : '';
      const groupLabel = clean(fs?.querySelector('legend')?.innerText) || lead || textBefore(fs || el) || labelOf(fs || el);
      const gname = t === 'radio' && el.name ? `r:${el.name}` : `${t}:${groupLabel || el.name || el.closest('fieldset')?.id || ''}`;
      const optLabel = labelOf(el);
      if (!groups.has(gname)) {
        const key = `f${pfx}${n++}`; groups.set(gname, key);
        fields.push({ key, label: t === 'checkbox' && !fs ? optLabel : groupLabel, type: t, options: [],
          required: required || /\*/.test(fs?.innerText?.split('\n')[0] || '') || fs?.getAttribute('aria-required') === 'true' });
      }
      const key = groups.get(gname);
      el.dataset.jaKey = key;
      el.dataset.jaOpt = optLabel;
      fields.find((f) => f.key === key).options.push(optLabel);
      continue;
    }
    const key = `f${pfx}${n++}`;
    el.dataset.jaKey = key;
    const f = { key, label: labelOf(el), type: t === 'select-one' ? 'select' : t, required, value: el.value || '' };
    if (el.tagName === 'SELECT') f.options = [...el.options].map((o) => clean(o.text)).filter((o) => o && !/^(select|choose|--)/i.test(o));
    if (t === 'file') f.accept = el.accept || '';
    fields.push(f);
  }
  return fields;
}

export async function collect(page, rootSel = null) {
  const fields = await page.evaluate(describeFields, rootSel);
  // React comboboxes: open each to read its options.
  for (const f of fields.filter((x) => x.type === 'combobox')) {
    const el = page.locator(`[data-ja-key="${f.key}"]`);
    try {
      await el.click({ timeout: 3000 });
      await page.waitForTimeout(400);
      // Only this combobox's open listbox (other widgets keep hidden option lists in the DOM).
      const owned = await el.getAttribute('aria-controls') || await el.getAttribute('aria-owns');
      const opts = owned ? page.locator(`[id="${owned}"] [role="option"]`) : page.locator('[role="option"]:visible');
      f.options = (await opts.allInnerTexts()).map((s) => s.trim()).filter(Boolean).slice(0, 400);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } catch { f.options = []; }
    if (!f.options.length) f.type = 'text';
  }
  return fields;
}

const isResume = (f) => f.type === 'file' && /resume|cv|curriculum/i.test(`${f.label} ${f.accept}`) || (f.type === 'file' && !/cover/i.test(f.label));
const isCover = (f) => f.type === 'file' && /cover/i.test(f.label);
const filled = (f) => f.value && !['checkbox', 'radio', 'file'].includes(f.type) && !/^(select|choose)/i.test(f.value);

/** Ask the agent for answers. Returns {answers, unknown}; resume/cover-letter files are handled locally. */
export async function resolveFields(fields, job) {
  const ask = fields.filter((f) => f.type !== 'file' && !filled(f));
  if (!ask.length) return { answers: {}, unknown: [] };
  const r = await fetch(AGENT, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: job.id, context: `${job.title} at ${job.company}`, fields: ask }) });
  if (r.status === 503) { const e = new Error('AI busy, retry later'); e.retryLater = true; throw e; }
  if (!r.ok) throw new Error(`agent resolve ${r.status}`);
  return r.json();
}

export async function fill(page, fields, answers, { resume } = {}) {
  page.setDefaultTimeout(6000);
  for (const f of fields) {
    let el = page.locator(`[data-ja-key="${f.key}"]`);
    // React forms re-render and drop our marker: fall back to the field's visible label (a text box first:
    // "Phone" can also match the country-code picker next to it).
    if (!await el.count() && f.label) {
      const name = f.label.slice(0, 80);
      el = page.getByRole('textbox', { name, exact: false }).first();
      if (!await el.count()) el = page.getByLabel(name, { exact: false }).first();
    }
    try {
      if (isResume(f) && resume) { await el.first().setInputFiles(resume); await page.waitForTimeout(1500); continue; }
      if (isCover(f)) continue;
      const v = answers[f.key];
      if (v == null || v === '') continue;
      if (f.type === 'select') { await el.selectOption({ label: v }).catch(() => el.selectOption(v)); }
      else if (f.type === 'combobox') {
        await el.click(); await el.fill(String(v)).catch(() => page.keyboard.type(String(v)));
        await page.waitForTimeout(600);
        const opt = page.locator('[role="option"]', { hasText: String(v) }).first();
        if (await opt.count()) await opt.click(); else await page.keyboard.press('Enter');
      } else if (f.type === 'radio') {
        const marked = page.locator(`[data-ja-key="${f.key}"][data-ja-opt="${String(v).replace(/"/g, '\\"')}"]`).first();
        if (await marked.count()) {
          await marked.evaluate((e) => (e.labels?.[0] || e.closest('label') || e).click());
          if (!await marked.isChecked().catch(() => true)) await marked.check({ force: true }).catch(() => {});
        }
        else {                                    // re-rendered custom radios: pick the option by its visible text
          const byRole = page.getByRole('radio', { name: String(v), exact: true }).first();
          if (await byRole.count()) await byRole.check({ force: true });
          else await page.getByText(String(v), { exact: true }).first().click();
        }
      } else if (f.type === 'checkbox') {
        const wanted = String(v).split(/\s*[;|]\s*/);
        const tick = async (loc) => { if (await loc.isChecked().catch(() => false)) return;
          await loc.evaluate((e) => (e.labels?.[0] || e.closest('label') || e).click()).catch(() => {});
          if (!await loc.isChecked().catch(() => true)) await loc.check({ force: true }).catch(() => {}); };
        if (f.options.length === 1) { if (/^(yes|true|agree|i agree|acknowledge)/i.test(v)) await tick(el.first()); }
        else for (const w of wanted) await tick(page.locator(`[data-ja-key="${f.key}"][data-ja-opt="${w.replace(/"/g, '\\"')}"]`).first());
      } else if (f.type === 'date') {
        const dt = new Date(/^\w+ \d{4}$/.test(String(v)) ? `1 ${v}` : String(v));
        await el.fill(Number.isNaN(+dt) ? String(v) : dt.toISOString().slice(0, 10));
      } else {
        const isPicker = /location|city|address|town|where.*based|college|school|university/i.test(f.label);
        try {
          if (isPicker) { await el.fill(''); await el.pressSequentially(String(v), { delay: 70 }); }   // key by key: pickers only suggest on keystrokes
          else await el.fill(String(v));
        } catch (e) {
          // Looks like a field but is a custom dropdown ("How did you hear…"): open it and pick the option by text.
          if (!/not an <input>|not editable/i.test(e.message)) throw e;
          await el.click({ timeout: 5000 });
          await page.waitForTimeout(600);
          const opt = page.getByRole('option', { name: String(v), exact: false }).first();
          if (await opt.count()) await opt.click(); else await page.getByText(String(v), { exact: false }).first().click({ timeout: 4000 });
          continue;
        }
        // Autocomplete fields (city/location pickers): a suggestion must be chosen or the site treats it as empty.
        if (isPicker) {
          await page.waitForTimeout(2000);
          const opts = page.locator('[role="option"]:visible, .pac-item:visible, li[class*="suggestion"]:visible, li[class*="option"]:visible');
          if (await opts.count()) {
            const want = String(v).split(',')[0].trim().toLowerCase();
            const all = await opts.allInnerTexts();
            const i = Math.max(0, all.findIndex((t) => t.toLowerCase().includes(want)));
            await opts.nth(i).click().catch(() => {});
          }                                                 // (never press Enter here: it can submit the form early)
        }
      }
    } catch (e) { console.error(`fill ${f.key} "${f.label}": ${e.message}`); }
  }
}

export async function captchaVisible(page) {
  for (const fr of page.frames()) {
    if (/hcaptcha\.com\/.*(challenge|checkbox)|recaptcha\/api2\/(bframe|anchor)|challenges\.cloudflare\.com/.test(fr.url())) {
      const box = await fr.frameElement().then((h) => h.boundingBox()).catch(() => null);
      if (box && box.width > 50 && box.height > 50) return true;
    }
  }
  return false;
}

/** Shared flow for one-page forms: collect -> resolve -> (stop if unknown) -> fill -> optional submit. */
export async function fillForm(page, job, { root = null, resume, dryRun, partial = false }) {
  let fields = await collect(page, root);
  if (fields.length < 3 && root) fields = [...fields, ...await collect(page, null)];   // root matched the wrong form: whole page
  const { answers, unknown } = await resolveFields(fields, job);
  // Consent boxes are often not marked required but block submission: never submit with one unanswered.
  const blocking = unknown.filter((u) => u.required || /agree|acknowledg|consent|terms|privacy|certify/i.test(u.label));
  const filled = fields.filter((f) => answers[f.key] != null).map((f) => ({ label: f.label, value: String(answers[f.key]) }));
  if (blocking.length && !partial) return { status: 'needs_answer', unknown: blocking, fields: fields.length, filled };
  await fill(page, fields, answers, { resume });                 // partial (owner handoff): fill all we know anyway
  if (blocking.length) return { status: 'needs_answer', unknown: blocking, fields: fields.length, filled };
  return { status: dryRun ? 'dry_run' : 'filled', fields: fields.length, unknown, filled };
}
