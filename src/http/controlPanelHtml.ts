/**
 * Device control panel HTML — served when the GaggiMate web portal is not accessible.
 * Use this to switch profiles and manage favorites when remote (e.g. via Tailscale).
 */
export function getControlPanelHtml(apiBasePath: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GaggiMate Control</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #1a1a1a;
      color: #e0e0e0;
      margin: 0;
      padding: 1.5rem;
      max-width: 480px;
      margin-left: auto;
      margin-right: auto;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0 0 0.5rem;
      color: #fff;
    }
    .subtitle {
      font-size: 0.875rem;
      color: #888;
      margin-bottom: 1rem;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.75rem;
      border-radius: 6px;
      font-size: 0.8rem;
      margin-bottom: 1rem;
    }
    .status.online { background: #0d3d0d; color: #7fdb7f; }
    .status.offline { background: #3d1a1a; color: #ff7f7f; }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .toolbar {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    button {
      background: #333;
      color: #fff;
      border: 1px solid #555;
      border-radius: 6px;
      padding: 0.5rem 1rem;
      font-size: 0.875rem;
      cursor: pointer;
    }
    button:hover { background: #444; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.primary { background: #2563eb; border-color: #2563eb; }
    button.primary:hover { background: #1d4ed8; }
    .profile-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .profile {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      background: #252525;
      border-radius: 8px;
      margin-bottom: 0.5rem;
      border: 1px solid #333;
    }
    .profile.selected { border-color: #2563eb; background: #1e293b; }
    .profile-name {
      font-weight: 500;
      flex: 1;
    }
    .profile-actions {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    .profile-actions button {
      padding: 0.35rem 0.65rem;
      font-size: 0.8rem;
    }
    .favorite-btn {
      background: transparent;
      border: none;
      cursor: pointer;
      padding: 0.25rem;
      font-size: 1.1rem;
    }
    .favorite-btn:hover { opacity: 0.8; }
    .favorite-btn.favorited { color: #fbbf24; }
    .error-msg {
      background: #3d1a1a;
      color: #ff7f7f;
      padding: 1rem;
      border-radius: 8px;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
    .empty { color: #888; font-style: italic; padding: 1rem; }
  </style>
</head>
<body>
  <h1>GaggiMate Control</h1>
  <p class="subtitle">Switch profiles when the device web portal isn't accessible</p>
  <div id="status" class="status offline">
    <span class="status-dot"></span>
    <span id="status-text">Checking...</span>
  </div>
  <div id="error" class="error-msg" style="display:none"></div>
  <div class="toolbar">
    <button id="refresh" class="primary">Refresh</button>
  </div>
  <ul id="profiles" class="profile-list"></ul>
  <script>
    const API = '${apiBasePath}';
    const statusEl = document.getElementById('status');
    const statusText = document.getElementById('status-text');
    const errorEl = document.getElementById('error');
    const profilesEl = document.getElementById('profiles');
    const refreshBtn = document.getElementById('refresh');

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = msg ? 'block' : 'none';
    }

    function setStatus(online) {
      statusEl.className = 'status ' + (online ? 'online' : 'offline');
      statusText.textContent = online ? 'Device online' : 'Device offline';
    }

    async function loadProfiles() {
      refreshBtn.disabled = true;
      showError('');
      try {
        const res = await fetch(API + '/profiles');
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.detail || data.error || 'Request failed');
        }
        const data = await res.json();
        setStatus(true);
        renderProfiles(data.profiles || []);
      } catch (err) {
        setStatus(false);
        showError(err.message || 'Could not reach device');
        profilesEl.innerHTML = '<li class="empty">Device unreachable. Check GAGGIMATE_HOST and network.</li>';
      } finally {
        refreshBtn.disabled = false;
      }
    }

    function renderProfiles(profiles) {
      if (!profiles.length) {
        profilesEl.innerHTML = '<li class="empty">No profiles on device</li>';
        return;
      }
      profilesEl.innerHTML = profiles.map(p => {
        const selected = p.selected ? ' selected' : '';
        const favClass = p.favorite ? 'favorited' : '';
        const favChar = p.favorite ? '★' : '☆';
        return '<li class="profile' + selected + '" data-id="' + escapeHtml(p.id) + '">' +
          '<span class="profile-name">' + escapeHtml(p.label || p.id || 'Unnamed') + '</span>' +
          '<div class="profile-actions">' +
          '<button class="favorite-btn ' + favClass + '" data-id="' + escapeHtml(p.id) + '" data-fav="' + p.favorite + '" title="Toggle favorite">' + favChar + '</button>' +
          '<button class="select-btn" data-id="' + escapeHtml(p.id) + '">Select</button>' +
          '</div></li>';
      }).join('');

      profilesEl.querySelectorAll('.select-btn').forEach(btn => {
        btn.addEventListener('click', () => selectProfile(btn.dataset.id));
      });
      profilesEl.querySelectorAll('.favorite-btn').forEach(btn => {
        btn.addEventListener('click', () => toggleFavorite(btn.dataset.id, btn.dataset.fav === 'true'));
      });
    }

    function escapeHtml(s) {
      if (s == null) return '';
      const div = document.createElement('div');
      div.textContent = String(s);
      return div.innerHTML;
    }

    async function selectProfile(id) {
      try {
        const res = await fetch(API + '/profiles/' + encodeURIComponent(id) + '/select', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        if (!res.ok) throw new Error((await res.json()).detail || 'Select failed');
        loadProfiles();
      } catch (err) {
        showError(err.message);
      }
    }

    async function toggleFavorite(id, currentlyFav) {
      const fav = !currentlyFav;
      try {
        const res = await fetch(API + '/profiles/' + encodeURIComponent(id) + '/favorite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ favorite: fav })
        });
        if (!res.ok) throw new Error((await res.json()).detail || 'Update failed');
        loadProfiles();
      } catch (err) {
        showError(err.message);
      }
    }

    refreshBtn.addEventListener('click', loadProfiles);
    loadProfiles();
  </script>
</body>
</html>`;
}
