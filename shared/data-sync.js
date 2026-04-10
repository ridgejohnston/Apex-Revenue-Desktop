// ── Apex Revenue Desktop — data-sync.js (Electron adaptation) ────────────────
var APEX_BACKUP_HISTORY_KEY = 'apexBackupHistory';
var APEX_LAST_BACKUP_KEY    = 'apexLastBackup';
var APEX_ACTIVITY_QUEUE_KEY = 'apexActivityQueue';

async function dataSyncCreateBackup(options) {
  options = options || {};
  var data = await apexApiFetch('/create-backup', {
    method: 'POST',
    body: JSON.stringify({
      backup_type:      options.backup_type || 'manual',
      include_fans:     options.include_fans !== false,
      include_earnings: options.include_earnings !== false,
      include_settings: options.include_settings !== false,
    }),
  });
  if (window.electronAPI) {
    await window.electronAPI.store.set(APEX_LAST_BACKUP_KEY, {
      backup_id: data.backup_id, status: data.status,
      created_at: new Date().toISOString(), file_size_bytes: data.file_size_bytes,
    });
  }
  return data;
}

async function dataSyncExport(format, include) {
  var data = await apexApiFetch('/export-data', {
    method: 'POST',
    body: JSON.stringify({ format: format || 'json', include: include || ['fans','earnings','accounts'] }),
  });
  // In desktop: trigger download via anchor
  var blob, filename;
  if (format === 'csv') {
    blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data)], { type: 'text/csv' });
    filename = 'apex-export-' + new Date().toISOString().split('T')[0] + '.csv';
  } else {
    blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    filename = 'apex-export-' + new Date().toISOString().split('T')[0] + '.json';
  }
  var url = URL.createObjectURL(blob);
  var a   = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(function() { URL.revokeObjectURL(url); a.remove(); }, 1000);
  return data;
}

async function dataSyncTrackEvent(event, properties) {
  try {
    var session = await apexGetValidSession();
    if (!session) return;
    fetch('https://us.i.posthog.com/e/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: 'phc_Megg3zY6SfJFPujxs2AjhxPkv3JqjYQnASxcASHNfGJ',
        event, distinct_id: session.access_token ? session.access_token.split('.')[1] : 'desktop',
        properties: Object.assign({ platform: 'desktop' }, properties || {}),
        timestamp: new Date().toISOString(),
      }),
    });
  } catch(e) {}
}
