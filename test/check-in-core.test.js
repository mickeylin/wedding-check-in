const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadCodeGs(overrides = {}) {
  const codePath = path.join(__dirname, '..', 'Code.gs');
  const code = `${fs.readFileSync(codePath, 'utf8')}\nthis.__testExports = { createCheckInModule_, handleApiSession_, verifySessionToken_ };`;
  const context = { ...overrides };
  vm.runInNewContext(code, context, { filename: codePath });
  return context.__testExports;
}

function createInMemoryDependencies() {
  const guests = new Map([
    ['G001', {
      guestId: 'G001',
      displayName: '王小明',
      tableNo: '8',
      expectedCount: 2,
      actualCount: 0,
      status: '',
      checkedInAt: null,
      operator: '',
      station: ''
    }]
  ]);
  const scanLogs = [];

  return {
    guests,
    scanLogs,
    lock: {
      runExclusive(callback) {
        return callback();
      }
    },
    guestStore: {
      findById(guestId) {
        return guests.get(guestId) || null;
      },
      markCheckedIn(guestId, update) {
        const guest = guests.get(guestId);
        Object.assign(guest, update);
      }
    },
    scanLog: {
      record(entry) {
        scanLogs.push(entry);
      }
    },
    clock: () => new Date('2026-08-13T10:30:00.000Z'),
    formatDate: value => new Date(value).toISOString()
  };
}

test('有效賓客第一次報到會更新 Guests 並回傳 CHECKED_IN', () => {
  const { createCheckInModule_ } = loadCodeGs();
  const dependencies = createInMemoryDependencies();
  const checkIn = createCheckInModule_(dependencies);

  const result = checkIn.attempt({
    guestId: 'G001',
    operator: 'staff-a',
    station: '入口A',
    requestId: 'req-001'
  });

  assert.equal(result.status, 'CHECKED_IN');
  assert.equal(result.ok, true);
  assert.equal(result.guestId, 'G001');
  assert.equal(result.displayName, '王小明');
  assert.equal(result.tableNo, '8');
  assert.equal(dependencies.guests.get('G001').status, '已報到');
  assert.equal(dependencies.guests.get('G001').actualCount, 2);
  assert.equal(dependencies.guests.get('G001').operator, 'staff-a');
  assert.equal(dependencies.guests.get('G001').station, '入口A');
});

test('已報到賓客再次報到會回傳 ALREADY_CHECKED_IN 且保留原時間', () => {
  const { createCheckInModule_ } = loadCodeGs();
  const dependencies = createInMemoryDependencies();
  const checkIn = createCheckInModule_(dependencies);

  const first = checkIn.attempt({
    guestId: 'G001',
    operator: 'staff-a',
    station: '入口A',
    requestId: 'req-001'
  });
  const originalCheckedInAt = dependencies.guests.get('G001').checkedInAt;
  const second = checkIn.attempt({
    guestId: 'G001',
    operator: 'staff-b',
    station: '入口B',
    requestId: 'req-002'
  });

  assert.equal(first.status, 'CHECKED_IN');
  assert.equal(second.status, 'ALREADY_CHECKED_IN');
  assert.equal(second.ok, true);
  assert.match(second.message, /原報到時間/);
  assert.equal(dependencies.guests.get('G001').checkedInAt, originalCheckedInAt);
  assert.equal(dependencies.guests.get('G001').operator, 'staff-a');
  assert.equal(dependencies.guests.get('G001').station, '入口A');
});

test('找不到賓客時回傳 NOT_FOUND 且不寫入 Guests', () => {
  const { createCheckInModule_ } = loadCodeGs();
  const dependencies = createInMemoryDependencies();
  const checkIn = createCheckInModule_(dependencies);

  const result = checkIn.attempt({
    guestId: 'G999',
    operator: 'staff-a',
    station: '入口A',
    requestId: 'req-003'
  });

  assert.equal(result.status, 'NOT_FOUND');
  assert.equal(result.ok, false);
  assert.equal(dependencies.guests.has('G999'), false);
});
test('沒有賓客 ID 時回傳 EMPTY_SCAN 且不寫入 Guests', () => {
  const { createCheckInModule_ } = loadCodeGs();
  const dependencies = createInMemoryDependencies();
  const checkIn = createCheckInModule_(dependencies);

  const result = checkIn.attempt({
    guestId: '',
    operator: 'staff-a',
    station: '入口A',
    requestId: 'req-004'
  });

  assert.equal(result.status, 'EMPTY_SCAN');
  assert.equal(result.ok, false);
  assert.equal(dependencies.guests.get('G001').status, '');
});
test('取得 lock 超時時回傳 BUSY 且不寫入 Guests', () => {
  const { createCheckInModule_ } = loadCodeGs();
  const dependencies = createInMemoryDependencies();
  const busyError = new Error('lock busy');
  busyError.code = 'BUSY';
  dependencies.lock = {
    runExclusive() {
      throw busyError;
    }
  };
  const checkIn = createCheckInModule_(dependencies);

  const result = checkIn.attempt({
    guestId: 'G001',
    operator: 'staff-a',
    station: '入口A',
    requestId: 'req-005'
  });

  assert.equal(result.status, 'BUSY');
  assert.equal(result.ok, false);
  assert.equal(dependencies.guests.get('G001').status, '');
  assert.equal(dependencies.scanLogs.length, 0);
});
test('找不到賓客時會記錄 NOT_FOUND ScanLog', () => {
  const { createCheckInModule_ } = loadCodeGs();
  const dependencies = createInMemoryDependencies();
  const checkIn = createCheckInModule_(dependencies);

  checkIn.attempt({
    guestId: 'G999',
    operator: 'staff-a',
    station: '入口A',
    requestId: 'req-006'
  });

  assert.equal(dependencies.scanLogs.length, 1);
  assert.equal(dependencies.scanLogs[0].status, 'NOT_FOUND');
  assert.equal(dependencies.scanLogs[0].requestId, 'req-006');
});
test('Guests 寫入成功但 ScanLog 失敗時仍回傳 CHECKED_IN', () => {
  const { createCheckInModule_ } = loadCodeGs();
  const dependencies = createInMemoryDependencies();
  dependencies.shouldLogSuccessCheckIns = () => true;
  dependencies.scanLog = {
    record() {
      throw new Error('scan log unavailable');
    }
  };
  const checkIn = createCheckInModule_(dependencies);

  const result = checkIn.attempt({
    guestId: 'G001',
    operator: 'staff-a',
    station: '入口A',
    requestId: 'req-007'
  });

  assert.equal(result.status, 'CHECKED_IN');
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0], 'SCAN_LOG_FAILED');
  assert.equal(dependencies.guests.get('G001').status, '已報到');
});
test("PIN exchange creates a short-lived session bound to operator and station", () => {
  const properties = new Map([["API_PIN", "1234"]]);
  const scriptProperties = {
    getProperty(name) {
      return properties.get(name) || null;
    },
    setProperty(name, value) {
      properties.set(name, value);
    },
    deleteProperty(name) {
      properties.delete(name);
    }
  };
  const { handleApiSession_, verifySessionToken_ } = loadCodeGs({
    PropertiesService: {
      getScriptProperties() {
        return scriptProperties;
      }
    },
    Utilities: {
      getUuid() {
        return "session-token-001";
      }
    }
  });
  const now = new Date("2026-08-13T10:30:00.000Z");

  const result = handleApiSession_({
    pin: "1234",
    operator: "staff-a",
    station: "入口A"
  }, now);

  assert.equal(result.status, "SESSION_CREATED");
  assert.equal(result.ok, true);
  assert.equal(result.sessionToken, "session-token-001");
  const session = verifySessionToken_(result.sessionToken, now);
  assert.equal(session.operator, "staff-a");
  assert.equal(session.station, "入口A");
  assert.ok(session.expiresAt > now.getTime());
});
test("wrong PIN is rejected before a session is created", () => {
  const properties = new Map([["API_PIN", "1234"]]);
  const { handleApiSession_ } = loadCodeGs({
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(name) {
            return properties.get(name) || null;
          },
          setProperty() {
            throw new Error("session must not be created");
          }
        };
      }
    }
  });

  assert.throws(
    () => handleApiSession_({
      pin: "wrong",
      operator: "staff-a"
    }, new Date("2026-08-13T10:30:00.000Z")),
    error => error.code === "UNAUTHORIZED"
  );
});

test("expired session tokens are rejected and removed", () => {
  const properties = new Map([
    ["CHECKIN_SESSION_expired-token", JSON.stringify({
      operator: "staff-a",
      station: "入口A",
      expiresAt: new Date("2026-08-13T10:30:00.000Z").getTime()
    })]
  ]);
  const scriptProperties = {
    getProperty(name) {
      return properties.get(name) || null;
    },
    deleteProperty(name) {
      properties.delete(name);
    }
  };
  const { verifySessionToken_ } = loadCodeGs({
    PropertiesService: {
      getScriptProperties() {
        return scriptProperties;
      }
    }
  });

  assert.throws(
    () => verifySessionToken_(
      "expired-token",
      new Date("2026-08-13T10:30:00.000Z")
    ),
    error => error.code === "UNAUTHORIZED"
  );
  assert.equal(properties.has("CHECKIN_SESSION_expired-token"), false);
});
test("unexpected core failures are logged as ERROR", () => {
  const { createCheckInModule_ } = loadCodeGs();
  const dependencies = createInMemoryDependencies();
  dependencies.lock = {
    runExclusive() {
      throw new Error("sheet unavailable");
    }
  };
  const checkIn = createCheckInModule_(dependencies);

  const result = checkIn.attempt({
    guestId: "G001",
    operator: "staff-a",
    station: "入口A",
    requestId: "req-008"
  });

  assert.equal(result.status, "ERROR");
  assert.equal(result.ok, false);
  assert.equal(dependencies.scanLogs.length, 1);
  assert.equal(dependencies.scanLogs[0].status, "ERROR");
  assert.equal(dependencies.guests.get("G001").status, "");
});