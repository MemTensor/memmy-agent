/* global chrome */
'use strict';

const authId = new URL(location.href).searchParams.get('authId');
const controls = document.getElementById('controls');
const form = document.getElementById('auth');
const status = document.getElementById('status');
const fields = new Map();
let request = null;

function field(label, input) {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  const caption = document.createElement('span');
  caption.textContent = label;
  wrapper.append(caption, input);
  controls.append(wrapper);
  return wrapper;
}

function updateFields() {
  const selected = form.elements.namedItem('selected_option');
  const option = request?.options?.find(item => item.id === selected?.value);
  const visible = option ? (option.selector ? [] : option.field_ids || request.fields.map(item => item.id)) : null;
  for (const [id, item] of fields) {
    item.wrapper.hidden = visible !== null && !visible.includes(id);
    item.input.disabled = item.wrapper.hidden;
  }
}

async function start() {
  if (!authId || !/^[a-f\d-]{36}$/i.test(authId)) { window.close(); return; }
  const response = await chrome.runtime.sendMessage({ action: 'auth:get', authId });
  if (!response?.ok || !response.request) { window.close(); return; }
  request = response.request;
  document.getElementById('site').textContent = request.origin;
  if (request.options) {
    const select = document.createElement('select');
    select.name = 'selected_option';
    for (const option of request.options) {
      const element = document.createElement('option');
      element.value = option.id; element.textContent = option.label; select.append(element);
    }
    field('Continue with', select);
    select.addEventListener('change', updateFields);
  }
  for (const item of request.fields) {
    const input = document.createElement('input');
    input.name = item.id; input.type = item.type; input.required = item.required;
    input.autocomplete = 'off'; input.maxLength = 4096;
    const wrapper = field(item.label, input);
    fields.set(item.id, { input, wrapper });
  }
  updateFields();
}

document.getElementById('cancel').addEventListener('click', async () => {
  if (authId) await chrome.runtime.sendMessage({ action: 'auth:cancel', authId }).catch(() => undefined);
  window.close();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!request || !form.reportValidity()) return;
  const values = {};
  for (const [id, item] of fields) if (!item.input.disabled) values[id] = item.input.value;
  const selected = form.elements.namedItem('selected_option');
  const response = await chrome.runtime.sendMessage({ action: 'auth:submit', authId,
    selected_option: selected?.value, values }).catch(() => null);
  if (response?.ok) window.close();
  else status.textContent = 'This sign-in request expired. Please try again.';
});
void start().catch(() => { status.textContent = 'Secure sign-in is unavailable.'; });
