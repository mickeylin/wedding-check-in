const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadCodeGs(overrides = {}) {
  const codePath = path.join(__dirname, '..', 'Code.gs');
  const code = `${fs.readFileSync(codePath, 'utf8')}\nthis.__testExports = { createGuestLookupModule_, handleApiSession_, verifySessionToken_, lookupCategoriesForFilter_ };`;
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
      category: '男方朋友'
    }]
  ]);

  return {
    guests,
    guestStore: {
      search(query, category) {
        const normalizedQuery = String(query || '').trim().toLowerCase();
        const normalizedCategory = String(category || '').trim().toLowerCase();
        return [...guests.values()].filter(guest => {
          const matchesQuery = guest.displayName.toLowerCase().includes(normalizedQuery)
            || guest.guestId.toLowerCase().includes(normalizedQuery);
          const matchesCategory = !normalizedCategory || [guest.category, normalizedCategory === '男方朋友' || normalizedCategory === '女方朋友' ? '共同朋友' : ''].some(value => value.toLowerCase() === normalizedCategory);
          return matchesQuery && matchesCategory;
        });
      }
    }
  };
}

test('查找會回傳桌號與關係分類', () => {
  const { createGuestLookupModule_ } = loadCodeGs();
  const dependencies = createInMemoryDependencies();
  const lookup = createGuestLookupModule_({
    guestStore: dependencies.guestStore,
    maxResults: 20
  });

  const result = lookup.search({ query: '王', category: '男方朋友' });

  assert.equal(result.status, 'LOOKUP_RESULTS');
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].guestId, 'G001');
  assert.equal(result.results[0].tableNo, '8');
  assert.equal(result.results[0].category, '男方朋友');
});

test('朋友分類查找會包含共同朋友，其他分類維持精確比對', () => {
  const { lookupCategoriesForFilter_ } = loadCodeGs();
  assert.deepEqual(Array.from(lookupCategoriesForFilter_('男方朋友')), ['男方朋友', '共同朋友']);
  assert.deepEqual(Array.from(lookupCategoriesForFilter_('女方朋友')), ['女方朋友', '共同朋友']);
  assert.deepEqual(Array.from(lookupCategoriesForFilter_('男方家人')), ['男方家人']);
  assert.deepEqual(Array.from(lookupCategoriesForFilter_('共同朋友')), ['共同朋友']);
});
test('查找至少需要姓名或分類，且找不到時不回傳資料', () => {
  const { createGuestLookupModule_ } = loadCodeGs();
  const dependencies = createInMemoryDependencies();
  const lookup = createGuestLookupModule_({ guestStore: dependencies.guestStore });
  const empty = lookup.search({ query: '', category: '' });
  const categoryOnly = lookup.search({ query: '', category: '男方朋友' });
  const missing = lookup.search({ query: '不存在' });
  assert.equal(empty.status, 'EMPTY_LOOKUP');
  assert.equal(empty.ok, false);
  assert.equal(categoryOnly.status, 'LOOKUP_RESULTS');
  assert.equal(categoryOnly.results.length, 1);
  assert.equal(categoryOnly.results[0].guestId, 'G001');
  assert.equal(missing.status, 'NO_MATCHES');
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.results, []);
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
