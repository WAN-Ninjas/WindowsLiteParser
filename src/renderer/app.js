'use strict';

const $ = selector => document.querySelector(selector);
let state;
let kind = 'project';
let selectedId = null;
let reviewId = null;
let reviewDoc = null;
let selectedSourceText = '';
let reviewBusy = false;
let currentPage = 0;
let refreshVersion = 0;
let toastTimer;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 9000); }
function errorText(error) { return String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
async function action(button, operation) {
  if (button) button.disabled = true;
  try { return await operation(); } catch (error) { toast(errorText(error)); }
  finally { if (button) button.disabled = false; }
}
function shortDate(value) { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function countStatus(status) { return state.counts.find(item => item.status === status)?.count || 0; }

async function refresh() {
  const version = ++refreshVersion;
  try {
    const next = await window.portal.state(selectedId, { page: currentPage, filter: $('#status-filter').value });
    if (version !== refreshVersion) return;
    state = next; currentPage = next.page; render();
  } catch (error) { toast(errorText(error)); }
}

function navigate(nextKind, id = null) { kind = nextKind; selectedId = id; currentPage = 0; $('#status-filter').value = 'all'; refresh(); }
function render() {
  const quick = kind === 'quick';
  const collection = state.collections.find(item => item.id === selectedId);
  const collections = state.collections.filter(item => item.kind === kind);
  $('#nav-projects').classList.toggle('active', !quick);
  $('#nav-quick').classList.toggle('active', quick);
  $('#project-count').textContent = state.collections.filter(item => item.kind === 'project').length;
  $('#quick-count').textContent = state.collections.filter(item => item.kind === 'quick').length;
  $('#sidebar-description').textContent = quick ? 'Convert a file or a whole batch.\nKeep the results together.' : 'Keep adding documents.\nOne project. One growing CSV.';
  const sidebar = $('#sidebar-collections'); sidebar.replaceChildren();
  for (const item of collections) {
    const button = element('button', `${quick ? 'ϟ' : '▱'}  ${item.name}`, `sidebar-collection${item.id === selectedId ? ' selected' : ''}`);
    button.title = item.name; button.onclick = () => navigate(kind, item.id); sidebar.append(button);
  }
  const breadcrumb = $('#breadcrumb'); breadcrumb.replaceChildren(element('span', 'Workspace'), element('span', '/'), element('span', quick ? 'Quick conversions' : 'Projects'));
  $('#page-title').textContent = quick ? 'Quick conversions' : 'Your projects';
  $('#page-description').textContent = quick ? 'A single file or a whole folder. Extract fields and export a CSV in one place.' : 'A home for documents that keep coming. Import, review, and grow your CSV.';
  $('#new-button').textContent = quick ? '＋ New conversion' : '＋ New project';
  $('#stat-documents').textContent = state.counts.reduce((sum, item) => sum + item.count, 0);
  $('#stat-completed').textContent = countStatus('completed');
  $('#stat-review').textContent = state.collections.reduce((sum, item) => sum + item.needs_review, 0);
  const pending = countStatus('queued') + countStatus('processing');
  $('#queue-status').textContent = state.paused ? 'Queue paused' : pending ? `${pending} document${pending === 1 ? '' : 's'} in queue` : 'Ready to convert';
  $('#pause-button').textContent = state.paused ? 'Resume' : 'Pause';
  $('#pause-button').disabled = Boolean(state.fatalError);
  $('#fatal-banner').hidden = !state.fatalError;
  $('#fatal-banner').textContent = `Processing stopped: ${state.fatalError}. Check available disk space and restart Portal. Your data folder is ${state.dataDirectory}.`;
  $('#detail').hidden = !collection;
  $('#collection-list').hidden = Boolean(collection);
  $('#empty-state').hidden = Boolean(collection) || collections.length > 0;
  $('#empty-title').textContent = quick ? 'Your next conversion starts here' : 'Make room for your first project';
  $('#empty-description').textContent = quick ? 'Add a file or a folder. Fields are discovered from your documents.\nReview the results and take your CSV with you.' : 'Give it a name and add your first document.\nFields are discovered automatically. Your CSV grows as new fields arrive.';
  $('#empty-new').textContent = quick ? '＋ Start a conversion' : '＋ Create a project';
  if (collection) renderDetail(collection);
  else {
    const grid = element('div', undefined, 'collection-grid');
    for (const item of collections) {
      const card = element('button', undefined, 'collection-card');
      card.onclick = () => navigate(kind, item.id);
      card.append(element('span', quick ? 'ϟ' : '▱', 'card-icon'), element('h2', item.name),
        element('p', `${item.total} documents · ${item.fields.length} extraction fields`));
      const bottom = element('div', undefined, 'card-bottom');
      bottom.append(element('span', item.needs_review ? `${item.needs_review} to review` : item.watch_path ? '● Watching folder' : `Created ${shortDate(item.created_at)}`), element('span', 'Open →'));
      card.append(bottom); grid.append(card);
    }
    $('#collection-list').replaceChildren(grid);
  }
}

function renderDetail(collection) {
  $('#back-button').textContent = kind === 'quick' ? '← All conversions' : '← All projects';
  $('#detail .tag').textContent = kind === 'quick' ? 'QUICK CONVERSION' : 'LOCAL PROJECT';
  $('#detail-name').textContent = collection.name;
  $('#watch-button').closest('.project-settings').hidden = kind === 'quick';
  $('#watch-path').textContent = collection.watch_path || 'Add files automatically while Portal is open (includes subfolders)';
  $('#watch-button').textContent = collection.watch_path ? 'Change folder' : 'Choose folder';
  $('#stop-watch').hidden = !collection.watch_path;
  $('#output-path').textContent = collection.output_path;
  $('#retention-select').value = collection.retain_content ? 'keep' : 'remove';
  $('#analysis-select').value = collection.analysis_mode;
  const alerts = [collection.watch_error, collection.export_error].filter(Boolean);
  $('#project-alert').hidden = !alerts.length;
  $('#project-alert').textContent = alerts.join('\n');
  $('#document-count').textContent = collection.total;
  const documents = state.documents;
  const body = $('#documents'); body.replaceChildren();
  for (const doc of documents) {
    const row = element('tr');
    const name = element('td'); name.append(element('span', doc.name, 'file-name'), element('span', `${(doc.bytes / 1024).toFixed(0)} KB${doc.page_count ? ` · ${doc.page_count} page${doc.page_count === 1 ? '' : 's'}` : ''}${doc.analysis.mode ? ` · ${doc.analysis.mode === 'high' ? 'High accuracy' : 'Standard'}` : ''}`, 'file-meta')); name.title = doc.name;
    const fields = element('td', doc.status === 'completed' ? `${collection.fields.length - doc.missing.length} / ${collection.fields.length} required & optional` : '—');
    // Count all extracted fields, including optional blanks, accurately.
    if (doc.status === 'completed') fields.textContent = `${collection.fields.filter(field => Boolean(doc.values[field.name])).length} / ${collection.fields.length} fields`;
    let label = doc.status; let css = doc.status;
    if (doc.status === 'completed') { label = doc.purged ? '↗ CSV only' : doc.reviewed ? '✓ Reviewed' : '◷ Needs review'; css = doc.reviewed ? 'completed' : 'review'; }
    else label = { failed: 'Failed', queued: 'Queued', processing: 'Converting…' }[doc.status];
    const status = element('td'); status.append(element('span', label, `status ${css}`));
    if (doc.analysis.warnings?.length) status.append(element('span', `${doc.analysis.warnings.length} analysis warning(s)`, 'file-meta'));
    const flags = doc.feedback.filter(item => item.status === 'missed').length;
    if (flags) status.append(element('span', `${flags} missed-field flag(s)`, 'flag-note'));
    if (doc.error) { status.title = doc.error; const note = element('span', doc.error.slice(0, 90), 'file-meta'); status.append(note); }
    const when = element('td', shortDate(doc.created_at));
    const control = element('td');
    if (doc.status === 'completed' && !doc.purged) { const button = element('button', doc.reviewed ? 'View' : 'Review →', 'text-button'); button.onclick = () => action(button, () => openReview(doc.id)); control.append(button); }
    if (doc.status === 'completed' && !doc.purged) {
      const button = element('button', 'Reanalyze', 'text-button');
      button.title = 'Run again using the selected analysis quality';
      button.onclick = () => action(button, async () => { if (await window.portal.reanalyze(doc.id)) toast('Queued for reanalysis. Previous CSV values are kept until it succeeds.'); await refresh(); });
      control.append(button);
    }
    if (doc.purged) { fields.textContent = 'Saved in CSV'; control.append(element('span', 'Content removed', 'file-meta')); }
    if (doc.status === 'failed') { const button = element('button', 'Retry', 'text-button'); button.onclick = () => action(button, () => window.portal.retry(doc.id)); control.append(button); }
    row.append(name, fields, status, when, control); body.append(row);
  }
  $('#no-documents').hidden = documents.length > 0;
  $('#no-documents').textContent = collection.total ? 'No documents match this filter.' : 'No documents yet. Add a file or import a folder to get started.';
  $('#document-range').textContent = state.documentTotal ? `${state.page * state.pageSize + 1}–${state.page * state.pageSize + documents.length} of ${state.documentTotal} documents` : '0 documents';
  $('#previous-page').disabled = state.page === 0;
  $('#next-page').disabled = (state.page + 1) * state.pageSize >= state.documentTotal;
  $('#document-limit').textContent = `Duplicates are skipped by file content within this ${kind === 'quick' ? 'conversion' : 'project'}. Imported copies follow your retention setting.`;
}

function schemaField(field) {
  const container = element('div', undefined, 'schema-field');
  const top = element('div', undefined, 'schema-field-top');
  const label = element('input'); label.value = field.label; label.placeholder = 'Field label'; label.required = true; label.maxLength = 100; label.setAttribute('aria-label', 'Field label'); label.dataset.role = 'label';
  const name = element('input'); name.value = field.name; name.placeholder = 'csv_column'; name.required = true; name.pattern = '[a-z][a-z0-9_]{0,63}'; name.setAttribute('aria-label', 'CSV column name'); name.dataset.role = 'name';
  label.oninput = () => { if (!name.value || !container.dataset.editedName) name.value = label.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64); };
  name.oninput = () => { container.dataset.editedName = 'true'; };
  if (field.name) container.dataset.editedName = 'true';
  const required = element('label', 'Required'); const check = element('input'); check.type = 'checkbox'; check.checked = field.required; check.dataset.role = 'required'; required.prepend(check);
  const remove = element('button', '×', 'icon-button'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove field'); remove.onclick = () => container.remove();
  top.append(label, name, required, remove);
  const advanced = element('details'); advanced.append(element('summary', 'Extraction rule (advanced)'));
  const pattern = element('textarea'); pattern.value = field.pattern || ''; pattern.dataset.role = 'pattern'; pattern.setAttribute('aria-label', `Extraction pattern for ${field.label || 'new field'}`);
  advanced.append(element('p', 'Case-insensitive regular expression. The first capture group is the value. Leave blank to fill this field manually during review.'), pattern);
  container.append(top, advanced); return container;
}

function openCreate() {
  $('#create-title').textContent = kind === 'quick' ? 'New quick conversion' : 'New project';
  $('#create-submit').textContent = kind === 'quick' ? 'Create conversion' : 'Create project';
  $('#collection-name').value = kind === 'quick' ? `Conversion ${new Date().toLocaleDateString()}` : '';
  $('#schema-fields').replaceChildren(...state.defaultFields.map(schemaField));
  $('#create-error').hidden = true;
  $('#create-retention').value = 'keep';
  $('#create-analysis').value = 'high';
  $('#create-dialog').showModal(); $('#collection-name').focus();
}

async function importDocuments(button, folder) {
  await action(button, async () => {
    const report = await window.portal.import(selectedId, folder);
    if (!report) return;
    const summary = [`${report.added} added`, `${report.duplicates} duplicates skipped`];
    if (report.unsupported) summary.push(`${report.unsupported} unsupported files skipped`);
    if (report.errors.length) summary.push(`${report.errors.length} import errors:\n${report.errors.slice(0, 4).join('\n')}`);
    toast(summary.join(' · ')); await refresh();
  });
}

async function openReview(id) {
  const doc = await window.portal.document(id); reviewId = doc.id; reviewDoc = doc;
  selectedSourceText = ''; $('#use-selection').disabled = true; $('#teach-panel').hidden = true;
  $('#review-analysis').value = doc.analysisMode;
  $('#review-title').textContent = doc.name;
  const analysis = doc.analysis;
  const summary = [analysis.mode === 'high' ? 'High accuracy analysis' : analysis.mode === 'standard' ? 'Standard analysis' : 'Earlier conversion'];
  if (analysis.tableCount) summary.push(`${analysis.tableCount} table(s) · ${analysis.tableRowCount} data row(s)`);
  for (const check of analysis.checks || []) summary.push(`${check.passed ? '✓' : 'Check needed:'} ${check.label}`);
  summary.push(...(analysis.warnings || []));
  if (analysis.manualCorrectionsKept) summary.push(`${analysis.manualCorrectionsKept} saved manual correction(s) kept`);
  $('#analysis-summary').textContent = summary.join(' · ');
  const fields = doc.fields.map(field => {
    const row = element('div', undefined, 'review-field'); row.dataset.field = field.name;
    const label = element('label', `${field.label}${field.required ? ' *' : ''}`, `field-label${doc.missing.includes(field.name) ? ' missing' : ''}`);
    const value = doc.values[field.name] || '';
    const input = element(value.includes('\n') || field.name.startsWith('line_item_') ? 'textarea' : 'input');
    input.name = field.name; input.value = value; input.required = field.required; input.maxLength = 1000000;
    if (input.tagName === 'TEXTAREA') input.rows = Math.min(10, Math.max(3, value.split('\n').length));
    label.append(input); row.append(label, element('p', '', 'field-note'), element('div', undefined, 'field-actions')); return row;
  });
  $('#review-fields').replaceChildren(...fields);
  if (!fields.length) $('#review-fields').append(element('p', 'No labeled values were found. Add fields manually from the source text.', 'footnote'));
  $('#additional-fields').replaceChildren();
  $('#source-text').textContent = doc.text;
  $('#text-truncated').hidden = !doc.truncated;
  $('#review-error').hidden = true;
  renderReviewFeedback();
  if (!$('#review-dialog').open) $('#review-dialog').showModal();
}

function reviewDraft() {
  return {
    values: Object.fromEntries([...$('#review-fields').querySelectorAll('input[name], textarea[name]')].map(input => [input.name, input.value])),
    additional: [...$('#additional-fields').children].map(node => ({ label: node.querySelector('[data-role=label]').value, value: node.querySelector('[data-role=value]').value }))
  };
}

async function reviewAction(operation) {
  if (reviewBusy) return;
  reviewBusy = true; $('#review-error').hidden = true;
  const controls = [...$('#review-dialog').querySelectorAll('button, input, textarea, select')].map(node => [node, node.disabled]);
  controls.forEach(([node]) => { node.disabled = true; });
  try { await operation(); }
  catch (error) { $('#review-error').textContent = errorText(error); $('#review-error').hidden = false; }
  finally {
    controls.forEach(([node, disabled]) => { if (node.isConnected) node.disabled = disabled; });
    $('#teach-label').disabled = Boolean($('#teach-existing').value);
    $('#use-selection').disabled = !selectedSourceText.trim();
    reviewBusy = false;
  }
}

function renderReviewFeedback() {
  for (const row of $('#review-fields').children) {
    const field = reviewDoc.fields.find(field => field.name === row.dataset.field);
    if (!field) continue;
    const feedback = reviewDoc.feedback.find(item => item.field === field.name);
    const taught = reviewDoc.analysis.taughtFields?.find(item => item.field === field.name);
    const note = row.querySelector('.field-note');
    row.classList.toggle('flagged', feedback?.status === 'missed');
    note.textContent = feedback?.status === 'missed' ? 'Flagged: missing or incorrect. Fix the value or clear the flag before marking reviewed.' : feedback?.status === 'corrected' ? 'Saved manual correction · kept during reanalysis' : taught?.status === 'matched' ? `Suggested from source label “${taught.anchor}” · check against the source` : taught ? 'Saved source label needs attention · see analysis warning' : reviewDoc.missing.includes(field.name) ? 'Required value not found' : '';
    const actions = row.querySelector('.field-actions'); actions.replaceChildren();
    const teach = element('button', 'Teach / fix', 'text-button'); teach.type = 'button';
    teach.onclick = () => openTeach(field.name, row.querySelector('input, textarea').value || selectedSourceText);
    actions.append(teach);
    if (feedback) {
      const clear = element('button', feedback.status === 'missed' ? 'Clear flag' : 'Allow automatic extraction', 'text-button'); clear.type = 'button';
      clear.dataset.action = 'clear-feedback';
      clear.onclick = () => reviewAction(async () => { reviewDoc.feedback = await window.portal.feedback(reviewId, field.name, false); renderReviewFeedback(); });
      actions.append(clear);
    }
    if (feedback?.status !== 'missed') {
      const flag = element('button', 'Flag as missed / incorrect', 'text-button'); flag.type = 'button';
      flag.dataset.action = 'flag';
      flag.onclick = () => reviewAction(async () => { reviewDoc.feedback = await window.portal.feedback(reviewId, field.name, true); renderReviewFeedback(); });
      actions.append(flag);
    }
  }
}

function openTeach(name = '', example = '') {
  const select = $('#teach-existing');
  select.replaceChildren(new Option('Create a new field', ''), ...reviewDoc.fields.map(field => new Option(field.label, field.name)));
  select.value = name; const field = reviewDoc.fields.find(field => field.name === name);
  $('#teach-label').value = field?.label || ''; $('#teach-label').disabled = Boolean(field);
  $('#teach-example').value = example; $('#teach-anchor').value = field?.hint?.anchor || '';
  $('#teach-reuse').checked = Boolean(field?.hint);
  $('#teach-preview-result').textContent = 'Check the source label to preview a reusable match. You can also save this document only.';
  $('#teach-panel').hidden = false;
  $('#teach-panel').scrollIntoView({ block: 'nearest' });
  (field ? $('#teach-example') : $('#teach-label')).focus();
}

function teachingConfig() { return { field: $('#teach-existing').value, label: $('#teach-label').value, example: $('#teach-example').value, anchor: $('#teach-anchor').value, reuse: $('#teach-reuse').checked }; }

async function previewField() {
  const preview = await window.portal.previewTeaching(reviewId, teachingConfig());
  $('#teach-anchor').value = preview.anchor;
  $('#teach-preview-result').textContent = `${preview.message}${preview.match ? ` Page ${preview.match.page}: “${preview.match.value}”` : ''}`;
}

$('#nav-projects').onclick = () => navigate('project');
$('#nav-quick').onclick = () => navigate('quick');
$('.brand').onclick = event => { event.preventDefault(); navigate('project'); };
$('#new-button').onclick = openCreate; $('#empty-new').onclick = openCreate;
$('#back-button').onclick = () => navigate(kind);
$('#status-filter').onchange = () => { currentPage = 0; refresh(); };
$('#previous-page').onclick = () => { currentPage = Math.max(0, currentPage - 1); refresh(); };
$('#next-page').onclick = () => { currentPage++; refresh(); };
$('#pause-button').onclick = event => action(event.currentTarget, async () => { await window.portal.pause(); await refresh(); });
$('#open-data').onclick = event => action(event.currentTarget, () => window.portal.revealData());
$('#import-files').onclick = event => importDocuments(event.currentTarget, false);
$('#import-folder').onclick = event => importDocuments(event.currentTarget, true);
$('#watch-button').onclick = event => action(event.currentTarget, async () => { await window.portal.watch(selectedId, true); await refresh(); });
$('#stop-watch').onclick = event => action(event.currentTarget, async () => { await window.portal.watch(selectedId, false); await refresh(); });
$('#export-button').onclick = event => action(event.currentTarget, async () => { const result = await window.portal.export(selectedId); if (result) toast('CSV saved. Future imports and corrections will update this file.'); await refresh(); });
$('#reveal-csv').onclick = event => action(event.currentTarget, () => window.portal.reveal(selectedId));
$('#retention-select').onchange = event => action(event.currentTarget, async () => { await window.portal.retention(selectedId, event.target.value === 'keep'); await refresh(); toast('Retention setting saved. Previously removed content cannot be restored.'); });
$('#analysis-select').onchange = event => action(event.currentTarget, async () => { await window.portal.analysisMode(selectedId, event.target.value); await refresh(); toast('Analysis quality saved. Use Reanalyze to update an existing result.'); });
$('#add-field').onclick = () => $('#schema-fields').append(schemaField({ label: '', name: '', required: false, pattern: '' }));
document.querySelectorAll('.close-dialog').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
$('#create-form').onsubmit = async event => {
  event.preventDefault(); const button = $('#create-submit'); button.disabled = true;
  try {
    const fields = [...document.querySelectorAll('.schema-field')].map(node => ({ name: node.querySelector('[data-role=name]').value.trim(), label: node.querySelector('[data-role=label]').value.trim(), pattern: node.querySelector('[data-role=pattern]').value, required: node.querySelector('[data-role=required]').checked }));
    selectedId = await window.portal.create({ kind, name: $('#collection-name').value, fields, retainContent: $('#create-retention').value === 'keep', analysisMode: $('#create-analysis').value });
    $('#create-dialog').close(); $('#status-filter').value = 'all'; await refresh();
    toast('Ready. Your first document will establish the fields.');
  } catch (error) { $('#create-error').textContent = errorText(error); $('#create-error').hidden = false; }
  finally { button.disabled = false; }
};
$('#review-form').onsubmit = async event => {
  event.preventDefault();
  await reviewAction(async () => {
    const { values, additional } = reviewDraft();
    await window.portal.review(reviewId, values, additional); $('#review-dialog').close(); toast('Review saved. Your CSV is up to date.'); await refresh();
  });
};
$('#review-draft').onclick = () => reviewAction(async () => {
  const { values, additional } = reviewDraft(); await window.portal.draft(reviewId, values, additional);
  await openReview(reviewId); toast('Draft saved. This document still needs review.');
});
$('#review-reanalyze').onclick = () => reviewAction(async () => {
  const quality = $('#review-analysis').value; const { values, additional } = reviewDraft();
  await window.portal.draft(reviewId, values, additional);
  await window.portal.analysisMode(reviewDoc.collectionId, quality);
  if (await window.portal.reanalyze(reviewId)) { $('#review-dialog').close(); toast('Queued for reanalysis. Saved manual corrections and missed-field flags are kept.'); }
  await refresh();
});
$('#review-teach').onclick = () => openTeach('', selectedSourceText);
$('#teach-cancel').onclick = () => { $('#teach-panel').hidden = true; };
$('#teach-existing').onchange = () => {
  const field = reviewDoc.fields.find(field => field.name === $('#teach-existing').value);
  $('#teach-label').value = field?.label || ''; $('#teach-label').disabled = Boolean(field);
  $('#teach-anchor').value = field?.hint?.anchor || ''; $('#teach-reuse').checked = Boolean(field?.hint);
};
$('#teach-preview').onclick = () => reviewAction(previewField);
$('#teach-save').onclick = () => reviewAction(async () => {
  const { values, additional } = reviewDraft(); await window.portal.teach(reviewId, teachingConfig(), values, additional);
  await openReview(reviewId); toast('Field and draft saved. Review the result before marking complete.');
});
document.addEventListener('selectionchange', () => {
  if (!$('#review-dialog').open || reviewBusy) return;
  const selection = window.getSelection();
  if (selection && $('#source-text').contains(selection.anchorNode) && $('#source-text').contains(selection.focusNode)) {
    selectedSourceText = selection.toString().slice(0, 1000000); $('#use-selection').disabled = !selectedSourceText.trim();
  }
});
$('#use-selection').onclick = () => reviewAction(async () => { openTeach('', selectedSourceText); if (selectedSourceText.length <= 10000) await previewField(); });
$('#review-add-field').onclick = () => {
  const row = element('div', undefined, 'additional-field');
  const label = element('input'); label.dataset.role = 'label'; label.placeholder = 'Field label'; label.required = true; label.maxLength = 80; label.setAttribute('aria-label', 'New field label');
  const value = element('input'); value.dataset.role = 'value'; value.placeholder = 'Value'; value.maxLength = 10000; value.setAttribute('aria-label', 'New field value');
  const remove = element('button', '×', 'icon-button'); remove.type = 'button'; remove.onclick = () => row.remove();
  row.append(label, value, remove); $('#additional-fields').append(row); label.focus();
};
window.portal.onChange(refresh);
refresh();
