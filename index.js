const axios  = require('axios');
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const AWS    = require('aws-sdk');
const https  = require('https');

// Постоянное keep-alive соединение — переиспользуется между командами,
// избегая нового TLS handshake (~200-500ms) на каждый publish
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 5, keepAliveMsecs: 60000 });

// ─────────────────────────────────────────────
// МАППИНГ workMode для TAC-BR12INV
// ─────────────────────────────────────────────
const MODE = {
  AUTO: 0,
  COOL: 1,
  DRY:  2,
  FAN:  3,
  HEAT: 4,
};

const WIND = {
  AUTO:     0,
  SILENT:   2,
  LOW:      2,
  MED_LOW:  3,
  MED:      4,
  MED_HIGH: 5,
  HIGH:     6,
  TURBO:    6,
};

const TIMEOUTS = {
  HTTP:        10000,
  IOT_SHADOW:   6000,
  HOMEKIT_GET:  5000,
};

module.exports = (homebridge) => {
  homebridge.registerPlatform('homebridge-tcl-split-ac', 'TclHome', TclHomePlatform);
};

// ─────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ
// ─────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout: ${label} (${ms}ms)`)), ms)
  );
  return Promise.race([promise, timeout]);
}

function errMsg(e) {
  return e?.message || e?.code || (typeof e === 'string' ? e : JSON.stringify(e)) || 'unknown error';
}

// ─────────────────────────────────────────────
// ПЛАТФОРМА
// ─────────────────────────────────────────────
class TclHomePlatform {
  constructor(log, config, api) {
    this.log         = log;
    this.config      = config;
    this.api         = api;
    this.accessories = [];

    if (!config?.username || !config?.password) {
      this.log.error('❌ Username and password are required in config');
      return;
    }

    this.tclApi = new TclHomeApi({
      username:    config.username,
      password:    config.password,
      appLoginUrl: config.appLoginUrl || 'https://pa.account.tcl.com/account/login?clientId=54148614',
      cloudUrls:   config.cloudUrls   || 'https://prod-center.aws.tcljd.com/v3/global/cloud_url_get',
      appId:       config.appId       || 'wx6e1af3fa84fbe523',
      debugMode:   config.debugMode   || false,
      log:         this.log,
    });

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  async discoverDevices() {
    const MAX_RETRIES = 5;
    const RETRY_DELAY = 15000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.log.info('🔍 Discovering TCL devices...');
        await this.tclApi.initialize();
        const devices = await this.tclApi.getDevices();
        this.log.info(`✅ Found ${devices.length} device(s)`);
        for (const device of devices) {
          if (device.category === 'AC') this.addAccessory(device);
        }
        return;
      } catch (err) {
        this.log.warn(`⚠️ discoverDevices attempt ${attempt}/${MAX_RETRIES}: ${errMsg(err)}`);
        if (attempt < MAX_RETRIES) {
          this.log.info(`⏳ Retrying in ${RETRY_DELAY / 1000}s...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
        } else {
          this.log.error('❌ discoverDevices failed after all retries. Restart Homebridge manually.');
        }
      }
    }
  }

  addAccessory(device) {
    const uuid     = this.api.hap.uuid.generate(device.deviceId);
    const existing = this.accessories.find(a => a.UUID === uuid);

    if (existing) {
      // Защита от дублирования startPolling при повторном discoverDevices
      if (!existing._acInitialized) {
        existing._acInitialized = true;
        new TclAirConditioner(this, existing, device);
      } else {
        this.log.info(`♻️ ${device.deviceName} already initialized, skipping`);
      }
    } else {
      const acc = new this.api.platformAccessory(device.deviceName, uuid);
      acc._acInitialized = true;
      new TclAirConditioner(this, acc, device);
      this.api.registerPlatformAccessories('homebridge-tcl-split-ac', 'TclHome', [acc]);
      this.accessories.push(acc);
    }
  }

  configureAccessory(acc) {
    this.accessories.push(acc);
  }
}

// ─────────────────────────────────────────────
// TCL API
// ─────────────────────────────────────────────
class TclHomeApi {
  constructor(config) {
    Object.assign(this, config);
    this.authData            = null;
    this.cloudUrlsData       = null;
    this.refreshTokensData   = null;
    this.awsCredentials      = null;
    this.iotData             = null;
    this.stateCache          = {};
    this.lastCall            = {};
    this.authRetry           = 0;
    this.maxAuthRetry        = 3;
    this._reAuthInProgress   = false;
    this._reAuthPromise      = null;  // единый Promise — защита от параллельных reAuth
    this._credRefreshStarted = false;
  }

  dbg(msg, ...a) { if (this.debugMode) this.log.info(`[DBG] ${msg}`, ...a); }

  async initialize() {
    this.log.info('🔐 Authenticating...');
    await this.authenticate();
    await this.fetchCloudUrls();
    await this.refreshTokens();
    await this.fetchAwsCredentials();
    this.setupIot();
    this.log.info('✅ TCL API ready');
  }

  async authenticate() {
    const passHash = crypto.createHash('md5').update(this.password).digest('hex');
    const resp = await withTimeout(
      axios.post(this.appLoginUrl, {
        equipment: 2, password: passHash, osType: 1,
        username: this.username, clientVersion: '4.8.1',
        osVersion: '6.0', deviceModel: 'AndroidAndroid SDK built for x86',
        captchaRule: 2, channel: 'app',
      }, {
        timeout: TIMEOUTS.HTTP,
        headers: {
          'th_platform': 'android', 'th_version': '4.8.1',
          'th_appbulid': '830', 'user-agent': 'Android',
          'content-type': 'application/json; charset=UTF-8',
        },
      }),
      TIMEOUTS.HTTP, 'authenticate'
    );
    if (resp.data.status !== 1) throw new Error('Auth failed: ' + resp.data.msg);
    this.authData  = resp.data;
    this.authRetry = 0;
    this.log.info('✅ Authenticated');
  }

  async fetchCloudUrls() {
    const resp = await withTimeout(
      axios.post(this.cloudUrls, {
        ssoId:    this.authData.user.username,
        ssoToken: this.authData.token,
      }, {
        timeout: TIMEOUTS.HTTP,
        headers: { 'user-agent': 'Android', 'content-type': 'application/json; charset=UTF-8' },
      }),
      TIMEOUTS.HTTP, 'fetchCloudUrls'
    );
    this.cloudUrlsData = resp.data;
  }

  async refreshTokens() {
    const url  = `${this.cloudUrlsData.data.cloud_url}/v3/auth/refresh_tokens`;
    const resp = await withTimeout(
      axios.post(url, {
        userId:   this.authData.user.username,
        ssoToken: this.authData.token,
        appId:    this.appId,
      }, {
        timeout: TIMEOUTS.HTTP,
        headers: { 'user-agent': 'Android', 'content-type': 'application/json; charset=UTF-8' },
      }),
      TIMEOUTS.HTTP, 'refreshTokens'
    );
    this.refreshTokensData = resp.data;
  }

  async fetchAwsCredentials() {
    // Обновляем cognitoToken перед получением AWS ключей
    // Вызывается только из refreshCredentials() — не из initialize()
    // чтобы не делать двойной refreshTokens при полной инициализации
    const region  = this.cloudUrlsData.data.cloud_region;

    // Защита от невалидного JWT
    const decoded = jwt.decode(this.refreshTokensData.data.cognitoToken);
    if (!decoded?.sub) throw new Error('Invalid cognitoToken: failed to decode JWT');

    const resp = await withTimeout(
      axios.post(
        `https://cognito-identity.${region}.amazonaws.com/`,
        {
          IdentityId: decoded.sub,
          Logins: { 'cognito-identity.amazonaws.com': this.refreshTokensData.data.cognitoToken },
        },
        {
          timeout: TIMEOUTS.HTTP,
          headers: {
            'User-agent': 'aws-sdk-android/2.22.6 Linux/6.1.23 Dalvik/2.1.0/0 en_US',
            'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity',
            'content-type': 'application/x-amz-json-1.1',
          },
        }
      ),
      TIMEOUTS.HTTP, 'fetchAwsCredentials'
    );
    this.awsCredentials = resp.data;
    this.log.info('✅ AWS credentials OK');
  }

  setupIot() {
    const region = this.cloudUrlsData.data.cloud_region;
    const creds  = this.awsCredentials.Credentials;

    // AWS Cognito возвращает SecretKey, AWS SDK ожидает secretAccessKey
    // Поддерживаем оба варианта поля на случай изменений в API
    const secretKey = creds.SecretAccessKey || creds.SecretKey;

    if (!creds.AccessKeyId || !secretKey || !creds.SessionToken) {
      this.log.error('❌ setupIot: missing credentials fields:', JSON.stringify(Object.keys(creds)));
      throw new Error('Invalid AWS credentials structure');
    }

    this.dbg('🔑 Credentials fields:', Object.keys(creds).join(', '));

    this.iotData = new AWS.IotData({
      endpoint:        `https://data-ats.iot.${region}.amazonaws.com`,
      accessKeyId:     creds.AccessKeyId,
      secretAccessKey: secretKey,
      sessionToken:    creds.SessionToken,
      region,
      maxRetries:      0,                                    // retry только наш, не SDK
      httpOptions:     { timeout: 5000, connectTimeout: 3000, agent: keepAliveAgent },
    });
    this.log.info('✅ AWS IoT ready');
  }

  async getDevices() {
    const url       = `${this.cloudUrlsData.data.device_url}/v3/user/get_things`;
    const timestamp = Date.now().toString();
    const nonce     = Math.random().toString(36).substr(2, 16);
    const sign      = this.md5(timestamp + nonce + this.refreshTokensData.data.saasToken);
    const resp      = await withTimeout(
      axios.post(url, {}, {
        timeout: TIMEOUTS.HTTP,
        headers: {
          platform: 'android', appversion: '5.4.1', thomeversion: '4.8.1',
          accesstoken: this.refreshTokensData.data.saasToken,
          countrycode: this.authData.user.countryAbbr,
          'accept-language': 'en', timestamp, nonce, sign,
          'user-agent': 'Android', 'content-type': 'application/json; charset=UTF-8',
        },
      }),
      TIMEOUTS.HTTP, 'getDevices'
    );
    return resp.data.data || [];
  }

  async getDeviceState(deviceId, force = false) {
    const now = Date.now();

    // Дебаунс: не дёргаем AWS чаще 200мс
    if (!force && this.lastCall[deviceId] && now - this.lastCall[deviceId] < 200) {
      return this.stateCache[deviceId] || this.defaultState();
    }
    this.lastCall[deviceId] = now;

    // Ждём reAuth если он идёт — не шлём запросы с мёртвыми credentials
    if (this._reAuthInProgress && this._reAuthPromise) {
      this.dbg('⏳ Waiting for reAuth before reading shadow...');
      try { await this._reAuthPromise; } catch (_) {}
      force = true;
    }

    if (!this.iotData) return this.stateCache[deviceId] || this.defaultState();

    try {
      const result = await withTimeout(
        this.iotData.getThingShadow({ thingName: deviceId }).promise(),
        TIMEOUTS.IOT_SHADOW, 'getThingShadow'
      );
      const shadow = JSON.parse(result.payload.toString());
      const rep    = shadow.state?.reported || {};

      const state = {
        powerSwitch:        rep.powerSwitch         ?? 0,
        workMode:           rep.workMode            ?? MODE.COOL,
        windSpeed:          rep.windSpeed           ?? WIND.AUTO,
        targetTemperature:  rep.targetCelsiusDegree ?? rep.targetTemperature ?? 22,
        currentTemperature: rep.currentTemperature,  // undefined = нет данных с датчика
        minTemp:            rep.lowerTemperatureLimit ?? 16,
        maxTemp:            rep.upperTemperatureLimit ?? 31,
        isOnline:           true,
        lastUpdated:        now,
      };

      this.dbg(`📊 ${deviceId}: power=${state.powerSwitch} mode=${state.workMode} wind=${state.windSpeed} target=${state.targetTemperature}°C room=${state.currentTemperature ?? '?'}°C`);
      this.stateCache[deviceId] = state;
      return state;

    } catch (err) {
      this.dbg('⚠️ Shadow read failed:', errMsg(err));
      const cached = this.stateCache[deviceId];
      if (cached && now - cached.lastUpdated > 30000) {
        delete this.stateCache[deviceId];
        return this.defaultState();
      }
      return cached || this.defaultState();
    }
  }

  defaultState() {
    return {
      powerSwitch: 0, workMode: MODE.COOL, windSpeed: WIND.AUTO,
      targetTemperature: 22, currentTemperature: undefined,
      minTemp: 16, maxTemp: 31, isOnline: false, lastUpdated: Date.now(),
    };
  }

  async sendCommand(deviceId, props) {
    if (!this.iotData) { this.log.error('❌ IoT not initialized'); return false; }

    // Ждём reAuth перед отправкой команды
    if (this._reAuthInProgress && this._reAuthPromise) {
      this.log.info('⏳ Waiting for reAuth before sending command...');
      try { await this._reAuthPromise; } catch (_) {}
    }

    const topic   = `$aws/things/${deviceId}/shadow/update`;
    const payload = JSON.stringify({ state: { desired: props }, clientToken: `hb_${Date.now()}` });
    this.log.info(`📡 → ${deviceId}: ${JSON.stringify(props)}`);

    // Один уровень retry — 2 попытки, короткий таймаут каждая
    const MAX_ATTEMPTS = 2;
    const PUBLISH_TIMEOUT = 4000;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await withTimeout(
          this.iotData.publish({ topic, payload, qos: 0 }).promise(),
          PUBLISH_TIMEOUT, 'publish'
        );

        // Оптимистично обновляем кэш
        if (this.stateCache[deviceId]) {
          Object.assign(this.stateCache[deviceId], props);
          if (props.targetCelsiusDegree !== undefined)
            this.stateCache[deviceId].targetTemperature = props.targetCelsiusDegree;
        }

        this.log.info(`✅ Command sent (attempt ${attempt})`);
        return true;

      } catch (err) {
        const msg = errMsg(err);
        this.log.warn(`⚠️ Publish attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`);

        if (msg.includes('Forbidden') || msg.includes('expired') || msg.includes('InvalidToken')) {
          this.log.warn('🔄 Credentials expired, triggering reAuth...');
          await this.reAuth();
          return false;
        }
        // без задержки между попытками — keep-alive соединение уже установлено
      }
    }

    this.log.error('❌ Publish failed after all attempts');
    return false;
  }

  // Единый Promise — параллельные вызовы reAuth получают один и тот же
  reAuth() {
    if (this._reAuthPromise) {
      this.dbg('ℹ️ reAuth already in progress, reusing promise');
      return this._reAuthPromise;
    }

    this._reAuthPromise = this._doReAuth().finally(() => {
      this._reAuthPromise    = null;
      this._reAuthInProgress = false;
    });

    return this._reAuthPromise;
  }

  async _doReAuth() {
    if (this.authRetry >= this.maxAuthRetry) {
      this.log.error('❌ Max re-auth attempts reached. Will retry on next poll error.');
      this.authRetry = 0;
      return;
    }
    this.authRetry++;
    this._reAuthInProgress = true;
    this.log.info(`🔄 Re-auth attempt ${this.authRetry}/${this.maxAuthRetry}`);

    const MAX_RETRIES = 3;
    const RETRY_DELAY = 20000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.initialize();
        this.authRetry = 0;
        this.log.info('✅ Re-auth successful');
        return;
      } catch (err) {
        const msg = errMsg(err);
        this.log.error(`❌ Re-auth attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
        if (attempt < MAX_RETRIES) {
          this.log.info(`⏳ Retrying in ${RETRY_DELAY / 1000}s...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
        }
      }
    }
    this.log.error('❌ Re-auth failed after all retries. Will retry on next poll cycle.');
  }

  // Обновление только AWS части каждые 50 минут
  // refreshTokens вызывается один раз здесь — не дублируется
  async refreshCredentials() {
    this.log.info('🔑 Refreshing AWS credentials...');
    try {
      await this.refreshTokens();       // обновляем cognitoToken
      await this.fetchAwsCredentials(); // получаем новые AWS ключи
      this.setupIot();                  // пересоздаём IoT клиент
      this.log.info('✅ AWS credentials refreshed');
    } catch (err) {
      this.log.error('❌ Credentials refresh failed:', errMsg(err));
      await this.reAuth(); // fallback: полный re-initialize
    }
  }

  md5(input) {
    const hash = crypto.createHash('md5').update(input, 'utf8').digest();
    return Array.from(hash).map(b => ((b & 0xFF) < 16 ? '0' : '') + (b & 0xFF).toString(16)).join('');
  }
}

// ─────────────────────────────────────────────
// КОНДИЦИОНЕР (HomeKit аксессуар)
// ─────────────────────────────────────────────
class TclAirConditioner {
  constructor(platform, accessory, device) {
    this.platform  = platform;
    this.accessory = accessory;
    this.device    = device;
    this.log       = platform.log;
    this.api       = platform.tclApi;
    this.hap       = platform.api.hap;

    this._lastMode      = MODE.COOL;
    this._lastWindSpeed = WIND.AUTO;
    this._minTemp       = 16;
    this._maxTemp       = 31;
    this._errCount      = 0;
    this._lastOkPoll    = Date.now();
    this._lastStateKey  = '';
    this._lastKnownTemp = undefined;

    // Очередь команд — последовательная отправка + защита от дублей
    this.commandQueue     = Promise.resolve();
    this._lastCommandKey  = null;
    this._lastCommandTime = 0;

    this.setupAccessoryInfo();
    this.setupThermostat();
    this.removeLegacyServices();
    this.setupFanSpeedControl();
    this.startPolling();

    this.log.info(`🏠 ${device.deviceName} ready (TAC-BR12INV | Cool/Heat/Auto | 16-31°C | 8 fan speeds)`);
  }

  setupAccessoryInfo() {
    this.accessory
      .getService(this.hap.Service.AccessoryInformation)
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'TCL')
      .setCharacteristic(this.hap.Characteristic.Model, 'TAC-BR12INV')
      .setCharacteristic(this.hap.Characteristic.SerialNumber, this.device.deviceId)
      .setCharacteristic(this.hap.Characteristic.FirmwareRevision, this.device.firmwareVersion || '1.0.0');
  }

  setupThermostat() {
    const C = this.hap.Characteristic;
    this.thermo = this.accessory.getService(this.hap.Service.Thermostat)
               || this.accessory.addService(this.hap.Service.Thermostat);
    this.thermo.setCharacteristic(C.Name, this.device.deviceName);

    this.thermo.getCharacteristic(C.CurrentHeatingCoolingState)
      .onGet(this.getCurrentMode.bind(this));

    this.thermo.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: [
        C.TargetHeatingCoolingState.OFF,
        C.TargetHeatingCoolingState.COOL,
        C.TargetHeatingCoolingState.HEAT,
        C.TargetHeatingCoolingState.AUTO,
      ]})
      .onGet(this.getTargetMode.bind(this))
      .onSet(this.setTargetMode.bind(this));

    this.thermo.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(this.getCurrentTemp.bind(this));

    this.thermo.getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: 16, maxValue: 31, minStep: 1 })
      .onGet(this.getTargetTemp.bind(this))
      .onSet(this.setTargetTemp.bind(this));

    this.thermo.getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(() => C.TemperatureDisplayUnits.CELSIUS);
  }

  removeLegacyServices() {
    const names = ['Sleep Mode', 'Fan Speed', 'Fan Mode', 'Cool Fan Speed', 'AC Fan', 'Fan Speed Control'];
    for (const name of names) {
      const svc = this.accessory.getService(name);
      if (svc) {
        this.accessory.removeService(svc);
        this.log.info(`🗑️ Removed legacy service: ${name}`);
      }
    }
  }

  setupFanSpeedControl() {
    const C = this.hap.Characteristic;
    this.fanSvc = this.accessory.getService('Fan Speed Control')
               || this.accessory.addService(this.hap.Service.Fan, 'Fan Speed Control', 'fanSpeedControl');

    this.fanSvc.getCharacteristic(C.On)
      .onGet(this.getFanActive.bind(this))
      .onSet(this.setFanActive.bind(this));

    this.fanSvc.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 12.5 })
      .onGet(this.getFanSpeed.bind(this))
      .onSet(this.setFanSpeed.bind(this));
  }

  // ─────────────────────────────────────────────
  // ГЕТТЕРЫ — читают из кэша, поллинг держит его свежим
  // ─────────────────────────────────────────────
  async getCurrentMode() {
    try {
      const s = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getCurrentMode'
      );
      if (!s.powerSwitch) return this.hap.Characteristic.CurrentHeatingCoolingState.OFF;
      return s.workMode === MODE.HEAT
        ? this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
        : this.hap.Characteristic.CurrentHeatingCoolingState.COOL;
    } catch (e) { return this.hap.Characteristic.CurrentHeatingCoolingState.OFF; }
  }

  async getTargetMode() {
    try {
      const s = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getTargetMode'
      );
      if (!s.powerSwitch) return this.hap.Characteristic.TargetHeatingCoolingState.OFF;
      return this.workModeToHk(s.workMode);
    } catch (e) { return this.hap.Characteristic.TargetHeatingCoolingState.OFF; }
  }

  async getCurrentTemp() {
    try {
      const s = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getCurrentTemp'
      );
      if (s.currentTemperature !== undefined) {
        this._lastKnownTemp = s.currentTemperature;
        return s.currentTemperature;
      }
      // null запрещён в HomeKit — возвращаем последнее известное или 0 как минимально безопасное
      return this._lastKnownTemp ?? 0;
    } catch (e) {
      return this._lastKnownTemp ?? 0;
    }
  }

  async getTargetTemp() {
    try {
      const s = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getTargetTemp'
      );
      return s.targetTemperature ?? 22;
    } catch (e) { return 22; }
  }

  async getFanActive() {
    try {
      const s = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getFanActive'
      );
      return s.powerSwitch === 1;
    } catch (e) { return false; }
  }

  async getFanSpeed() {
    try {
      const s = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getFanSpeed'
      );
      if (!s.powerSwitch) return 0;
      return this.windToPercent(s.windSpeed);
    } catch (e) { return 0; }
  }

  // ─────────────────────────────────────────────
  // ОЧЕРЕДЬ КОМАНД
  // Предотвращает спам при быстрых нажатиях в HomeKit.
  // Сбрасываем ссылку после выполнения чтобы не копить Promise-цепочку.
  // ─────────────────────────────────────────────
  queueCommand(props, ctx) {
    // Защита от дублей — HomeKit иногда присылает одну команду дважды подряд
    const commandKey = JSON.stringify(props);
    if (this._lastCommandKey === commandKey &&
        Date.now() - this._lastCommandTime < 3000) {
      this.log.info(`⏭️ Duplicate command skipped: ${ctx}`);
      return Promise.resolve(true);
    }
    this._lastCommandKey  = commandKey;
    this._lastCommandTime = Date.now();

    // Без искусственной задержки — keep-alive держит соединение готовым.
    // Очередь нужна только чтобы не отправлять параллельно несколько publish.
    const next = this.commandQueue
      .then(() => this.sendOnce(props, ctx))
      .catch(e => this.log.error(`❌ Command queue error (${ctx}):`, errMsg(e)));

    this.commandQueue = next.then(() => {}, () => {});
    return next;
  }

  // Один уровень — retry уже реализован внутри api.sendCommand (2 попытки)
  async sendOnce(props, ctx) {
    const ok = await this.api.sendCommand(this.device.deviceId, props);
    if (ok) {
      // Читаем актуальное состояние через 1.2 сек после команды
      setTimeout(async () => {
        try {
          const ns = await this.api.getDeviceState(this.device.deviceId, true);
          if (ns) this.updateFromState(ns);
        } catch (e) {}
      }, 1200);
      return true;
    }
    this.log.error(`❌ ${ctx} failed`);
    return false;
  }

  // ─────────────────────────────────────────────
  // СЕТТЕРЫ — все обёрнуты в try/catch
  // ─────────────────────────────────────────────
  async setTargetMode(value) {
    const C         = this.hap.Characteristic;
    const modeNames = ['OFF', 'COOL', 'HEAT', 'AUTO'];
    try {
      this.log.info(`🎯 setTargetMode → ${modeNames[value] ?? value}`);
      const cur  = this.api.stateCache[this.device.deviceId] || this.api.defaultState();
      const temp = cur.targetTemperature ?? 22;
      const wind = cur.windSpeed         ?? this._lastWindSpeed;
      let props;

      switch (value) {
        case C.TargetHeatingCoolingState.OFF:
          props = { powerSwitch: 0 };
          break;
        case C.TargetHeatingCoolingState.HEAT:
          this._lastMode = MODE.HEAT;
          props = { powerSwitch: 1, workMode: MODE.HEAT, windSpeed: wind,
                    targetCelsiusDegree: temp, targetTemperature: temp,
                    ECO: 0, sleep: 0, turbo: 0, silenceSwitch: 0 };
          break;
        case C.TargetHeatingCoolingState.AUTO:
          this._lastMode = MODE.AUTO;
          props = { powerSwitch: 1, workMode: MODE.AUTO, windSpeed: wind,
                    targetCelsiusDegree: temp, targetTemperature: temp,
                    ECO: 0, sleep: 0, turbo: 0, silenceSwitch: 0 };
          break;
        case C.TargetHeatingCoolingState.COOL:
        default:
          this._lastMode = MODE.COOL;
          props = { powerSwitch: 1, workMode: MODE.COOL, windSpeed: wind,
                    targetCelsiusDegree: temp, targetTemperature: temp,
                    ECO: 0, sleep: 0, turbo: 0, silenceSwitch: 0 };
          break;
      }
      await this.queueCommand(props, 'setTargetMode');
    } catch (e) {
      this.log.error('❌ setTargetMode:', errMsg(e));
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setTargetTemp(value) {
    try {
      const temp = Math.max(this._minTemp, Math.min(this._maxTemp, Math.round(value)));
      const cur  = this.api.stateCache[this.device.deviceId] || this.api.defaultState();
      this.log.info(`🌡️ setTargetTemp → ${temp}°C (power=${cur.powerSwitch}, mode=${cur.workMode})`);

      let props;
      if (!cur.powerSwitch) {
        props = { powerSwitch: 1, workMode: this._lastMode, windSpeed: this._lastWindSpeed,
                  targetCelsiusDegree: temp, targetTemperature: temp };
      } else {
        props = { targetCelsiusDegree: temp, targetTemperature: temp };
      }

      await this.queueCommand(props, 'setTargetTemp');
      this.thermo.getCharacteristic(this.hap.Characteristic.TargetTemperature).updateValue(temp);
    } catch (e) {
      this.log.error('❌ setTargetTemp:', errMsg(e));
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setFanActive(value) {
    try {
      this.log.info(`💨 setFanActive → ${value ? 'ON' : 'OFF'}`);
      if (!value) {
        await this.queueCommand({ powerSwitch: 0 }, 'setFanActive:off');
      } else {
        const cur = this.api.stateCache[this.device.deviceId] || this.api.defaultState();
        if (!cur.powerSwitch) {
          await this.queueCommand(
            { powerSwitch: 1, workMode: this._lastMode, windSpeed: this._lastWindSpeed },
            'setFanActive:on'
          );
        }
      }
    } catch (e) {
      this.log.error('❌ setFanActive:', errMsg(e));
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setFanSpeed(value) {
    try {
      const wind          = this.percentToWind(value);
      this._lastWindSpeed = wind;
      const cur           = this.api.stateCache[this.device.deviceId] || this.api.defaultState();
      const windNames     = { 0:'Авто', 2:'Бесшумный', 3:'Ниже средней', 4:'Средняя', 5:'Выше средней', 6:'Высокая' };
      this.log.info(`💨 setFanSpeed → ${value}% → wind=${wind} (${windNames[wind]}) | power=${cur.powerSwitch}`);
      if (!cur.powerSwitch) { this.log.info('💨 Device is off, speed saved for next start'); return; }
      await this.queueCommand({ windSpeed: wind }, 'setFanSpeed');
    } catch (e) {
      this.log.error('❌ setFanSpeed:', errMsg(e));
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ─────────────────────────────────────────────
  // ОБНОВЛЕНИЕ HOMEKIT
  // ─────────────────────────────────────────────
  updateFromState(s) {
    const key = `${s.powerSwitch}-${s.workMode}-${s.windSpeed}-${s.currentTemperature}-${s.targetTemperature}`;
    if (key === this._lastStateKey) return;
    this._lastStateKey = key;

    this.log.info(`📈 power=${s.powerSwitch} mode=${s.workMode} wind=${s.windSpeed} room=${s.currentTemperature ?? '?'}°C target=${s.targetTemperature}°C`);

    if (s.powerSwitch && s.workMode !== undefined) this._lastMode      = s.workMode;
    if (s.windSpeed  !== undefined)                this._lastWindSpeed = s.windSpeed;
    if (s.minTemp)                                 this._minTemp       = s.minTemp;
    if (s.maxTemp)                                 this._maxTemp       = s.maxTemp;

    const C = this.hap.Characteristic;

    // Температура: только реальные значения, никогда не заглушки
    if (s.currentTemperature !== undefined) {
      this._lastKnownTemp = s.currentTemperature;
      this.thermo.updateCharacteristic(C.CurrentTemperature, s.currentTemperature);
    } else if (this._lastKnownTemp !== undefined && this._lastKnownTemp !== null) {
      this.thermo.updateCharacteristic(C.CurrentTemperature, this._lastKnownTemp);
    }
    // Если нет вообще никаких данных — не вызываем updateCharacteristic
    // HomeKit будет показывать последнее кэшированное значение

    if (s.targetTemperature !== undefined)
      this.thermo.updateCharacteristic(C.TargetTemperature, s.targetTemperature);

    const curMode = !s.powerSwitch
      ? C.CurrentHeatingCoolingState.OFF
      : s.workMode === MODE.HEAT
        ? C.CurrentHeatingCoolingState.HEAT
        : C.CurrentHeatingCoolingState.COOL;

    const tgtMode = !s.powerSwitch
      ? C.TargetHeatingCoolingState.OFF
      : this.workModeToHk(s.workMode);

    this.thermo.updateCharacteristic(C.CurrentHeatingCoolingState, curMode);
    this.thermo.updateCharacteristic(C.TargetHeatingCoolingState, tgtMode);
    this.fanSvc.updateCharacteristic(C.On, s.powerSwitch === 1);
    this.fanSvc.updateCharacteristic(C.RotationSpeed, s.powerSwitch ? this.windToPercent(s.windSpeed) : 0);
  }

  // ─────────────────────────────────────────────
  // ВСПОМОГАТЕЛЬНЫЕ
  // ─────────────────────────────────────────────
  workModeToHk(workMode) {
    const C = this.hap.Characteristic;
    switch (workMode) {
      case MODE.COOL: return C.TargetHeatingCoolingState.COOL;
      case MODE.HEAT: return C.TargetHeatingCoolingState.HEAT;
      case MODE.AUTO: return C.TargetHeatingCoolingState.AUTO;
      default:        return C.TargetHeatingCoolingState.COOL;
    }
  }

  windToPercent(wind) {
    switch (wind) {
      case 0: return 0;
      case 2: return 12.5;
      case 3: return 37.5;
      case 4: return 50;
      case 5: return 62.5;
      case 6: return 87.5;
      default: return 0;
    }
  }

  percentToWind(pct) {
    if (pct <= 0)    return 0;
    if (pct <= 25)   return 2;
    if (pct <= 37.5) return 3;
    if (pct <= 50)   return 4;
    if (pct <= 62.5) return 5;
    return 6;
  }

  // ─────────────────────────────────────────────
  // ПОЛЛИНГ
  // ─────────────────────────────────────────────
  startPolling() {
    // Основной поллинг каждые 3 секунды
    setInterval(async () => {
      try {
        const force = Date.now() - this._lastOkPoll > 10000;
        const s     = await this.api.getDeviceState(this.device.deviceId, force);
        if (s) {
          this._errCount   = 0;
          this._lastOkPoll = Date.now();
          this.updateFromState(s);
        }
      } catch (err) {
        this._errCount++;
        const msg       = errMsg(err);
        // Реагируем на Forbidden сразу, не ждём трёх ошибок
        const isAuthErr = msg.includes('Forbidden') || msg.includes('expired') || msg.includes('InvalidToken');
        if (isAuthErr || this._errCount >= 3) {
          this.log.warn('🔄 Re-authenticating...');
          this._errCount = 0;
          await this.api.reAuth();
        }
      }
    }, 3000).unref();

    // Инвалидация кэша каждые 45 сек
    setInterval(() => {
      const cached = this.api.stateCache[this.device.deviceId];
      if (cached && Date.now() - cached.lastUpdated > 45000) {
        delete this.api.stateCache[this.device.deviceId];
        this.api.dbg('🗑️ Cache cleared');
      }
    }, 30000).unref();

    // Обновление AWS credentials каждые 50 минут
    if (!this.api._credRefreshStarted) {
      this.api._credRefreshStarted = true;
      setInterval(() => this.api.refreshCredentials(), 50 * 60 * 1000).unref();
      this.log.info('⏱️ AWS credentials auto-refresh scheduled every 50 min');
    }
  }
}
