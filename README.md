# homebridge-tcl-split-ac

[![npm version](https://img.shields.io/npm/v/homebridge-tcl-split-ac.svg)](https://www.npmjs.com/package/homebridge-tcl-split-ac)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-tcl-split-ac.svg)](https://www.npmjs.com/package/homebridge-tcl-split-ac)
[![Homebridge](https://img.shields.io/badge/homebridge-plugin-blueviolet)](https://github.com/homebridge/homebridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 🇬🇧 English

A [Homebridge](https://homebridge.io) plugin for controlling **TCL TAC-BR12INV** inverter split air conditioners via Apple HomeKit.

### Features

- ✅ Power on/off
- ✅ Set target temperature
- ✅ Switch modes: Auto, Cool, Heat, Fan, Dry
- ✅ Fan speed control
- ✅ Current temperature display
- ✅ Works with Siri and Apple Home app

### Requirements

- [Homebridge](https://homebridge.io) >= 1.3.0
- Node.js >= 14.0.0
- TCL TAC-BR12INV inverter air conditioner
- TCL Home app account (email + password)

### Installation

Install via Homebridge UI (recommended) — search for `homebridge-tcl-split-ac`.

Or install manually:

```bash
npm install -g homebridge-tcl-split-ac
```

### Configuration

Add the following to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "TclSplitAC",
      "name": "TCL Split AC",
      "email": "your@email.com",
      "password": "yourpassword",
      "deviceId": "your-device-id"
    }
  ]
}
```

| Parameter  | Type   | Required | Description                        |
|------------|--------|----------|------------------------------------|
| `platform` | string | ✅       | Must be `TclSplitAC`               |
| `name`     | string | ✅       | Display name in HomeKit            |
| `email`    | string | ✅       | Your TCL Home app email            |
| `password` | string | ✅       | Your TCL Home app password         |
| `deviceId` | string | ✅       | Device ID from TCL Home app        |

### Finding Your Device ID

1. Open the **TCL Home** app
2. Go to your AC device settings
3. Look for Device Info / Device ID

### Supported Models

This plugin was developed and tested with the **TCL TAC-BR12INV**. Other TCL inverter models using the same TCL Home cloud platform may also work.

### Troubleshooting

- Make sure your TCL Home account credentials are correct
- Ensure the AC is connected to Wi-Fi and visible in the TCL Home app
- Check Homebridge logs for detailed error messages

---

## 🇷🇺 Русский

Плагин для [Homebridge](https://homebridge.io), позволяющий управлять **TCL TAC-BR12INV** инверторным кондиционером через Apple HomeKit.

### Возможности

- ✅ Включение/выключение
- ✅ Установка целевой температуры
- ✅ Переключение режимов: Авто, Охлаждение, Обогрев, Вентилятор, Осушение
- ✅ Управление скоростью вентилятора
- ✅ Отображение текущей температуры
- ✅ Работает с Siri и приложением Apple Дом

### Требования

- [Homebridge](https://homebridge.io) >= 1.3.0
- Node.js >= 14.0.0
- Кондиционер TCL TAC-BR12INV
- Аккаунт в приложении TCL Home (email + пароль)

### Установка

Установите через Homebridge UI (рекомендуется) — найдите `homebridge-tcl-split-ac`.

Или установите вручную:

```bash
npm install -g homebridge-tcl-split-ac
```

### Настройка

Добавьте следующее в файл `config.json` Homebridge:

```json
{
  "platforms": [
    {
      "platform": "TclSplitAC",
      "name": "TCL Split AC",
      "email": "your@email.com",
      "password": "yourpassword",
      "deviceId": "your-device-id"
    }
  ]
}
```

| Параметр   | Тип    | Обязательный | Описание                              |
|------------|--------|--------------|---------------------------------------|
| `platform` | string | ✅           | Должно быть `TclSplitAC`             |
| `name`     | string | ✅           | Отображаемое имя в HomeKit            |
| `email`    | string | ✅           | Email от приложения TCL Home          |
| `password` | string | ✅           | Пароль от приложения TCL Home         |
| `deviceId` | string | ✅           | ID устройства из приложения TCL Home  |

### Как найти Device ID

1. Откройте приложение **TCL Home**
2. Перейдите в настройки вашего кондиционера
3. Найдите раздел "Информация об устройстве" / Device ID

### Поддерживаемые модели

Плагин разработан и протестирован на **TCL TAC-BR12INV**. Другие инверторные модели TCL, использующие ту же облачную платформу TCL Home, также могут работать.

### Устранение неполадок

- Убедитесь, что данные аккаунта TCL Home введены верно
- Проверьте, что кондиционер подключён к Wi-Fi и отображается в приложении TCL Home
- Просмотрите логи Homebridge для получения подробной информации об ошибках

---

## 💛 Support / Поддержка

If this plugin is useful to you, consider buying me a coffee!

Если плагин оказался полезным — буду рад вашей поддержке!

[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://www.paypal.me/askarkurymbayev)

👉 [paypal.me/askarkurymbayev](https://www.paypal.me/askarkurymbayev)

---

## License / Лицензия

[MIT](LICENSE) © Askar Kurymbayev
