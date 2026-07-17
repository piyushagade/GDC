const { SerialPort } = require('serialport');
const { DelimiterParser } = require('@serialport/parser-delimiter');
const fs = require('fs');
const cobs = require('cobs');
const crc32 = require('buffer-crc32');
const $ = require('jquery');
const { send } = require('process');
const { ipcRenderer } = require('electron');

const CRC_PROTECTION = false;
const BAUD_RATE = 115200;

// Packet Type Definitions (Match your Arduino #defines)
const TYPES = {
    CMD: 0x01,
    MSG: 0x02,
    FILE: 0x03,
    ACK: 0x04,
    NACK: 0x05,
    LOG: 0x06,
    PAYLOAD_STRING: 0x07,
    PAYLOAD_JSON: 0x08,
    PAYLOAD_BINARY: 0x09,
    REQUEST_ACK: 0x0A,
    HEARTBEAT: 0x0B
};

let port;
let reconnectTimeout = null;
let fileBuffer = null;
let receivedBytes = 0;
let CONTINUE_LINE = false;
let _lastSentType;
let _ackRequested = false;
let isLocked = false;

// Logger UI Elements
let heartbeatInterval;
let loggerDisplay;
let portSelect;
let msgInput;
let payloadInput;
let msgTypeSelect;

const DEFAULT_COMMANDS = ['ping', 'ec:calibrate', 'rtd:calibrate', 'ec:read', 'rtd:read', 'time:fetch', 'time:sync'];
const COMMAND_PAYLOADS = {
    'ec:calibrate': ['high,', 'low,', 'dry,0'],
    'rtd:calibrate': ['custom,25.0', 'custom,'],
    'ping': [''],
    'ec:read': ['1'],
    'rtd:read': ['1'],
    'time:fetch': [''],
    'time:sync': [moment().format('MM/DD/YYYY HH:mm:ss')],
};

function setupAutocomplete() {
    const datalist = $('#command-suggestions');
    let history = JSON.parse(localStorage.getItem('commandHistory') || '[]');
    const all = [...new Set([...DEFAULT_COMMANDS, ...history])];
    datalist.empty();
    all.forEach(cmd => {
        if (cmd) datalist.append($('<option>', { value: cmd }));
    });
}

function updatePayloadSuggestions(cmd) {
    const datalist = $('#payload-suggestions');
    datalist.empty();
    
    let suggestions = [];
    if (cmd === 'time:sync') {
        suggestions = [moment().format('MM/DD/YYYY HH:mm:ss')];
    } else {
        suggestions = COMMAND_PAYLOADS[cmd] || [];
    }

    suggestions.forEach(p => {
        datalist.append($('<option>', { value: p }));
    });
}

function updateCommandHistory(cmd) {
    if (!cmd || DEFAULT_COMMANDS.includes(cmd)) return;
    let history = JSON.parse(localStorage.getItem('commandHistory') || '[]');
    if (!history.includes(cmd)) {
        history.push(cmd);
        localStorage.setItem('commandHistory', JSON.stringify(history));
        setupAutocomplete();
    }
}

function setupLogger() {
    loggerDisplay = $('#logger-display');
    portSelect = $('#port-select');
    msgTypeSelect = $('#msg-type-select');
    msgInput = $('#msg-input');
    payloadInput = $('#payload-input');

    // Get saved localStorage items
    var savedCommand = localStorage.getItem(`/cmd/string`);
    var savedPayload = localStorage.getItem(`/cmd/payload`);
    msgInput.val(savedCommand);
    payloadInput.val(savedPayload);

    setupAutocomplete();
    updatePayloadSuggestions(msgInput.val());

    // Type Toggle Buttons
    $('#type-cmd-btn').on('click', () => {
        if (isLocked) return;
        $('#type-cmd-btn').addClass('active');
        $('#type-msg-btn').removeClass('active');
        msgTypeSelect.val('1');
    });

    $('#type-msg-btn').on('click', () => {
        if (isLocked) return;
        $('#type-msg-btn').addClass('active');
        $('#type-cmd-btn').removeClass('active');
        msgTypeSelect.val('2');
    });

    // Lock/Unlock Toggle Logic
    $('#lock-btn').on('click', () => {
        setConsoleLockState(!isLocked, true);
    });

    $('#refresh-btn').on('click', listPorts);
    msgInput.on('input', (e) => {
        updatePayloadSuggestions(msgInput.val());
    });
    payloadInput.on('focus', () => {
        if (msgInput.val() === 'time:sync') {
            updatePayloadSuggestions('time:sync');
        }
    });
    msgInput.on('keypress', (e) => {
        if (e.key === 'Enter') {
            localStorage.setItem(`/cmd/string`, msgInput.val());
            localStorage.setItem(`/cmd/payload`, payloadInput.val());
            sendFromUI();
        }
    });
    payloadInput.on('keypress', (e) => {
        if (e.key === 'Enter') {
            localStorage.setItem(`/cmd/string`, msgInput.val());
            localStorage.setItem(`/cmd/payload`, payloadInput.val());
            sendFromUI();
        }
    });
    $('#send-btn').on('click', sendFromUI);
    $('#disconnect-btn').on('click', toggleConnection);
    $('#ack-btn').on('click', toggleAck);
    $('#clear-btn').on('click', () => { if (loggerDisplay) loggerDisplay.empty(); });

    // Theme Toggle Logic: blue -> dark -> light
    const themeBtn = $('#theme-btn');
    let currentTheme = localStorage.getItem('theme') || 'blue';

    function applyTheme(theme) {
        $('body').removeClass('light-theme dark-theme');
        
        if (theme === 'dark') {
            $('body').addClass('dark-theme');
            themeBtn.html('<i class="fas fa-sun"></i>').attr('title', 'Switch to Light Theme');
        } else if (theme === 'light') {
            $('body').addClass('light-theme');
            themeBtn.html('<i class="fas fa-palette"></i>').attr('title', 'Switch to Blue Theme');
        } else {
            // Default: blue theme
            themeBtn.html('<i class="fas fa-moon"></i>').attr('title', 'Switch to Dark Theme');
        }
        
        currentTheme = theme;
        localStorage.setItem('theme', theme);
    }

    applyTheme(currentTheme);

    themeBtn.on('click', () => {
        if (currentTheme === 'blue') {
            applyTheme('dark');
            showOnUI('SYS', 'INFO', 'Switched to Dark Theme');
        } else if (currentTheme === 'dark') {
            applyTheme('light');
            showOnUI('SYS', 'INFO', 'Switched to Light Theme');
        } else {
            applyTheme('blue');
            showOnUI('SYS', 'INFO', 'Switched to Blue Theme');
        }
    });

    // Port Picker Popup Toggle
    $('#port-picker-btn').on('click', (e) => {
        e.stopPropagation();
        $('#port-popup').toggleClass('open');
    });

    $(document).on('click', (e) => {
        if (!$(e.target).closest('.port-picker-container').length) {
            $('#port-popup').removeClass('open');
        }
    });

    // Custom titlebar window control click handlers
    $('#window-minimize').on('click', () => {
        ipcRenderer.send('window-minimize');
    });

    $('#window-maximize').on('click', () => {
        ipcRenderer.send('window-maximize');
    });

    $('#window-close').on('click', () => {
        ipcRenderer.send('window-close');
    });

    // Listen to maximize state changes from main process
    ipcRenderer.on('window-maximized-state', (event, isMaximized) => {
        const icon = $('#window-maximize i');
        if (isMaximized) {
            icon.removeClass('fa-square').addClass('fa-copy');
            $('#window-maximize').attr('title', 'Restore');
        } else {
            icon.removeClass('fa-copy').addClass('fa-square');
            $('#window-maximize').attr('title', 'Maximize');
        }
    });

    // Tab switching logic
    $('.menu-tab').on('click', function() {
        const tabName = $(this).attr('data-tab');
        
        $('.menu-tab').removeClass('active');
        $(this).addClass('active');
        
        $('.tab-panel').removeClass('active');
        $(`#tab-${tabName}`).addClass('active');
    });

    // Menu action buttons logic
    $('.menu-action-btn').on('click', function() {
        const cmd = $(this).attr('data-cmd');
        let payload = $(this).attr('data-payload');
        const action = $(this).attr('data-action');

        if (action === 'request-file') {
            window.requestFile();
            return;
        }

        if (cmd) {
            let type = 0x01; // Default: CMD (0x01)
            let pType = 0x00; // Default: No payload
            
            if (payload === 'dynamic') {
                if (cmd === 'time:sync') {
                    payload = moment().utc().format('MM/DD/YYYY HH:mm:ss');
                }
            }

            if (payload && payload.trim().length > 0) {
                try {
                    if (typeof JSON.parse(payload) === 'object') pType = TYPES.PAYLOAD_JSON;
                    else pType = TYPES.PAYLOAD_STRING;
                } catch (e) {
                    pType = TYPES.PAYLOAD_STRING;
                }
            }

            sendAtomicPacket(type, cmd, pType, payload || "");
        }
    });

    // Filter Popup Toggle
    $('#filter-btn').on('click', (e) => {
        e.stopPropagation();
        $('#filter-popup').toggleClass('open');
    });

    // Close popups on outer click
    $(document).on('click', (e) => {
        if (!$(e.target).closest('.filter-picker-container').length) {
            $('#filter-popup').removeClass('open');
        }
    });

    // Filter change listeners
    $('#filter-show-time, .filter-dir-checkbox, .filter-type-checkbox').on('change', () => {
        saveFilters();
        applyFilters();
    });

    // Load filter states and apply them initially
    loadFilters();
    applyFilters();

    let pendingCalCmd = null;
    let pendingCalPrefix = null;

    // Calibration modal trigger
    $('.calibration-trigger-btn').on('click', function() {
        const cmd = $(this).attr('data-cmd');
        const prefix = $(this).attr('data-prefix');
        const defaultValue = $(this).attr('data-default');
        const unit = $(this).attr('data-unit');
        const title = $(this).attr('data-title');
        const desc = $(this).attr('data-desc');

        pendingCalCmd = cmd;
        pendingCalPrefix = prefix;

        $('#cal-modal-title').text(title);
        $('#cal-modal-desc').text(desc);
        $('#cal-modal-input').val(defaultValue);
        $('#cal-modal-unit').text(unit);

        $('#calibration-modal').addClass('open');
        setTimeout(() => $('#cal-modal-input').focus(), 50);
    });

    // Close modal actions
    $('#cal-modal-close, #cal-modal-cancel, #calibration-modal').on('click', function(e) {
        if (e.target === this || $(e.target).closest('.modal-card').length === 0 || this.id === 'cal-modal-close' || this.id === 'cal-modal-cancel') {
            $('#calibration-modal').removeClass('open');
            pendingCalCmd = null;
            pendingCalPrefix = null;
        }
    });

    // Submit calibration
    $('#cal-modal-submit').on('click', function() {
        const val = $('#cal-modal-input').val().trim();
        if (pendingCalCmd && pendingCalPrefix) {
            const payload = `${pendingCalPrefix},${val}`;
            sendAtomicPacket(0x01, pendingCalCmd, TYPES.PAYLOAD_STRING, payload);
            $('#calibration-modal').removeClass('open');
            pendingCalCmd = null;
            pendingCalPrefix = null;
        }
    });

    // Support Enter key in modal input
    $('#cal-modal-input').on('keypress', function(e) {
        if (e.key === 'Enter') {
            $('#cal-modal-submit').click();
        }
    });

    let pendingSensor = null;

    // Readings modal trigger
    $('.readings-trigger-btn').on('click', function() {
        try {
            fs.appendFileSync('debug_click.txt', 'Readings trigger clicked! Sensor: ' + $(this).attr('data-sensor') + '\n');
            const sensor = $(this).attr('data-sensor');
            pendingSensor = sensor;

            const titleName = sensor.toUpperCase();
            $('#readings-modal-title').text(`Read ${titleName} Sensor`);
            $('#readings-modal-input').val('1');

            $('#readings-modal').addClass('open');
            fs.appendFileSync('debug_click.txt', 'Readings modal class added.\n');
            setTimeout(() => $('#readings-modal-input').focus().select(), 50);
        } catch (err) {
            fs.appendFileSync('debug_click.txt', 'ERROR inside readings trigger: ' + err.stack + '\n');
        }
    });

    // Close readings modal actions
    $('#readings-modal-close, #readings-modal-cancel, #readings-modal').on('click', function(e) {
        if (e.target === this || $(e.target).closest('.modal-card').length === 0 || this.id === 'readings-modal-close' || this.id === 'readings-modal-cancel') {
            $('#readings-modal').removeClass('open');
            pendingSensor = null;
        }
    });

    // Submit readings request
    $('#readings-modal-submit').on('click', function() {
        try {
            fs.appendFileSync('debug_click.txt', 'Readings modal submit clicked! pendingSensor: ' + pendingSensor + '\n');
            const count = $('#readings-modal-input').val() || '1';
            if (pendingSensor) {
                const command = `${pendingSensor}:read`;
                sendAtomicPacket(0x01, command, TYPES.PAYLOAD_STRING, count.toString());
                $('#readings-modal').removeClass('open');
                pendingSensor = null;
                fs.appendFileSync('debug_click.txt', 'Readings command sent successfully.\n');
            } else {
                fs.appendFileSync('debug_click.txt', 'Warning: pendingSensor was null.\n');
            }
        } catch (err) {
            fs.appendFileSync('debug_click.txt', 'ERROR inside submit: ' + err.stack + '\n');
        }
    });

    // Support Enter key in readings modal input
    $('#readings-modal-input').on('keypress', function(e) {
        if (e.key === 'Enter') {
            $('#readings-modal-submit').click();
        }
    });
}

async function listPorts() {
    try {
        const ports = await SerialPort.list();
        const savedPort = localStorage.getItem('lastSerialPort');
        portSelect.empty();
        
        const visualList = $('#port-list');
        visualList.empty();
        
        if (ports.length === 0) {
            portSelect.append($('<option>', { value: '', text: 'No Ports' }));
            visualList.append($('<div>').addClass('port-item empty').text('No Ports Available'));
            $('#port-picker-btn span').text('No Ports');
        } else {
            let activePortFound = false;
            ports.forEach(p => {
                const option = $('<option>', { value: p.path, text: p.path });
                if (p.path === savedPort) option.attr('selected', 'selected');
                portSelect.append(option);
                
                const item = $('<div>')
                    .addClass('port-item')
                    .attr('data-value', p.path)
                    .html(`<i class="fas fa-microchip" style="font-size: 10px; opacity: 0.5;"></i> ${p.path}`);
                
                if (p.path === savedPort) {
                    item.addClass('active');
                    $('#port-picker-btn span').text(p.path);
                    activePortFound = true;
                }
                
                item.on('click', () => {
                    $('.port-item').removeClass('active');
                    item.addClass('active');
                    portSelect.val(p.path);
                    localStorage.setItem('lastSerialPort', p.path);
                    $('#port-picker-btn span').text(p.path);
                    $('#port-popup').removeClass('open');
                    
                    if (port && port.isOpen) {
                        disconnectSerial();
                    }
                    connectSerial();
                });
                
                visualList.append(item);
            });
            
            if (!activePortFound && ports.length > 0) {
                const firstPort = ports[0].path;
                portSelect.val(firstPort);
                $('#port-picker-btn span').text(firstPort);
                $(`.port-item[data-value="${firstPort}"]`).addClass('active');
            }
        }
    } catch (e) {
        console.error(e);
    }
}

function logOnUI(direction, type, message, endLine = false) {
    if (!loggerDisplay) return;

    if (endLine) {
        message = message.replace('__newline__', '');
        CONTINUE_LINE = false;
        
        if (message.trim().length === 0) return;
    }

    const lastLine = loggerDisplay.find('.log-line:last');

    if (!CONTINUE_LINE || lastLine.length === 0) {
        const line = $('<div>').addClass('log-line').attr('type', type).css({
            marginBottom: '4px', borderBottom: '1px solid #333', paddingBottom: '2px'
        });
        
        const time = new Date().toLocaleTimeString();
        const dirStyle = direction === 'TX' ? 'color: #28a745;' : (direction === 'RX' ? 'color: #007bff;' : 'color: #dc3545;');
        
        line.html(`
            <span class="log-time" style="color: #868e96; display: none;">[${time}]</span> 
            <span class="log-dir" style="font-weight: bold; ${dirStyle}">${direction}</span> 
            <span class="log-type" style="font-weight: bold;">[${type}]</span> 
            <span class="log-icon"></span> 
            <span class="log-msg">${message}</span>
        `);
        
        loggerDisplay.append(line);
        checkFilterForLine(line);
    }

    // Append to last log-line
    else {
        if (lastLine.length) {
            lastLine.find('.log-msg').append(message);
        }
    }

    if (endLine) CONTINUE_LINE = false;
    else CONTINUE_LINE = true;

    loggerDisplay.scrollTop(loggerDisplay[0].scrollHeight);
}

function showOnUI(direction, type, message) {
    if (!loggerDisplay) return;
    const line = $('<div>').addClass('log-line').attr('type', type).attr('type-code', TYPES[type]).css({
        marginBottom: '4px', borderBottom: '1px solid #333', paddingBottom: '2px'
    });
    
    const time = new Date().toLocaleTimeString();
    const dirStyle = direction === 'TX' ? 'color: #28a745;' : (direction === 'RX' ? 'color: #007bff;' : 'color: #dc3545;');
    
    if (type == "ACK") {
        message = "Acknowledgment received";

        // Append a monochrome fontawesome checkmark
        $(`.log-line[type-code="${_lastSentType}"]`).last().find(".log-icon").html('<i class="ack-icon fas fa-check-circle" title="Command executed successfully" style="color: #28a745; font-size: 9px;"></i>');
    }
    else if (type == "NACK") {
        message = "Nacknowledgment received";

        // Append a monochrome fontawesome icon
        $('.log-line').last().find(".log-icon").html('<i class="ack-icon fas fa-times-circle" title="Negative acknowledgement received" style="color: #dc3545; font-size: 9px;"></i>');
    }
    else if (type == "RAC") {
        // Do nothing for now
    }

    else if (type == "ACR") {

        // Append a monochrome fontawesome checkmark
        $('.log-line').last().find(".log-icon").html('<i class="ack-icon fas fa-check-circle" title="Sent an acknowledgment to GatorByte" style="color: #d1c519; font-size: 9px;"></i>');
    }

    else {
        line.html(`
            <span class="log-time" style="color: #868e96; display: none;">[${time}]</span> 
            <span class="log-dir" style="font-weight: bold; ${dirStyle}">${direction}</span> 
            <span class="log-type" style="font-weight: bold;">[${type}]</span> 
            <span class="log-icon"></span> 
            <span class="log-msg">${message}</span>
        `);
        
        loggerDisplay.append(line);
        checkFilterForLine(line);
        loggerDisplay.scrollTop(loggerDisplay[0].scrollHeight);
    }
}

function sendFromUI() {
    const type = parseInt(msgTypeSelect.val());
    const cmdStr = msgInput.val();
    const payloadStr = payloadInput.val();
    
    let pType = 0x00; // Default: No Payload
    let pData = payloadStr;

    if (payloadStr.trim().length > 0) {
        try {

            if (typeof JSON.parse(payloadStr) === 'object') pType = TYPES.PAYLOAD_JSON;
            else pType = TYPES.PAYLOAD_STRING;

        } catch (e) {
            pType = TYPES.PAYLOAD_STRING;
        }
    }

    sendAtomicPacket(type, cmdStr, pType, pData);
    updateCommandHistory(cmdStr);
}

function disconnectSerial() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    if (port) {
        port.removeAllListeners('close');
        if (port.isOpen) {
            port.close();
        }
    }
    updateConnectButton(false);
    showOnUI('SYS', 'INFO', 'Disconnected manually');
    ipcRenderer.send('set-connection-badge', false);
}

function setConsoleLockState(locked, sendPacket = true) {
    isLocked = locked;
    if (isLocked) {
        $('#lock-btn').removeClass('unlocked').addClass('locked').html('<i class="fas fa-lock"></i>').attr('title', 'Unlock Arduino GDC Mode');
        
        if (sendPacket) {
            sendAtomicPacket(0x01, "gdc:lock", TYPES.PAYLOAD_STRING, "true");
        }
        
        showOnUI('SYS', 'WARN', 'Arduino GDC mode locked.');
    } else {
        $('#lock-btn').removeClass('locked').addClass('unlocked').html('<i class="fas fa-lock-open"></i>').attr('title', 'Lock Arduino GDC Mode');
        
        if (sendPacket) {
            sendAtomicPacket(0x01, "gdc:lock", TYPES.PAYLOAD_STRING, "false");
        }
        
        showOnUI('SYS', 'INFO', 'Arduino GDC mode unlocked.');
    }
}

function toggleConnection() {
    if (port && port.isOpen) {
        disconnectSerial();
    } else {
        connectSerial();
    }
}

function toggleAck() {
    if ($("#ack-btn").hasClass("disabled")) {
        $("#ack-btn").removeClass("disabled");
        
    } else {
        $("#ack-btn").addClass("disabled");
    }
}

function updateConnectButton(connected) {
    const btn = $('#disconnect-btn');
    if (!btn.length) return;
    if (!connected) {
        btn.html('<i class="fas fa-link-slash"></i>').attr('title', 'Disconnect').css('background', '#dc3545');
        $('body').addClass('disconnected').removeClass('connected');
    } else {
        btn.html('<i class="fas fa-link"></i>').attr('title', 'Connect').css('background', '#28a745');
        $('body').addClass('connected').removeClass('disconnected');
    }
}

const connectSerial = () => {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    if (port && port.isOpen) {
        port.removeAllListeners('close');
        port.close();
    }

    const selectedPort = portSelect.val();
    if (!selectedPort) {
        showOnUI('SYS', 'ERR', 'No port selected');
        return;
    }
    localStorage.setItem('lastSerialPort', selectedPort);

    port = new SerialPort({ path: selectedPort, baudRate: BAUD_RATE });
    const parser = port.pipe(new DelimiterParser({ delimiter: [0] }));

    parser.on('data', (data) => {
        try {
            const decoded = cobs.decode(data);

            // Validate packet type to distinguish from raw serial data
            const type = decoded.length > 0 ? decoded[0] : -1;
            const validTypes = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0A, 0x0B];

            if (validTypes.includes(type)) {
                handlePacket(decoded);
            } else {
                throw new Error("Invalid Packet Type");
            }
        } catch (e) {
            // // console.error("COBS Decode Error", e);
            // const rawString = data.toString();
            // if (rawString.trim().length > 0) {
            //     logOnUI('RX', 'RAW', rawString, true);
            // }
        }
    });

    port.on('open', () => { 
        /*
            The USB-to-Serial chip on the board uses the DTR (Data Terminal
            Ready) and RTS (Request to Send) signals to automatically reset the
            board and enter bootloader mode for uploading code. When you open a
            serial connection, these signals are often asserted by default,
            which can hold the microcontroller in a reset state or prevent it
            from booting normally when you press the reset button. 
            To fix this, you need to explicitly disable DTR and RTS signals when
            the serial port opens.
        */

        console.log("Serial Port Opened");
        port.set({ dtr: false, rts: false });
        updateConnectButton(true);
        showOnUI('SYS', 'INFO', 'Connected to ' + selectedPort);
        ipcRenderer.send('set-connection-badge', true);

        // Send ping
        sendAtomicPacket(0x01, "ping", 0x00, "");

        // Send heartbeat (0x0B)
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(() => {
            if (port && port.isOpen) {
                sendHeartbeat();
            }
            else {
                clearInterval(heartbeatInterval);
            }
        }, 5000);
    });

    port.on('close', () => {
        console.log("Serial Port Closed");
        updateConnectButton(false);
        ipcRenderer.send('set-connection-badge', false);
        if (!reconnectTimeout) {
            reconnectTimeout = setTimeout(connectSerial, 5000);
        }
    });

    port.on('error', (err) => { 
        console.error("Serial Port Error:", err);
        updateConnectButton(false);
        ipcRenderer.send('set-connection-badge', false);
        if (!port.isOpen && !reconnectTimeout) {
            reconnectTimeout = setTimeout(connectSerial, 5000);
        }
    });
};

function handlePacket(buf) {
    let data = buf;
    if (CRC_PROTECTION) {
        const receivedCrc = buf.readUInt32LE(buf.length - 4);
        data = buf.slice(0, buf.length - 4);
        if (crc32.unsigned(data) !== receivedCrc) return;
    }

    // Atomic Unpacking
    const type = data[0];
    const pType = data[1];
    const cmdLen = data.readUInt16LE(2);
    const pLen = data.readUInt16LE(4);

    const cmd = data.slice(6, 6 + cmdLen).toString();
    const payload = data.slice(6 + cmdLen, 6 + cmdLen + pLen).toString();

    // Check if pong is received to lock GDC
    if (cmd.toLowerCase() === 'pong' || payload.toLowerCase() === 'pong') {
        setConsoleLockState(true, false);
    }

    // console.log("Received: " + type + ", " + pType + ", " + cmdLen + ", " + pLen + ", " + cmd + ", " + payload);

    switch (type) {
        case 0x01: // GDC_TYPE_CMD
            showOnUI('RX', 'CMD', payload.toString());

            if (_ackRequested) {
                showOnUI('RX', 'ACR', "");
                sendAck();
                _ackRequested = false;
            }
            
            break;

        case 0x02: // GDC_TYPE_MSG
            showOnUI('RX', 'MSG', payload.toString());

            if (_ackRequested) {
                showOnUI('RX', 'ACR', "");
                sendAck();
                _ackRequested = false;
            }

            break;

        case 0x03: // GDC_TYPE_FILE
            // processFileChunk(payload);
            
            if (_ackRequested) {
                showOnUI('RX', 'ACR', "");
                sendAck();
                _ackRequested = false;
            }
            
            break;

        case 0x04: // GDC_TYPE_ACK
            showOnUI('RX', 'ACK', '');
            break;

        case 0x05: // GDC_TYPE_NACK
            showOnUI('RX', 'NACK', '');
            break;

        case 0x06: // GDC_TYPE_LOG
            logOnUI('RX', 'LOG', payload.toString(), payload.toString().endsWith('__newline__'));
            break;

        case 0x0A: // GDC_TYPE_REQUEST_ACK
            _ackRequested = true;
            break;

        case 0x0B: // GDC_TYPE_HEARTBEAT

            // Heartbeat annimate the COM port selector
            $('#port-select').addClass('heartbeat-pulse');
            setTimeout(() => {
                $('#port-select').removeClass('heartbeat-pulse');
            }, 1500);

            break;

        default:
            console.log("Unknown Packet Type:", type);
            break;
    }
}

// Type 0x04 is GDC_TYPE_ACK
function sendAck() {
    const encoded = Buffer.concat([cobs.encode(Buffer.from([0x04])), Buffer.from([0])]);
    port.write(encoded);
}

function sendHeartbeat() {
    sendAtomicPacket(0x0B, "", 0x00);
}

function sendNack() {
    // Type 0x05 is GDC_TYPE_NACK
    const encoded = Buffer.concat([cobs.encode(Buffer.from([0x05])), Buffer.from([0])]);
    port.write(encoded);
}

function requestAck() {
    // Type 0x0A is GDC_TYPE_REQUEST_ACK
    const encoded = Buffer.concat([cobs.encode(Buffer.from([0x0A])), Buffer.from([0])]);
    port.write(encoded);
}

function sendAtomicPacket(type, cmdString, payloadType, payloadData = "") {
    if (!port || !port.isOpen) return;

    const cmdBuf = Buffer.from(cmdString);
    const pDataBuf = Buffer.from(payloadData);

    _lastSentType = type;

    var requestAck = false;
    if (type == 0x01) requestAck = true;
    if (type == 0x02) requestAck = true;
    if (type == 0x03) requestAck = true;
    if (type == 0x0A) requestAck = false;
    if (type == 0x0B) requestAck = false;
    
    // Header: Type(1), PType(1), CmdLen(2), PLen(2), AckReq(1)
    const headerLength = 7;
    const header = Buffer.alloc(headerLength);
    header[0] = type;
    header[1] = payloadType;
    header.writeUInt16LE(cmdBuf.length, 2);
    header.writeUInt16LE(pDataBuf.length, 4);
    header[6] = $('#ack-btn').hasClass("disabled") ? 0x00 : (requestAck ? 0x01 : 0x00);

    let rawBody = Buffer.concat([header, cmdBuf, pDataBuf]);

    if (CRC_PROTECTION) {
        const crcValue = crc32.unsigned(rawBody);
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32LE(crcValue);
        rawBody = Buffer.concat([rawBody, crcBuf]);
    }

    const encoded = Buffer.concat([cobs.encode(rawBody), Buffer.from([0])]);
    port.write(encoded);
    
    if (type == 0x01) showOnUI('TX', 'CMD', `${cmdString}`);
    else if (type == 0x02) showOnUI('TX', 'MSG', `${cmdString}`);
}

window.requestFile = () => {
    // Send 'S' (Command type 0x01) with empty payload (type 0x00)
    sendAtomicPacket(0x01, "S", 0x00, "");
};

setupLogger();

listPorts().then(() => {
    if (portSelect.val()) connectSerial();
});

ipcRenderer.on('toggle-connection', () => {
    toggleConnection();
});

// Global filtering functions
function loadFilters() {
    const showTime = localStorage.getItem('filter_show_time') !== 'false';
    $('#filter-show-time').prop('checked', showTime);

    $('.filter-dir-checkbox').each(function() {
        const dir = $(this).attr('data-dir');
        const checked = localStorage.getItem(`filter_dir_${dir}`) !== 'false';
        $(this).prop('checked', checked);
    });

    $('.filter-type-checkbox').each(function() {
        const type = $(this).attr('data-type');
        const checked = localStorage.getItem(`filter_type_${type}`) !== 'false';
        $(this).prop('checked', checked);
    });
}

function saveFilters() {
    localStorage.setItem('filter_show_time', $('#filter-show-time').is(':checked'));

    $('.filter-dir-checkbox').each(function() {
        const dir = $(this).attr('data-dir');
        localStorage.setItem(`filter_dir_${dir}`, $(this).is(':checked'));
    });

    $('.filter-type-checkbox').each(function() {
        const type = $(this).attr('data-type');
        localStorage.setItem(`filter_type_${type}`, $(this).is(':checked'));
    });
}

function applyFilters() {
    const showTime = $('#filter-show-time').is(':checked');
    if (showTime) {
        $('#logger-display').removeClass('hide-timestamps');
    } else {
        $('#logger-display').addClass('hide-timestamps');
    }

    const activeDirs = [];
    $('.filter-dir-checkbox:checked').each(function() {
        activeDirs.push($(this).attr('data-dir'));
    });

    const activeTypes = [];
    $('.filter-type-checkbox:checked').each(function() {
        activeTypes.push($(this).attr('data-type'));
    });

    $('.log-line').each(function() {
        const line = $(this);
        const dir = line.find('.log-dir').text().trim();
        const type = line.attr('type');
        
        let dirMatch = activeDirs.includes(dir);
        let typeMatch = false;

        if (type === 'CMD' || type === 'MSG' || type === 'LOG') {
            typeMatch = activeTypes.includes(type);
        } else if (type === 'ACK' || type === 'NACK' || type === 'ACR' || type === 'RAC') {
            typeMatch = activeTypes.includes('ACK');
        } else {
            typeMatch = true;
        }

        if (dirMatch && typeMatch) {
            line.show();
        } else {
            line.hide();
        }
    });
}

function checkFilterForLine(line) {
    const activeDirs = [];
    $('.filter-dir-checkbox:checked').each(function() {
        activeDirs.push($(this).attr('data-dir'));
    });

    const activeTypes = [];
    $('.filter-type-checkbox:checked').each(function() {
        activeTypes.push($(this).attr('data-type'));
    });

    const dir = line.find('.log-dir').text().trim();
    const type = line.attr('type');
    
    let dirMatch = activeDirs.includes(dir);
    let typeMatch = false;

    if (type === 'CMD' || type === 'MSG' || type === 'LOG') {
        typeMatch = activeTypes.includes(type);
    } else if (type === 'ACK' || type === 'NACK' || type === 'ACR' || type === 'RAC') {
        typeMatch = activeTypes.includes('ACK');
    } else {
        typeMatch = true;
    }

    if (dirMatch && typeMatch) {
        line.show();
    } else {
        line.hide();
    }
}
