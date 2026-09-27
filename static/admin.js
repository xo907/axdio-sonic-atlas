// Sonic Atlas: its page in the admin panel. How much of the library is mapped, and the controls for mapping.
AxdioAdmin.page('atlas', async el => {
  const { api, esc, nf, every, toast, fail, settingsCard, ago } = AxdioAdmin;
  el.innerHTML = `<section class="card"><div class="card-h"><h2>Sonic Atlas</h2><span class="badge" id="atl-badge">…</span>
      <div class="row" style="margin-left:auto;gap:8px"><button class="btn ghost sm" id="atl-pause"></button><button class="btn ghost sm" id="atl-remap">Map everything again</button></div></div>
    <p class="desc">Sonic Atlas listens to each song once (a minute of it, from about a third of the way in) and works out its tempo, key, energy and brightness. Listeners see the library as a map of stars in the player (the account menu on computers, Settings on phones), and can draw a line across it to hear a journey that follows it. Nothing leaves this server.</p>
    <div class="card-b"><div class="progress"><i id="atl-bar"></i></div><div class="muted" id="atl-line" style="font-size:13px"></div>
      <div class="muted" id="atl-now" style="font-size:12.5px;margin-top:6px"></div><div id="atl-fail" style="margin-top:14px"></div></div></section>`
    + settingsCard('atlas', { title: 'Settings' });
  const draw = async () => {
    let s;
    try { s = await api('/api/admin/plugins/atlas/status'); } catch (e) { return; }
    if (!document.getElementById('atl-badge')) return;
    const pct = s.library ? Math.floor(100 * s.mapped / s.library) : 0;
    document.getElementById('atl-bar').style.width = pct + '%';
    const badge = document.getElementById('atl-badge');
    badge.textContent = s.queued === 0 ? 'All mapped' : s.paused ? 'Paused' : s.disk_paused ? 'Paused: disk nearly full' : !s.enabled ? 'Off' : s.working ? 'Mapping' : 'Waiting';
    badge.className = 'badge ' + (s.queued === 0 ? 'ok' : s.working ? 'info' : 'warn');
    let line = `${nf(s.mapped)} of ${nf(s.library)} songs mapped (${pct}%)`;
    if (s.queued) line += ` · ${nf(s.queued)} to go` + (s.working && s.rate ? ` · about ${nf(s.rate)} a minute` + (s.eta_minutes != null ? `, done in ${s.eta_minutes >= 90 ? Math.round(s.eta_minutes / 60) + ' hours' : s.eta_minutes + ' minutes'}` : '') : '');
    document.getElementById('atl-line').textContent = line;
    document.getElementById('atl-now').textContent = s.current.length ? 'Listening to ' + s.current.join(', ') : '';
    const pause = document.getElementById('atl-pause');
    pause.textContent = s.paused ? 'Resume' : 'Pause';
    pause.dataset.action = s.paused ? 'resume' : 'pause';
    document.getElementById('atl-fail').innerHTML = s.failed ? `<details><summary class="muted" style="cursor:pointer;font-size:13px">${nf(s.failed)} song${s.failed === 1 ? '' : 's'} couldn't be mapped</summary>
      <div style="margin-top:8px;font-size:12.5px">${s.failures.map(f => `<div class="muted" style="margin:4px 0"><span class="mono">${esc(f.rel)}</span>: ${esc(f.error)}</div>`).join('')}</div>
      <button class="btn ghost sm" id="atl-retry" style="margin-top:8px">Try them again</button></details>` : '';
  };
  const control = async action => {
    try { await api('/api/admin/plugins/atlas/control', { action }); draw(); }
    catch (e) { fail(e); }
  };
  el.addEventListener('click', async e => {
    if (e.target.id === 'atl-pause') control(e.target.dataset.action);
    if (e.target.id === 'atl-retry') { control('retry'); toast('Trying them again'); }
    if (e.target.id === 'atl-remap' && await AxdioAdmin.confirmDlg('Map every song again?', 'Every song is listened to again, which takes a while on a large library. The map stays as it is until then.', 'Map again')) {
      control('remap'); toast('Mapping every song again');
    }
  });
  draw();
  every(draw, 4000);
});
