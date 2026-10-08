// Generic application-form engine used by every site module.
// collect() labels every visible field, resolveFields() asks the agent's memory for answers,
// fill() types/selects/uploads them. Unknown required fields stop the run so the owner can be asked.

const AGENT = 'http://127.0.0.1:8083/internal/resolve';

// Runs in the page: tag each visible field with data-ja-key and describe it.
function describeFields(rootSel) {
  const root = rootSel ? document.querySelector(rootSel) : document;
  if (!root) return [];
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') || el.type === 'file'; };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\*/g, '').trim();
  const labelOf = (el) => {
    if (el.id) { const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return clean(l.innerText); }
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(' ').map((id) => document.getElementById(id)?.innerText).filter(Boolean).join(' '); if (t) return clean(t); }
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    const wrap = el.closest('label'); if (wrap) return clean(wrap.innerText);
    const fs = el.closest('fieldset'); if (fs?.querySelector('legend')) return clean(fs.querySelector('legend').innerText);
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const l = p.querySelector('label, legend, .label, [class*="label"], [class*="question"]');
      if (l && !l.contains(el) && clean(l.innerText)) return clean(l.innerText);
    }
    return clean(el.placeholder || el.name || el.id);
  };
  const fields = [];
  const groups = new Map();
  let n = 0;
  for (const el of root.querySelectorAll('input, select, textarea, [role="combobox"]')) {
    if (el.dataset.jaKey || !visible(el) || el.disabled || el.readOnly && el.getAttribute('role') !== 'combobox') continue;
    const t = (el.getAttribute('role') === 'combobox' && el.tagName !== 'SELECT') ? 'combobox' : (el.type || el.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(t)) continue;
    const required = el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(el.closest('div, fieldset')?.querySelector('label, legend')?.innerText || '');
    if (t === 'radio' || t === 'checkbox') {
      const gname = el.name || el.closest('fieldset')?.id || labelOf(el.closest('fieldset') || el.parentElement);
      const fs = el.closest('fieldset, [role="radiogroup"], [role="group"]');
      const groupLabel = clean(fs?.querySelector('legend, [class*="label"], [class*="question"]')?.innerText) || labelOf(fs || el);
      const optLabel = labelOf(el);
      if (!groups.has(gname)) {
        const key = `f${n++}`; groups.set(gname, key);
        fields.push({ key, label: t === 'checkbox' && !fs ? optLabel : groupLabel, type: t, options: [], required });
      }
      const key = groups.get(gname);
      el.dataset.jaKey = key;
      el.dataset.jaOpt = optLabel;
      fields.find((f) => f.key === key).options.push(optLabel);
      continue;
    }
    const key = `f${n++}`;
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
      f.options = (await page.locator('[role="option"]').allInnerTexts()).map((s) => s.trim()).filter(Boolean).slice(0, 80);
      await page.keyboard.press('Escape');
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
  if (!r.ok) throw new Error(`agent resolve ${r.status}`);
  return r.json();
}

export async function fill(page, fields, answers, { resume } = {}) {
  for (const f of fields) {
    const el = page.locator(`[data-ja-key="${f.key}"]`);
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
        await page.locator(`[data-ja-key="${f.key}"][data-ja-opt="${String(v).replace(/"/g, '\\"')}"]`).first().check({ force: true });
      } else if (f.type === 'checkbox') {
        const wanted = String(v).split(/\s*[;|]\s*/);
        if (f.options.length === 1) { if (/^(yes|true|agree|i agree)/i.test(v)) await el.first().check({ force: true }); }
        else for (const w of wanted) await page.locator(`[data-ja-key="${f.key}"][data-ja-opt="${w.replace(/"/g, '\\"')}"]`).first().check({ force: true }).catch(() => {});
      } else {
        await el.fill(String(v));
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
export async function fillForm(page, job, { root = null, resume, dryRun }) {
  const fields = await collect(page, root);
  const { answers, unknown } = await resolveFields(fields, job);
  const blocking = unknown.filter((u) => u.required);
  if (blocking.length) return { status: 'needs_answer', unknown: blocking, fields: fields.length };
  await fill(page, fields, answers, { resume });
  return { status: dryRun ? 'dry_run' : 'filled', fields: fields.length, unknown };
}
