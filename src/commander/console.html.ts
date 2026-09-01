export const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SpaceLogic C-Gate Commander</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1e1e1e;
    color: #d4d4d4;
    font-family: 'SF Mono', 'Menlo', 'Consolas', 'Liberation Mono', monospace;
    font-size: 13px;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  #header {
    padding: 8px 12px;
    background: #2d2d2d;
    border-bottom: 1px solid #404040;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  #header h1 {
    font-size: 14px;
    font-weight: 600;
    color: #e0e0e0;
  }
  #status {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 3px;
    background: #4a4a4a;
    color: #999;
  }
  #status.connected { background: #1a3a1a; color: #4ec94e; }
  #status.error { background: #3a1a1a; color: #e04e4e; }
  #log {
    flex: 1;
    overflow-y: auto;
    padding: 8px 12px;
    line-height: 1.5;
  }
  .line {
    white-space: pre-wrap;
    word-break: break-all;
  }
  .line .ts {
    color: #666;
    margin-right: 8px;
  }
  .line.event { color: #dcdcaa; }
  .line.scp { color: #4ec9b0; }
  .line.response { color: #9cdcfe; }
  .line.error { color: #f44747; }
  .line.console { color: #d4d4d4; }
  .line.cmd { color: #c586c0; }
  #input-bar {
    display: flex;
    padding: 8px 12px;
    background: #2d2d2d;
    border-top: 1px solid #404040;
    gap: 8px;
    flex-shrink: 0;
  }
  #input-bar label {
    color: #c586c0;
    line-height: 30px;
    flex-shrink: 0;
  }
  #cmd {
    flex: 1;
    background: #1e1e1e;
    color: #d4d4d4;
    border: 1px solid #404040;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 13px;
    border-radius: 3px;
    outline: none;
  }
  #cmd:focus { border-color: #007acc; }
  #send {
    background: #007acc;
    color: #fff;
    border: none;
    padding: 4px 16px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
  }
  #send:hover { background: #0098ff; }
  #tagdl {
    margin-left: auto;
    background: #0e639c;
    color: #fff;
    border: none;
    padding: 4px 12px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    font-size: 11px;
    flex-shrink: 0;
  }
  #tagdl:hover { background: #1177bb; }
  #tagdl:disabled { background: #3a3a3a; color: #777; cursor: default; }
</style>
</head>
<body>
<div id="header">
  <h1>SpaceLogic C-Gate Commander</h1>
  <span id="status">Connecting...</span>
  <button id="tagdl" disabled title="Waiting for C-Gate">Download tag DB</button>
</div>
<div id="log"></div>
<div id="input-bar">
  <label>&gt;</label>
  <input type="text" id="cmd" placeholder="Enter C-Gate command (e.g. ON //YELMAH/254/56/1)" autocomplete="off" spellcheck="false">
  <button id="send">Send</button>
</div>
<script>
(function() {
  var log = document.getElementById('log');
  var cmd = document.getElementById('cmd');
  var send = document.getElementById('send');
  var status = document.getElementById('status');
  var autoScroll = true;

  function ts() {
    var d = new Date();
    return d.toLocaleTimeString('en-AU', { hour12: false }) + '.' +
      String(d.getMilliseconds()).padStart(3, '0');
  }

  function appendLine(text, cls) {
    var div = document.createElement('div');
    div.className = 'line ' + cls;
    var span = document.createElement('span');
    span.className = 'ts';
    span.textContent = ts();
    div.appendChild(span);
    div.appendChild(document.createTextNode(text));
    log.appendChild(div);
    if (autoScroll) {
      log.scrollTop = log.scrollHeight;
    }
  }

  log.addEventListener('scroll', function() {
    autoScroll = (log.scrollHeight - log.scrollTop - log.clientHeight) < 40;
  });

  // SSE
  var es = new EventSource('/events');
  es.addEventListener('event', function(e) { appendLine(e.data, 'event'); });
  es.addEventListener('scp', function(e) { appendLine(e.data, 'scp'); });
  es.addEventListener('console', function(e) { appendLine(e.data, 'console'); });
  es.onopen = function() {
    status.textContent = 'Connected';
    status.className = 'connected';
    appendLine('SSE connected', 'console');
  };
  es.onerror = function() {
    status.textContent = 'Reconnecting...';
    status.className = 'error';
  };

  // Command submission
  function sendCommand() {
    var text = cmd.value.trim();
    if (!text) return;
    appendLine(text, 'cmd');
    cmd.value = '';
    fetch('/cgate?cmd=' + encodeURIComponent(text))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.status === 'ok') {
          appendLine(data.response || '(ok)', 'response');
        } else {
          appendLine('Error: ' + (data.error || 'unknown'), 'error');
        }
      })
      .catch(function(err) {
        appendLine('Fetch error: ' + err.message, 'error');
      });
  }

  cmd.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendCommand();
  });
  send.addEventListener('click', sendCommand);
  cmd.focus();

  // --- Tag database download ---
  //
  // DBGETXML over the command interface, which is all a C-Gate *client* can
  // fetch: the .cbz the C-Gate add-on offers is a zip of the project directory,
  // and those files are on the C-Gate host, not necessarily this one.
  var tagdl = document.getElementById('tagdl');
  var tagProject = '';

  function setTagState(project, ready) {
    tagProject = project || '';
    tagdl.disabled = !ready || !tagProject;
    tagdl.textContent = tagProject ? 'Download ' + tagProject + '.xml' : 'Download tag DB';
    tagdl.title = tagdl.disabled
      ? 'C-Gate is not connected, or no project is configured'
      : 'Fetch the ' + tagProject + ' tag database over DBGETXML and save it as XML';
  }

  function refreshTagState() {
    fetch('/tag')
      .then(function(r) { return r.json(); })
      .then(function(d) { setTagState(d.project, d.ready); })
      .catch(function() { setTagState(tagProject, false); });
  }

  tagdl.addEventListener('click', function() {
    var label = tagdl.textContent;
    tagdl.disabled = true;
    tagdl.textContent = 'Fetching...';
    appendLine('DBGETXML //' + tagProject, 'cmd');

    // Fetched rather than linked so a failure lands in the log as an error
    // instead of replacing the console with a page of JSON.
    fetch('/tag/download')
      .then(function(r) {
        if (!r.ok) {
          return r.json().then(function(d) { throw new Error(d.error || ('HTTP ' + r.status)); });
        }
        return r.blob();
      })
      .then(function(blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = tagProject + '.xml';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        appendLine('Tag database saved as ' + tagProject + '.xml (' + blob.size + ' bytes)', 'response');
      })
      .catch(function(err) {
        appendLine('Tag database download failed: ' + err.message, 'error');
      })
      .then(function() {
        tagdl.textContent = label;
        refreshTagState();
      });
  });

  // The button's state follows the connection: SSE open means the commander is
  // up, but C-Gate itself can still be away, so ask rather than assume.
  refreshTagState();
  es.addEventListener('open', refreshTagState);
  setInterval(refreshTagState, 15000);

  appendLine('SpaceLogic C-Gate Commander ready', 'console');
})();
</script>
</body>
</html>`;
