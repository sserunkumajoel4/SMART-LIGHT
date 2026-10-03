/* =====================================================================
 *  SMART LIGHT TECHNOLOGY — Application Logic
 *  SERUSOFT TECHNOLOGIES · Sserunkuma Joel
 * ---------------------------------------------------------------------
 *  Version: 1.1.0  (harmonized with firmware v1.1.2)
 * ---------------------------------------------------------------------
 *  Sections:
 *    1.  CONFIG         — constants (device, UUIDs, keys, version)
 *    2.  STORAGE        — localStorage helpers
 *    3.  PROTOCOL       — JSON command builder + parser (matches FW)
 *    4.  DEVICE         — connection lifecycle, auto-reconnect
 *    5.  LIGHTS         — light 1 / light 2 control + state
 *    6.  SCHEDULES      — CRUD + sync with firmware
 *    7.  UI             — screens, render, errors, toast
 *    8.  BOOT           — splash, init, service worker, events
 *
 *  Communication contract mirrors firmware/smart_light.ino:
 *    Commands  : set | get_status | get_battery | sync_time
 *                schedule_add | schedule_list | schedule_del
 *                schedule_enable | schedule_disable
 *    Responses : status | battery | schedule_list | ok | err | warning
 * ===================================================================== */


/* =====================================================================
 *  1. CONFIG
 * ===================================================================== */
const CONFIG = {
  PRODUCT_NAME : 'SMART LIGHT TECHNOLOGY',
  DEVICE_NAME  : 'SERUSOFT SMART LIGHT',
  FW_VERSION   : '1.1.2',

  /* BLE UUIDs — developer-only, never shown to the user */
  BLE: {
    SERVICE : '12345678-1234-1234-1234-123456789000',
    CMD     : '12345678-1234-1234-1234-123456789001',
    STATUS  : '12345678-1234-1234-1234-123456789002',
    BATTERY : '12345678-1234-1234-1234-123456789003',
    SCHEDULE: '12345678-1234-1234-1234-123456789004'
  },

  /* localStorage keys */
  LS: {
    LAST_SCREEN : 'sl_last_screen',
    CACHED_SCHED: 'sl_cached_schedules'
  },

  /* Splash duration (ms) */
  SPLASH_MS : 2600,

  /* Delay between commands (firmware rate-limits at 15 ms) */
  CMD_SPACING_MS : 60
};


/* =====================================================================
 *  2. STORAGE
 * ===================================================================== */
const Storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }
};


/* =====================================================================
 *  3. PROTOCOL — command builder + response parser
 * ===================================================================== */
const Protocol = {

  /* ---------- BUILDERS ---------- */

  setLight(bulb, power, brightness) {
    const cmd = {
      cmd: 'set',
      bulb: bulb,
      power: power ? 1 : 0
    };
    /* Only include brightness when explicitly provided */
    if (typeof brightness === 'number') cmd.brightness = brightness;
    return cmd;
  },

  getStatus() {
    return { cmd: 'get_status' };
  },

  getBattery() {
    return { cmd: 'get_battery' };
  },

  syncTime(epochSeconds) {
    return { cmd: 'sync_time', epoch: epochSeconds };
  },

  scheduleAdd(schedule) {
    return {
      cmd: 'schedule_add',
      bulb: schedule.bulb,
      on: schedule.on,
      off: schedule.off,
      brightness: schedule.brightness,
      days: schedule.days
    };
  },

  scheduleList() {
    return { cmd: 'schedule_list' };
  },

  scheduleDel(id) {
    return { cmd: 'schedule_del', id: id };
  },

  scheduleEnable(id) {
    return { cmd: 'schedule_enable', id: id };
  },

  scheduleDisable(id) {
    return { cmd: 'schedule_disable', id: id };
  },

  /* ---------- PARSER ---------- */
  parse(raw) {
    if (typeof raw === 'object' && raw !== null) return raw;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return null;
    try { return JSON.parse(trimmed); }
    catch (e) {
      console.warn('[Protocol] Bad JSON:', trimmed);
      return null;
    }
  }
};


/* =====================================================================
 *  4. DEVICE — connection lifecycle
 * ===================================================================== */
const Device = {
  connected     : false,
  connecting    : false,
  _notificationBuffers: Object.create(null),
  bleDevice     : null,
  gattServer    : null,
  commandChar   : null,
  statusChar    : null,
  batteryChar   : null,
  scheduleChar  : null,

  /* command queue — ensures one write at a time, spaced out */
  _queue        : [],
  _busy         : false,

  /* -------- event hooks (UI subscribes) -------- */
  onStatusChange : null,
  onStatusData   : null,
  onBatteryData  : null,
  onScheduleData : null,

  /* -------- public API -------- */

  connect(device = null) {
    if (this.connecting || this.connected || this.bleDevice) return;

    if (!window.isSecureContext) {
      this._emit('Bluetooth requires HTTPS');
      UI.toast('Bluetooth requires a secure page (HTTPS or localhost).', 'error');
      return;
    }

    if (!navigator.bluetooth) {
      this._emit('Smart Light Unavailable');
      UI.toast('This browser does not support Bluetooth. Use Android Chrome for BLE.', 'error');
      return;
    }

    this.connecting = true;
    this._emit('Searching for Smart Light...');

    /* Broadened filter: match by service UUID OR name prefix, so
       Android's cached GATT doesn't block discovery. */
    const selectedDevice = device
      ? Promise.resolve(device)
      : navigator.bluetooth.requestDevice({
          filters: [{ services: [CONFIG.BLE.SERVICE] }],
          optionalServices: [CONFIG.BLE.SERVICE]
        });

    selectedDevice
      .then((device) => {
        this.bleDevice = device;
        device.addEventListener('gattserverdisconnected', () => this._onDisconnected(), { once: true });
        return device.gatt.connect();
      })
      .then((server) => {
        this.gattServer = server;
        return this._bindCharacteristics(server);
      })
      .then(() => {
        this.connecting = false;
        this._onConnected();
      })
      .catch((error) => {
        console.warn('[Device] BLE connection failed:', error);
        this.connecting = false;
        this.bleDevice = null;
        this.gattServer = null;
        this._emit('Smart Light Unavailable');
      });
  },

  _bindCharacteristics(server) {
    return server.getPrimaryService(CONFIG.BLE.SERVICE)
      .then((service) => Promise.all([
        service.getCharacteristic(CONFIG.BLE.CMD),
        service.getCharacteristic(CONFIG.BLE.STATUS),
        service.getCharacteristic(CONFIG.BLE.BATTERY),
        service.getCharacteristic(CONFIG.BLE.SCHEDULE)
      ]))
      .then(([cmd, status, battery, schedule]) => {
        this.commandChar = cmd;
        this.statusChar  = status;
        this.batteryChar = battery;
        this.scheduleChar = schedule;

        const subs = [];
        if (this.statusChar) {
          subs.push(this._subscribe(this.statusChar));
        }
        if (this.batteryChar) {
          subs.push(this._subscribe(this.batteryChar));
        }
        if (this.scheduleChar) {
          subs.push(this._subscribe(this.scheduleChar));
        }
        return Promise.all(subs);
      });
  },

  _subscribe(characteristic) {
    return characteristic.startNotifications().then(() => {
      characteristic.addEventListener(
        'characteristicvaluechanged',
        (event) => this._consumeNotification(characteristic, event.target.value)
      );
    });
  },

  _consumeNotification(characteristic, value) {
    const text = this._decodeValue(value);
    const frame = text.match(/^~([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2}):/);
    if (!frame) {
      this._handleRawMessage(text);
      return;
    }

    const [ , messageId, indexHex, countHex ] = frame;
    const index = parseInt(indexHex, 16);
    const count = parseInt(countHex, 16);
    if (count === 0 || index >= count) return;

    const key = characteristic.uuid;
    let buffer = this._notificationBuffers[key];
    if (!buffer || buffer.messageId !== messageId || buffer.count !== count) {
      buffer = this._notificationBuffers[key] = {
        messageId,
        count,
        chunks: new Array(count),
        received: 0
      };
    }

    if (buffer.chunks[index] === undefined) {
      buffer.chunks[index] = text.slice(frame[0].length);
      buffer.received++;
    }
    if (buffer.received === buffer.count) {
      delete this._notificationBuffers[key];
      this._handleRawMessage(buffer.chunks.join(''));
    }
  },

  _decodeValue(value) {
    const text = new TextDecoder().decode(value);
    /* Some stacks pad with NULs — strip them. */
    return text.replace(/\0+$/g, '');
  },

  reconnect() {
    this.disconnect(true);
    this.connect();
  },

  disconnect(silent = false) {
    this.connected = false;
    this.connecting = false;
    if (this.bleDevice && this.bleDevice.gatt && this.bleDevice.gatt.connected) {
      try { this.bleDevice.gatt.disconnect(); } catch (e) {}
    }
    this.bleDevice    = null;
    this.gattServer   = null;
    this.commandChar  = null;
    this.statusChar   = null;
    this.batteryChar  = null;
    this.scheduleChar = null;
    this._notificationBuffers = Object.create(null);
    this._queue.length = 0;
    this._busy = false;
    if (!silent) this._emit('Connection Lost');
  },

  /* Send a command object to firmware (queued + spaced) */
  send(cmdObj) {
    if (!this.connected || !this.commandChar) {
      UI.toast('Smart Light is unavailable. Power on the ESP32, then tap Reconnect to select it.', 'error');
      return false;
    }
    this._queue.push(cmdObj);
    this._pump();
    return true;
  },

  _pump() {
    if (this._busy) return;
    if (this._queue.length === 0) return;

    this._busy = true;
    const cmdObj = this._queue.shift();
    const json = JSON.stringify(cmdObj);
    console.log('[TX]', json);

    const bytes = new TextEncoder().encode(json);
    const ch = this.commandChar;

    /* Prefer writeValueWithoutResponse (firmware declares WRITE_NR).
       Fall back to writeValue if the phone doesn't support it. */
    const writePromise = (ch.properties && ch.properties.writeWithoutResponse)
      ? ch.writeValueWithoutResponse(bytes)
      : ch.writeValue(bytes);

    writePromise
      .catch((err) => {
        console.warn('[Device] BLE write failed, retrying with response:', err);
        return ch.writeValue(bytes);
      })
      .catch((err) => {
        console.warn('[Device] BLE write ultimately failed:', err);
        UI.toast('Bluetooth write failed. Please reconnect.', 'error');
      })
      .finally(() => {
        setTimeout(() => {
          this._busy = false;
          this._pump();
        }, CONFIG.CMD_SPACING_MS);
      });
  },

  /* -------- internal -------- */

  _onConnected() {
    this.connected = true;
    this._emit('Smart Light Connected');

    /* Refresh everything after a short settle delay (BLE needs
       a moment after notifications are enabled). */
    setTimeout(() => {
      Lights.requestStatus();
      Lights.requestBattery();
      Schedules.refreshFromDevice();
      Time.syncToDevice();
    }, 300);
  },

  _onDisconnected() {
    this.connected = false;
    this.connecting = false;
    this.bleDevice = null;
    this.gattServer = null;
    this.commandChar = null;
    this.statusChar = null;
    this.batteryChar = null;
    this.scheduleChar = null;
    this._notificationBuffers = Object.create(null);
    this._queue.length = 0;
    this._busy = false;
    this._emit('Connection Lost');
  },

  _handleRawMessage(raw) {
    const msg = Protocol.parse(raw);
    if (!msg) return;
    console.log('[RX]', msg);

    switch (msg.cmd) {
      case 'status':
        if (this.onStatusData) this.onStatusData(msg);
        break;
      case 'battery':
        if (this.onBatteryData) this.onBatteryData(parseFloat(msg.voltage) || 0);
        break;
      case 'schedule_list':
        if (this.onScheduleData) this.onScheduleData(msg.items || []);
        break;
      case 'ok':
        /* e.g. sync_time acknowledgement — no UI change needed */
        break;
      case 'err':
        UI.toast('Action unsuccessful. Please try again.', 'error');
        console.warn('[FW err]', msg);
        break;
      case 'warning':
        UI.toast(`Battery warning: ${msg.type} (${msg.voltage}V)`, 'error');
        break;
    }
  },

  tryAutoReconnect() {
    if (this.connected || this.connecting) return;
    if (!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function') {
      this._emit('Tap Reconnect to connect');
      return;
    }

    navigator.bluetooth.getDevices()
      .then((devices) => {
        const device = devices.find((item) => item.name === CONFIG.DEVICE_NAME);
        if (device) this.connect(device);
        else this._emit('Tap Reconnect to connect');
      })
      .catch(() => this._emit('Tap Reconnect to connect'));
  },

  _emit(stateString) {
    if (this.onStatusChange) this.onStatusChange(stateString);
  }
};


/* =====================================================================
 *  5. LIGHTS
 * ===================================================================== */
const Lights = {
  state: {
    1: { power: false, brightness: 70 },
    2: { power: false, brightness: 40 }
  },

  toggle(bulb) {
    const s = this.state[bulb];
    const newPower = !s.power;
    s.power = newPower;
    UI.renderLight(bulb, s);

    const cmd = Protocol.setLight(bulb, newPower, s.brightness);
    if (!Device.send(cmd)) {
      /* Roll back on send failure */
      s.power = !newPower;
      UI.renderLight(bulb, s);
      return;
    }
    Storage.set('sl_state_' + bulb, s);
  },

  setBrightness(bulb, value) {
    const s = this.state[bulb];
    s.brightness = value;
    UI.renderLight(bulb, s);

    if (s.power) {
      const cmd = Protocol.setLight(bulb, s.power, s.brightness);
      if (!Device.send(cmd)) {
        UI.toast('Brightness change failed.', 'error');
      }
    }
    Storage.set('sl_state_' + bulb, s);
  },

  requestStatus()  { Device.send(Protocol.getStatus());  },
  requestBattery() { Device.send(Protocol.getBattery()); },

  handleStatus(msg) {
    if (msg.bulb1) {
      this.state[1].power      = !!msg.bulb1.power;
      this.state[1].brightness = msg.bulb1.brightness;
      UI.renderLight(1, this.state[1]);
    }
    if (msg.bulb2) {
      this.state[2].power      = !!msg.bulb2.power;
      this.state[2].brightness = msg.bulb2.brightness;
      UI.renderLight(2, this.state[2]);
    }
    if (typeof msg.battery === 'number') UI.setBattery(msg.battery);
    UI.setFirmware(msg.fw || CONFIG.FW_VERSION);
  },

  loadCached() {
    const s1 = Storage.get('sl_state_1', null);
    const s2 = Storage.get('sl_state_2', null);
    if (s1) this.state[1] = s1;
    if (s2) this.state[2] = s2;
    UI.renderLight(1, this.state[1]);
    UI.renderLight(2, this.state[2]);
  }
};


/* =====================================================================
 *  6. SCHEDULES
 * ===================================================================== */
const Schedules = {
  items: [],
  editingId: null,

  refreshFromDevice() {
    Device.send(Protocol.scheduleList());
  },

  handleList(items) {
    this.items = items.map(s => ({
      id: s.id,
      bulb: s.bulb,
      on: s.on,
      off: s.off,
      brightness: s.brightness,
      days: s.days,
      enabled: !!s.enabled
    }));
    Storage.set(CONFIG.LS.CACHED_SCHED, this.items);
    UI.renderSchedules(this.items);
  },

  add(schedule) {
    return Device.send(Protocol.scheduleAdd(schedule));
  },

  remove(id) {
    return Device.send(Protocol.scheduleDel(id));
  },

  setEnabled(id, enabled) {
    return Device.send(enabled
      ? Protocol.scheduleEnable(id)
      : Protocol.scheduleDisable(id));
  },

  loadCached() {
    const cached = Storage.get(CONFIG.LS.CACHED_SCHED, []);
    this.items = cached;
    UI.renderSchedules(cached);
  }
};


/* =====================================================================
 *  TIME — sync the ESP32 clock with the phone
 * ===================================================================== */
const Time = {
  syncToDevice() {
    const epoch = Math.floor(Date.now() / 1000);
    Device.send(Protocol.syncTime(epoch));
    UI.setSystemTime(new Date());
  },

  startTicker() {
    setInterval(() => UI.setSystemTime(new Date()), 30000);
  }
};


/* =====================================================================
 *  7. UI
 * ===================================================================== */
const UI = {

  showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById('screen-' + name);
    if (target) target.classList.add('active');

    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.screen === name);
    });
    Storage.set(CONFIG.LS.LAST_SCREEN, name);
    const main = document.querySelector('.app-main');
    if (main) main.scrollTop = 0;
  },

  setConnectionState(text) {
    const header = document.getElementById('headerStatus');
    if (header) header.textContent = text;

    const dot = document.getElementById('headerDot');
    if (dot) {
      dot.classList.remove('connected', 'error');
      if (/Connected/i.test(text))              dot.classList.add('connected');
      else if (/Unavailable|Lost/i.test(text))  dot.classList.add('error');
    }
    const devStatus = document.getElementById('devStatus');
    if (devStatus) devStatus.textContent = text;
  },

  renderLight(bulb, state) {
    const card    = document.getElementById('card-light'   + bulb);
    const power   = document.getElementById('power-light'  + bulb);
    const stateTx = document.getElementById('state-light'  + bulb);
    const slider  = document.getElementById('slider-light' + bulb);
    const bright  = document.getElementById('bright-light' + bulb);
    const icon    = document.getElementById('icon-light'   + bulb);

    if (!card) return;

    card.classList.toggle('on', state.power);
    power.classList.toggle('on', state.power);
    power.setAttribute('aria-pressed', String(state.power));
    stateTx.textContent = state.power ? 'ON' : 'OFF';
    if (icon) icon.textContent = state.power ? '💡' : '💡';

    slider.value = state.brightness;
    bright.textContent = state.brightness + '%';
    this._paintSlider(slider, state.brightness);
  },

  _paintSlider(slider, value) {
    const pct = value + '%';
    slider.style.background =
      `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${pct}, var(--line) ${pct}, var(--line) 100%)`;
  },

  setBattery(voltage) {
    const v = (Number(voltage) || 0).toFixed(2) + ' V';
    const bv  = document.getElementById('batteryValue');  if (bv)  bv.textContent = v;
    const hb  = document.getElementById('headerBattery'); if (hb)  hb.textContent = v;
    const db  = document.getElementById('devBatt');       if (db)  db.textContent = v;
  },

  setFirmware(version) {
    const el = document.getElementById('devFw');
    if (el) el.textContent = 'v' + version;
  },

  setSystemTime(date) {
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const el = document.getElementById('devTime');
    if (el) el.textContent = `${hh}:${mm}`;
  },

  renderSchedules(items) {
    const list  = document.getElementById('scheduleList');
    const empty = document.getElementById('scheduleEmpty');
    if (!list) return;
    list.innerHTML = '';

    if (!items || items.length === 0) {
      if (empty) {
        list.appendChild(empty);
        empty.classList.remove('hidden');
      }
      return;
    }
    if (empty) empty.classList.add('hidden');

    items.forEach(s => list.appendChild(this._scheduleNode(s)));
  },

  _scheduleNode(s) {
    const el = document.createElement('div');
    el.className = 'schedule-item' + (s.enabled ? '' : ' disabled');

    el.innerHTML = `
      <div class="schedule-item-top">
        <span class="schedule-item-title">Schedule ${String(s.id).padStart(2, '0')}</span>
        <span class="schedule-item-status ${s.enabled ? '' : 'off'}">${s.enabled ? 'ENABLED' : 'DISABLED'}</span>
      </div>
      <div class="schedule-item-time">${s.on} → ${s.off}</div>
      <div class="schedule-item-meta">
        <span>Light ${s.bulb}</span>
        <span>${s.brightness}%</span>
      </div>
      <div class="schedule-item-days">${this._daysLabel(s.days)}</div>
      <div class="schedule-item-actions">
        <button data-action="toggle">${s.enabled ? 'Disable' : 'Enable'}</button>
        <button data-action="delete" class="danger">Delete</button>
      </div>
    `;

    el.querySelector('[data-action="toggle"]').addEventListener('click', () => {
      Schedules.setEnabled(s.id, !s.enabled);
    });
    el.querySelector('[data-action="delete"]').addEventListener('click', () => {
      if (confirm('Delete this schedule?')) Schedules.remove(s.id);
    });

    return el;
  },

  _daysLabel(mask) {
    if (!mask) return 'Never';
    if (mask === '1234567') return 'Every day';
    if (mask === '12345')   return 'Monday – Friday';
    if (mask === '67')      return 'Weekends';
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    return mask.split('').map(d => names[parseInt(d, 10) - 1]).join(' · ');
  },

  openModal() {
    document.getElementById('scheduleModal').classList.remove('hidden');
    document.getElementById('modalTitle').textContent = 'Add Schedule';
    this._resetModal();
  },
  closeModal() {
    document.getElementById('scheduleModal').classList.add('hidden');
  },
  _resetModal() {
    document.querySelectorAll('#segLight .seg-btn').forEach((b, i) => {
      b.classList.toggle('active', i === 0);
    });
    document.getElementById('inOnTime').value   = '18:30';
    document.getElementById('inOffTime').value  = '05:30';
    document.getElementById('inBrightness').value = 70;
    document.getElementById('modalBrightVal').textContent = '70%';
    this._paintSlider(document.getElementById('inBrightness'), 70);
    document.querySelectorAll('.day-chip input').forEach(c => c.checked = true);
    document.getElementById('inEnabled').checked = true;
  },

  toast(message, type = 'info') {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.className = 'toast visible' + (type !== 'info' ? ' ' + type : '');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      t.classList.remove('visible');
    }, 3000);
  }
};


/* =====================================================================
 *  PWA INSTALL
 * ===================================================================== */
const AppInstall = {
  promptEvent: null,

  init() {
    this.notice = document.getElementById('pwaInstallNotice');
    this.message = document.getElementById('pwaInstallMessage');
    this.action = document.getElementById('pwaInstallAction');
    const dismiss = document.getElementById('pwaInstallDismiss');
    if (!this.notice || this.isInstalled()) return;

    this.notice.hidden = false;
    this.action.hidden = false;
    this.action.textContent = 'Install options';
    this.message.textContent = this.installInstructions();

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.promptEvent = event;
      this.message.textContent = 'Install Smart Light for an app-style launch.';
      this.action.textContent = 'Install';
      this.action.hidden = false;
    });
    window.addEventListener('appinstalled', () => this.hide());

    this.action.addEventListener('click', async () => {
      if (!this.promptEvent) {
        this.message.textContent = this.installInstructions();
        return;
      }
      const promptEvent = this.promptEvent;
      this.promptEvent = null;
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === 'accepted') this.hide();
    });
    dismiss.addEventListener('click', () => { this.notice.hidden = true; });
  },

  installInstructions() {
    if (!window.isSecureContext) {
      return 'Installation requires HTTPS (or localhost during development).';
    }
    if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
      return 'In Safari, tap Share, then Add to Home Screen.';
    }
    if (/Android/i.test(navigator.userAgent)) {
      return 'If no install prompt appears, open the browser menu and choose Install app.';
    }
    return 'If no install prompt appears, open the browser menu and choose Install app or Create shortcut.';
  },

  isInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      navigator.standalone === true;
  },

  hide() {
    if (this.notice) this.notice.hidden = true;
  }
};


/* =====================================================================
 *  8. BOOT
 * ===================================================================== */
(function boot() {

  const splash = document.getElementById('splash');
  const app    = document.getElementById('app');
  AppInstall.init();

  setTimeout(() => {
    splash.classList.add('fade-out');
    app.classList.remove('hidden');
    setTimeout(() => splash.remove(), 500);
    initApp();
  }, CONFIG.SPLASH_MS);

  function initApp() {

    /* --- Service worker --- */
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('service-worker.js')
          .then(r => console.log('[PWA] SW registered:', r.scope))
          .catch(e => console.warn('[PWA] SW failed:', e));
      });
    }

    /* --- Bind firmware callbacks to UI --- */
    Device.onStatusChange = (txt) => UI.setConnectionState(txt);
    Device.onStatusData   = (msg) => Lights.handleStatus(msg);
    Device.onBatteryData  = (v)   => UI.setBattery(v);
    Device.onScheduleData = (arr) => Schedules.handleList(arr);

    /* --- Restore cached state --- */
    Lights.loadCached();
    Schedules.loadCached();

    /* --- Restore last screen --- */
    const lastScreen = Storage.get(CONFIG.LS.LAST_SCREEN, 'home');
    UI.showScreen(lastScreen);

    /* --- Wire bottom nav --- */
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => UI.showScreen(btn.dataset.screen));
    });

    /* --- Wire light cards --- */
    [1, 2].forEach(bulb => {
      document.getElementById('power-light' + bulb)
        .addEventListener('click', () => Lights.toggle(bulb));

      const slider = document.getElementById('slider-light' + bulb);
      let liveValue = null;

      slider.addEventListener('input', e => {
        liveValue = parseInt(e.target.value, 10);
        document.getElementById('bright-light' + bulb).textContent = liveValue + '%';
        UI._paintSlider(slider, liveValue);
      });

      slider.addEventListener('change', e => {
        const value = liveValue !== null ? liveValue : parseInt(e.target.value, 10);
        Lights.setBrightness(bulb, value);
        liveValue = null;
      });
    });

    /* --- Schedule modal --- */
    document.getElementById('btnAddSchedule').addEventListener('click', () => UI.openModal());
    document.getElementById('modalClose').addEventListener('click', () => UI.closeModal());
    document.getElementById('modalCancel').addEventListener('click', () => UI.closeModal());
    document.getElementById('modalBackdrop').addEventListener('click', () => UI.closeModal());

    document.querySelectorAll('#segLight .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#segLight .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    const inBright = document.getElementById('inBrightness');
    inBright.addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      document.getElementById('modalBrightVal').textContent = v + '%';
      UI._paintSlider(inBright, v);
    });

    document.getElementById('modalSave').addEventListener('click', () => {
      const bulb = document.querySelector('#segLight .seg-btn.active').dataset.light;
      const on   = document.getElementById('inOnTime').value;
      const off  = document.getElementById('inOffTime').value;
      const bri  = parseInt(document.getElementById('inBrightness').value, 10);

      const days = Array.from(document.querySelectorAll('.day-chip input:checked'))
        .map(c => c.value)
        .join('');

      if (!days) {
        UI.toast('Please select at least one day.', 'error');
        return;
      }

      const ok = Schedules.add({
        bulb: parseInt(bulb, 10),
        on, off,
        brightness: bri,
        days
      });

      if (ok) {
        UI.toast('Schedule saved', 'success');
        UI.closeModal();
      } else {
        UI.toast('Could not save schedule.', 'error');
      }
    });

    /* --- Device screen buttons --- */
    document.getElementById('btnSyncTime').addEventListener('click', () => Time.syncToDevice());
    document.getElementById('btnReconnect').addEventListener('click', () => Device.reconnect());

    /* --- Sliding developer panel --- */
    const devBlock  = document.getElementById('devBlock');
    const devToggle = document.getElementById('devToggle');
    const devPhotoTrack = document.getElementById('devPhotoTrack');
    let devPhotoTimer = null;

    const updateDevPhotoTimer = () => {
      clearInterval(devPhotoTimer);
      devPhotoTimer = null;
      if (!devBlock.classList.contains('open') || document.hidden ||
          window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        devPhotoTrack.classList.remove('show-second');
        return;
      }
      devPhotoTimer = setInterval(() => {
        devPhotoTrack.classList.toggle('show-second');
      }, 3000);
    };

    devToggle.addEventListener('click', () => {
      const open = devBlock.classList.toggle('open');
      devToggle.setAttribute('aria-expanded', String(open));
      updateDevPhotoTimer();
    });
    document.addEventListener('visibilitychange', updateDevPhotoTimer);

    /* --- Start clock ticker --- */
    Time.startTicker();

    /* --- Connect to Smart Light --- */
    Device.tryAutoReconnect();

    /* --- Auto-reconnect when app returns to foreground --- */
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !Device.connected) Device.tryAutoReconnect();
    });
    window.addEventListener('online', () => {
      if (!Device.connected) Device.tryAutoReconnect();
    });

    /* --- Expose for debugging --- */
    window.SmartLight = { CONFIG, Device, Lights, Schedules, UI, Protocol, Time };
  }

})();