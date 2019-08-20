/*
 * Copyright DataStax, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';
const assert = require('assert');
const util = require('util');
const path = require('path');
const policies = require('../lib/policies');
const types = require('../lib/types');
const utils = require('../lib/utils');
const spawn = require('child_process').spawn;
const http = require('http');
const temp = require('temp').track(true);
const Client = require('../lib/dse-client');
const defaultOptions = require('../lib/client-options').defaultOptions;
const Host = require('../lib/host').Host;
const OperationState = require('../lib/operation-state');

util.inherits(RetryMultipleTimes, policies.retry.RetryPolicy);

const cassandraVersionByDse = {
  '4.8': '2.1',
  '5.0': '3.0',
  '5.1': '3.11',
  '6.0': '3.11',
  '6.7': '3.11',
  '6.8': '3.11'
};

const helper = {
  /**
   * Creates a ccm cluster, initializes a Client instance the before() and after() hooks, create
   * @param {Number|String} nodeLength A number representing the amount of nodes in a single datacenter or a string
   * representing the amount of nodes in each datacenter, ie: "3:4".
   * @param {Object} [options]
   * @param {Object} [options.ccmOptions]
   * @param {Boolean} [options.initClient] Determines whether to create a Client instance.
   * @param {Object} [options.clientOptions] The options to use to initialize the client.
   * @param {String} [options.keyspace] Name of the keyspace to create.
   * @param {Number} [options.replicationFactor] Keyspace replication factor.
   * @param {Array<String>} [options.queries] Queries to run after client creation.
   * @param {Boolean} [options.removeClusterAfter=true] Determines whether ccm remove should be called on after().
   */
  setup: function (nodeLength, options) {
    options = options || utils.emptyObject;
    before(helper.ccmHelper.start(nodeLength || 1, options.ccmOptions));
    const initClient = options.initClient !== false;
    let client;
    let keyspace;
    if (initClient) {
      client = new Client(utils.extend({}, options.clientOptions, helper.baseOptions));
      before(client.connect.bind(client));
      keyspace = options.keyspace || helper.getRandomName('ks');
      before(helper.toTask(client.execute, client, helper.createKeyspaceCql(keyspace, options.replicationFactor)));
      before(helper.toTask(client.execute, client, 'USE ' + keyspace));
      if (options.queries) {
        before(function (done) {
          utils.eachSeries(options.queries, function (q, next) {
            client.execute(q, next);
          }, done);
        });
      }
      after(client.shutdown.bind(client));
    }
    if (options.removeClusterAfter !== false) {
      after(helper.ccmHelper.remove);
    }

    return {
      client: client,
      keyspace: keyspace
    };
  },
  /**
   * Sync throws the error
   * @type Function
   */
  throwop: function (err) {
    if (err) {
      throw err;
    }
  },
  /** @type Function */
  noop: function () {
    //do nothing
  },
  /** @type Function */
  failop: function () {
    throw new Error('Method should not be called');
  },
  /**
   * Uses the last parameter as callback, invokes it via setImmediate
   */
  callbackNoop: function () {
    const args = Array.prototype.slice.call(arguments);
    const cb = args[args.length-1];
    if (typeof cb !== 'function') {
      throw new Error('Helper method needs a callback as last parameter');
    }
    setImmediate(cb);
  },
  /**
   * Returns a function that returns the provided value
   * @param value
   */
  functionOf: function (value) {
    return (function fnOfFixedValue() {
      return value;
    });
  },
  /**
   * @type {ClientOptions}
   */
  baseOptions: (function () {
    return {
      //required
      contactPoints: ['127.0.0.1'],
      localDataCenter: 'dc1',
      // retry all queries multiple times (for improved test resiliency).
      policies: { retry: new RetryMultipleTimes(3) }
    };
  })(),
  /**
   * Returns a pseudo-random name in the form of 'ab{n}', n being an int zero padded with string length 16
   * @returns {string}
   */
  getRandomName: function (prefix) {
    if (!prefix) {
      prefix = 'ab';
    }
    const value = Math.floor(Math.random() * utils.maxInt);
    return prefix + ('000000000000000' + value.toString()).slice(-16);
  },
  ipPrefix: '127.0.0.',
  ccm: {},
  ads: {},
  /**
   * Returns a cql string with a CREATE TABLE command containing all common types
   * @param {String} tableName
   * @returns {String}
   */
  createTableCql: function (tableName) {
    return util.format('CREATE TABLE %s (' +
      '   id uuid primary key,' +
      '   ascii_sample ascii,' +
      '   text_sample text,' +
      '   int_sample int,' +
      '   bigint_sample bigint,' +
      '   float_sample float,' +
      '   double_sample double,' +
      '   decimal_sample decimal,' +
      '   blob_sample blob,' +
      '   boolean_sample boolean,' +
      '   timestamp_sample timestamp,' +
      '   inet_sample inet,' +
      '   timeuuid_sample timeuuid,' +
      '   map_sample map<text, text>,' +
      '   list_sample list<text>,' +
      '   list_sample2 list<int>,' +
      '   set_sample set<text>)', tableName);
  },
  /**
   * Returns a cql string with a CREATE TABLE command 1 partition key and 1 clustering key
   * @param {String} tableName
   * @returns {String}
   */
  createTableWithClusteringKeyCql: function (tableName) {
    return util.format('CREATE TABLE %s (' +
    '   id1 uuid,' +
    '   id2 timeuuid,' +
    '   text_sample text,' +
    '   int_sample int,' +
    '   bigint_sample bigint,' +
    '   float_sample float,' +
    '   double_sample double,' +
    '   map_sample map<uuid, int>,' +
    '   list_sample list<timeuuid>,' +
    '   set_sample set<int>,' +
    '   PRIMARY KEY (id1, id2))', tableName);
  },
  createKeyspaceCql: function (keyspace, replicationFactor, durableWrites) {
    return util.format('CREATE KEYSPACE %s' +
      ' WITH replication = {\'class\': \'SimpleStrategy\', \'replication_factor\' : %d}' +
      ' AND durable_writes = %s;', keyspace, replicationFactor || 1, !!durableWrites
    );
  },
  assertValueEqual: function (val1, val2) {
    if (val1 === null && val2 === null) {
      return;
    }
    if (val1 instanceof Buffer && val2 instanceof Buffer) {
      val1 = val1.toString('hex');
      val2 = val2.toString('hex');
    }
    if ((val1 instanceof types.Long && val2 instanceof types.Long) ||
        (val1 instanceof Date && val2 instanceof Date) ||
        (val1 instanceof types.InetAddress && val2 instanceof types.InetAddress) ||
        (val1 instanceof types.Uuid && val2 instanceof types.Uuid)) {
      val1 = val1.toString();
      val2 = val2.toString();
    }
    if (util.isArray(val1) ||
        (val1.constructor && val1.constructor.name === 'Object') ||
        val1 instanceof helper.Map) {
      val1 = util.inspect(val1, {depth: null});
      val2 = util.inspect(val2, {depth: null});
    }
    assert.strictEqual(val1, val2);
  },

  assertInstanceOf: function (instance, constructor) {
    assert.notEqual(instance, null, 'Expected instance, obtained ' + instance);
    assert.ok(instance instanceof constructor, 'Expected instance of ' + constructor.name + ', actual constructor: ' + instance.constructor.name);
  },

  assertNotInstanceOf: function (instance, constructor) {
    assert.notEqual(instance, null, 'Expected instance, obtained ' + instance);
    assert.ok(!(instance instanceof constructor), 'Expected instance different than ' + constructor.name + ', actual constructor: ' + instance.constructor.name);
  },

  assertContains: function (value, searchValue, caseInsensitive) {
    const originalValue = value;
    const originalSearchValue = searchValue;
    assert.strictEqual(typeof value, 'string');
    const message = 'String: "%s" does not contain "%s"';
    if (caseInsensitive !== false) {
      value = value.toLowerCase();
      searchValue = searchValue.toLowerCase();
    }
    assert.ok(value.indexOf(searchValue) >= 0, util.format(message, originalValue, originalSearchValue));
  },

  /**
   * Asserts that the value has some properties defined and the value of those properties
   * @param {Object} value
   * @param {Object} expectedProperties
   * @param {Boolean} [strictEquality=true]
   */
  assertProperties: (value, expectedProperties, strictEquality) => {
    const properties = Object.keys(expectedProperties);
    if (properties.length === 0) {
      throw new Error('expectedProperties should be defined as an object');
    }
    assert.ok(value, 'value should be defined');

    const assertFn = strictEquality !== false ? assert.strictEqual : assert.equal;

    properties.forEach(key => assertFn(value[key], expectedProperties[key]));
  },

  /**
   * Tests for deep equality of Maps between the actual and expected parameters
   * @param actual
   * @param expected
   */
  assertMapEqual: (actual, expected) => {
    helper.assertInstanceOf(actual, Map);
    helper.assertInstanceOf(expected, Map);
    assert.deepStrictEqual(Array.from(actual.keys()), Array.from(expected.keys()), 'Map keys do not match ');
    expected.forEach((value, key) => {
      assert.deepStrictEqual(actual.get(key), value, `Value for '${key}' does not match`);
    });
  },

  /**
   * Returns a function that waits on schema agreement before executing callback
   * @param {Client} client
   * @param {Function} callback
   * @returns {Function}
   */
  waitSchema: function (client, callback) {
    return (function (err) {
      if (err) {
        return callback(err);
      }
      if (!client.hosts) {
        throw new Error('No hosts on Client');
      }
      if (client.hosts.length === 1) {
        return callback();
      }
      setTimeout(callback, 200 * client.hosts.length);
    });
  },
  /**
   * @returns {Function} A function with a single callback param, applying the fn with parameters
   */
  toTask: function (fn, context) {
    const params = Array.prototype.slice.call(arguments, 2);
    return (function (next) {
      params.push(next);
      fn.apply(context, params);
    });
  },
  wait: function (ms, callback) {
    if (!ms) {
      ms = 0;
    }
    return (function (err) {
      if (err) {
        return callback(err);
      }
      setTimeout(callback, ms);
    });
  },

  /**
   * Gets the Apache Cassandra version.
   * When the server is DSE, gets the Apache Cassandra equivalent.
   */
  getCassandraVersion: function () {
    const serverInfo = this.getServerInfo();

    if (!serverInfo.isDse) {
      return serverInfo.version;
    }

    const dseVersion = serverInfo.version.split('.').slice(0, 2).join('.');
    return cassandraVersionByDse[dseVersion] || cassandraVersionByDse['6.7'];
  },

  /**
   * Gets the server version and type.
   * @return {{version, isDse}}
   */
  getServerInfo: function () {
    return {
      version: process.env['CCM_VERSION'] || '3.11.4',
      isDse: process.env['CCM_IS_DSE'] === 'true'
    };
  },

  getSimulatedCassandraVersion: function() {
    let version = this.getCassandraVersion();
    // simulacron does not support protocol V2 and V1, so cap at 2.1.
    if (version < '2.1') {
      version = '2.1.19';
    } else if (version >= '4.0') {
      // simulacron does not support protocol V5, so cap at 3.11
      version = '3.11.2';
    }
    return version;
  },

  /**
   * Determines if the current server is a DSE instance *AND* version is greater than or equals to the version provided
   * @param {String} version The version in string format, dot separated.
   * @returns {Boolean}
   */
  isDseGreaterThan: function (version) {
    const serverInfo = this.getServerInfo();
    if (!serverInfo.isDse) {
      return false;
    }

    return helper.versionCompare(serverInfo.version, version);
  },

  /**
   * Determines if the current C* or DSE instance version is greater than or equals to the C* version provided
   * @param {String} version The version in string format, dot separated.
   * @returns {Boolean}
   */
  isCassandraGreaterThan: function (version) {
    return helper.versionCompare(helper.getCassandraVersion(), version);
  },

  versionCompare: function (instanceVersionStr, version) {
    let expected = [1, 0]; //greater than or equals to
    if (version.indexOf('<=') === 0) {
      version = version.substr(2);
      expected = [-1, 0]; //less than or equals to
    }
    else if (version.indexOf('<') === 0) {
      version = version.substr(1);
      expected = [-1]; //less than
    }
    const instanceVersion = instanceVersionStr.split('.').map(function (x) { return parseInt(x, 10);});
    const compareVersion = version.split('.').map(function (x) { return parseInt(x, 10) || 0;});
    for (let i = 0; i < compareVersion.length; i++) {
      const compare = compareVersion[i] || 0;
      if (instanceVersion[i] > compare) {
        //is greater
        return expected.indexOf(1) >= 0;
      }
      else if (instanceVersion[i] < compare) {
        //is smaller
        return expected.indexOf(-1) >= 0;
      }
    }
    //are equal
    return expected.indexOf(0) >= 0;
  },
  log: function(levels) {
    if (!levels) {
      levels = ['info', 'warning', 'error'];
    }
    return (function (l) {
      if (levels.indexOf(l) >= 0) {
        // eslint-disable-next-line no-console, no-undef
        console.log.apply(console, arguments);
      }
    });
  },
  /**
   * @returns {Array}
   */
  fillArray: function (length, val) {
    const result = new Array(length);
    for (let i = 0; i < length; i++) {
      result[i] = val;
    }
    return result;
  },
  /**
   * @returns {Array}
   */
  iteratorToArray: function (iterator) {
    const result = [];
    let item = iterator.next();
    while (!item.done) {
      result.push(item.value);
      item = iterator.next();
    }
    return result;
  },
  /**
   * @param arr
   * @param {Function|String} predicate function to compare or property name to compare
   * @param val
   * @returns {*}
   */
  find: function (arr, predicate, val) {
    if (arr == null) {
      throw new TypeError('Array.prototype.find called on null or undefined');
    }
    if (typeof predicate === 'string') {
      const propName = predicate;
      predicate = function (item) {
        return (item && item[propName] === val);
      };
    }
    if (typeof predicate !== 'function') {
      throw new TypeError('predicate must be a function');
    }
    let value;
    for (let i = 0; i < arr.length; i++) {
      value = arr[i];
      if (predicate.call(null, value, i, arr)) {
        return value;
      }
    }
    return undefined;
  },
  /**
   * @param {Array} arr
   * @param {Function }predicate
   */
  first: function (arr, predicate) {
    const filterArr = arr.filter(predicate);
    if (filterArr.length === 0) {
      throw new Error('Item not found: ' + predicate);
    }
    return filterArr[0];
  },
  /**
   * Returns the values of an object
   * @param {Object} obj
   */
  values : function (obj) {
    const vals = [];
    for (const key in obj) {
      if (!obj.hasOwnProperty(key)) {
        continue;
      }
      vals.push(obj[key]);
    }
    return vals;
  },
  Map: MapPolyFill,
  Set: SetPolyFill,
  WhiteListPolicy: WhiteListPolicy,
  FallthroughRetryPolicy: FallthroughRetryPolicy,
  /**
   * Determines if test tracing is enabled
   */
  isTracing: function () {
    return (process.env.TEST_TRACE === 'on');
  },
  trace: function (format) {
    if (!helper.isTracing()) {
      return;
    }
    // eslint-disable-next-line no-console, no-undef
    console.log('\t...' + util.format.apply(null, arguments));
  },

  /**
   * Version dependent it() method for mocha test case
   * @param {String} testVersion Minimum version of Cassandra needed for this test
   * @param {String} testCase Test case name
   * @param {Function} func
   */
  vit: function (testVersion, testCase, func) {
    executeIfVersion(testVersion, it, [testCase, func]);
  },

  /**
   * Version dependent describe() method for mocha test case
   * @param {String} testVersion Minimum version of DSE/Cassandra needed for this test
   * @param {String} title Title of the describe section.
   * @param {Function} func
   */
  vdescribe: function (testVersion, title, func) {
    executeIfVersion(testVersion, describe, [title, func]);
  },

  /**
   * Given a {Host} returns the last octet of its ip address.
   * i.e. (127.0.0.247:9042) -> 247.
   *
   * @param {Host|string} host or host address to get ip address of.
   * @returns {string} Last octet of the host address.
   */
  lastOctetOf: function(host) {
    const address = typeof host === "string" ? host : host.address;
    const ipAddress = address.split(':')[0].split('.');
    return ipAddress[ipAddress.length-1];
  },

  /**
   * Given a {Client} and a {Number} returns the host whose last octet
   * ends with the requested number.
   * @param {Client|ControlConnection} client Client to lookup hosts from.
   * @param {Number} number last octet of requested host.
   * @returns {Host}
   */
  findHost: function(client, number) {
    let host = undefined;
    const self = this;
    client.hosts.forEach(function(h) {
      if(self.lastOctetOf(h) === number.toString()) {
        host = h;
      }
    });
    return host;
  },

  /**
   * Returns a method that repeatedly checks every second until the given host is present in the client's host
   * map and is up.  This is attempted up to 20 times and an error is thrown if the condition is not met.
   * @param {Client|ControlConnection} client Client to lookup hosts from.
   * @param {Number} number last octet of requested host.
   */
  waitOnHostUp: function(client, number) {
    const self = this;
    const hostIsUp = function() {
      const host = self.findHost(client, number);
      return host === undefined ? false : host.isUp();
    };

    return self.setIntervalUntilTask(hostIsUp, 1000, 20);
  },

  /**
   * Returns a method that repeatedly checks every second until the given host is present in the client's host
   * map and is down.  This is attempted up to 20 times and an error is thrown if the condition is not met.
   * @param {Client|ControlConnection} client Client to lookup hosts from.
   * @param {Number} number last octet of requested host.
   */
  waitOnHostDown: function(client, number) {
    const self = this;
    const hostIsDown = function() {
      const host = self.findHost(client, number);
      return host === undefined ? false : !host.isUp();
    };

    return self.setIntervalUntilTask(hostIsDown, 1000, 20);
  },

  /**
   * Returns a method that repeatedly checks every second until the given host is not present in the client's host
   * map. This is attempted up to 20 times and an error is thrown if the condition is not met.
   * @param {Client|ControlConnection} client Client to lookup hosts from.
   * @param {Number} number last octet of requested host.
   */
  waitOnHostGone: function(client, number) {
    const self = this;
    const hostIsGone = function() {
      const host = self.findHost(client, number);
      return host === undefined;
    };

    return self.setIntervalUntilTask(hostIsGone, 1000, 20);
  },

  /**
   * Returns a function, that when invoked shutdowns the client and callbacks
   * @param {Client} client
   * @param {Function} callback
   * @returns {Function}
   */
  finish: function (client, callback) {
    return (function onFinish(err) {
      client.shutdown(function () {
        assert.ifError(err);
        callback();
      });
    });
  },
  /**
   * Returns a handler that executes multiple queries
   * @param {Client} client
   * @param {Array<string>} queries
   */
  executeTask: function (client, queries) {
    return (function (done) {
      utils.series([
        client.connect.bind(client),
        function executeQueries(next) {
          utils.eachSeries(queries, function (query, eachNext) {
            client.execute(query, eachNext);
          }, next);
        }
      ], helper.finish(client, done));
    });
  },

  /**
   * Executes a function at regular intervals while the condition is false and the amount of attempts < maxAttempts.
   * @param {Function} condition
   * @param {Number} delay
   * @param {Number} maxAttempts
   * @param {Function} done
   */
  setIntervalUntil: function (condition, delay, maxAttempts, done) {
    let attempts = 0;
    utils.whilst(
      function whilstCondition() {
        return !condition();
      },
      function whilstItem(next) {
        if (attempts++ >= maxAttempts) {
          return next(new Error(util.format('Condition still false after %d attempts: %s', maxAttempts, condition)));
        }

        setTimeout(next, delay);
      },
      done);
  },
  /**
   * Returns a method that executes a function at regular intervals while the condition is false and the amount of
   * attempts < maxAttempts.
   * @param {Function} condition
   * @param {Number} delay
   * @param {Number} maxAttempts
   */
  setIntervalUntilTask: function (condition, delay, maxAttempts) {
    const self = this;
    return (function setIntervalUntilHandler(done) {
      self.setIntervalUntil(condition, delay, maxAttempts, done);
    });
  },
  /**
   * Executes a function at regular intervals while the condition is false and the amount of attempts < maxAttempts.
   * @param {Function} condition
   * @param {Number} delay
   * @param {Number} maxAttempts
   */
  setIntervalUntilPromise: function (condition, delay, maxAttempts) {
    return new Promise((resolve, reject) => {
      this.setIntervalUntil(condition, delay, maxAttempts, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  },
  /**
   * Returns a method that delays invoking the callback
   */
  delay: function (delayMs) {
    return (function delayedHandler(next) {
      setTimeout(next, delayMs);
    });
  },
  queries: {
    basic: "SELECT key FROM system.local",
    basicNoResults: "SELECT key from system.local WHERE key = 'not_existent'"
  },
  getPoolingOptions: function (localLength, remoteLength, heartBeatInterval) {
    const pooling = {
      heartBeatInterval: heartBeatInterval || 0,
      coreConnectionsPerHost: {}
    };
    pooling.coreConnectionsPerHost[types.distance.local] = localLength || 1;
    pooling.coreConnectionsPerHost[types.distance.remote] = remoteLength || 1;
    pooling.coreConnectionsPerHost[types.distance.ignored] = 0;
    return pooling;
  },
  getHostsMock: function (hostsInfo, prepareQueryCb, sendStreamCb, protocolVersion) {
    return hostsInfo.map(function (info, index) {
      protocolVersion = protocolVersion || types.protocolVersion.maxSupported;
      const h = new Host(index.toString(), protocolVersion, defaultOptions(), {});
      h.isUp = function () {
        return !(info.isUp === false);
      };
      h.checkHealth = utils.noop;
      h.log = utils.noop;
      h.shouldBeIgnored = !!info.ignored;
      h.prepareCalled = 0;
      h.sendStreamCalled = 0;
      h.connectionKeyspace = [];
      h.borrowConnection = function (ks, c, cb) {
        if (!h.isUp() || h.shouldBeIgnored) {
          return cb(new Error('This host should not be used'));
        }

        h.connectionKeyspace.push(ks);

        cb(null, {
          protocolVersion: protocolVersion,
          keyspace: 'ks',
          prepareOnce: function (q, ks, cb) {
            h.prepareCalled++;
            if (prepareQueryCb) {
              return prepareQueryCb(q, h, cb);
            }
            cb(null, { id: 1, meta: {} });
          },
          sendStream: function (r, o, cb) {
            h.sendStreamCalled++;
            if (sendStreamCb) {
              return sendStreamCb(r, h, cb);
            }
            const op = new OperationState(r, o, cb);
            setImmediate(function () {
              op.setResult(null, {});
            });
            return op;
          }
        });
      };
      return h;
    });
  },
  getLoadBalancingPolicyFake: function getLoadBalancingPolicyFake(hostsInfo, prepareQueryCb, sendStreamCb, protocolVersion) {
    const hosts = this.getHostsMock(hostsInfo, prepareQueryCb, sendStreamCb, protocolVersion);
    return ({
      newQueryPlan: function (q, ks, cb) {
        cb(null, utils.arrayIterator(hosts));
      },

      /**
       * Returns the array of hosts used in the query plan.
       */
      getFixedQueryPlan: function () {
        return hosts;
      },

      getDistance: function () {
        return types.distance.local;
      },

      /**
       * Shutdowns the hosts and invoke the optional callback.
       */
      shutdown: function (cb) {
        hosts.forEach(h => h.shutdown(false));

        if (cb) {
          cb();
        }
      }
    });
  },
  /**
   * Returns true if the tests are being run on Windows
   * @returns {boolean}
   */
  isWin: function () {
    return process.platform.indexOf('win') === 0;
  },

  /**
   * Invokes a function multiple times and returns a Promise that is resolved when all the promises have completed.
   * @param {Number} times
   * @param {Function} fn
   * @returns {Promise}
   */
  repeat: function(times, fn) {
    const arr = new Array(times);
    for (let i = 0; i < times; i++) {
      arr[i] = fn(i);
    }
    return Promise.all(arr);
  },
  requireOptional: function (moduleName) {
    try {
      // eslint-disable-next-line
      return require(moduleName);
    }
    catch (err) {
      if (err.code === 'MODULE_NOT_FOUND') {
        return null;
      }
      throw err;
    }
  },
  assertBufferString: function (instance, textValue) {
    this.assertInstanceOf(instance, Buffer);
    assert.strictEqual(instance.toString(), textValue);
  },
  conditionalDescribe: function (condition, text) {
    if (condition) {
      return describe;
    }
    return (function xdescribeWithText(name, fn) {
      return xdescribe(util.format('%s [%s]', name, text), fn);
    });
  },
  getOptions: function (options) {
    return utils.extend({}, helper.baseOptions, options);
  },
  /**
   * @param {ResultSet} result
   */
  keyedById: function (result) {
    const map = {};
    const columnKeys = result.columns.map(function (c) { return c.name;});
    if (columnKeys.indexOf('id') < 0 || columnKeys.indexOf('value') < 0) {
      throw new Error('ResultSet must contain the columns id and value');
    }
    result.rows.forEach(function (row) {
      map[row['id']] = row['value'];
    });
    return map;
  },
  /**
   * Connects to the cluster, makes a few queries and shutsdown the client
   * @param {Client} client
   * @param {Function} callback
   */
  connectAndQuery: function (client, callback) {
    const self = this;
    utils.series([
      client.connect.bind(client),
      function doSomeQueries(next) {
        utils.timesSeries(10, function (n, timesNext) {
          client.execute(self.queries.basic, timesNext);
        }, next);
      },
      client.shutdown.bind(client)
    ], callback);
  },
  /**
   * Identifies the host that is the spark master (the one that is listening on port 7077)
   * and returns it.
   * @param {Client} client instance that contains host metadata.
   * @param {Function} callback invoked with the host that is the spark master or error.
   */
  findSparkMaster: function (client, callback) {
    client.execute('call DseClientTool.getAnalyticsGraphServer();', function(err, result) {
      if(err) {
        return callback(err);
      }
      const row = result.first();
      const host = row.result.ip;
      callback(null, host);
    });
  },
  /**
   * Checks the spark cluster until there are the number of desired expected workers.  This
   * is required as by the time a node is up and listening on the CQL interface it is not a given
   * that it is partaking as a spark worker.
   *
   * Unfortunately there isn't a very good way to check that workers are listening as spark will choose an arbitrary
   * port for the worker and there is no other interface that exposes how many workers are active.  The best
   * alternative is to do a GET on http://master:7080/ and do a regular expression match to resolve the number of
   * active workers.  This could be somewhat fragile and break easily in future releases.
   *
   * @param {Client} client client instace that contains host metadata (used for resolving master address).
   * @param {Number} expectedWorkers The number of workers expected.
   * @param {Function} callback Invoked after expectedWorkers found or at least 100 seconds have passed.
   */
  waitForWorkers: function(client, expectedWorkers, callback) {
    helper.trace("Waiting for %d spark workers", expectedWorkers);
    const workerRE = /Alive Workers:.*(\d+)<\/li>/;
    let numWorkers = 0;
    let attempts = 0;
    const maxAttempts = 1000;
    utils.whilst(
      function checkWorkers() {
        return numWorkers < expectedWorkers && attempts++ < maxAttempts;
      },
      function(cb) {
        setTimeout(function() {
          let errored = false;
          // resolve master each time in oft chance it changes (highly unlikely).
          helper.findSparkMaster(client, function(err, master) {
            if(err) {
              cb();
            }
            const req = http.get({host: master, port: 7080, path: '/'}, function(response) {
              let body = '';
              response.on('data', function (data) {
                body += data;
              });
              response.on('end', function () {
                const match = body.match(workerRE);
                if (match) {
                  numWorkers = parseFloat(match[1]);
                  helper.trace("(%d/%d) Found workers: %d/%d", attempts+1, maxAttempts, numWorkers, expectedWorkers);
                } else {
                  helper.trace("(%d/%d) Found no workers in body", attempts+1, maxAttempts);
                }
                if (!errored) {
                  cb();
                }
              });
            });
            req.on('error', function (err) {
              errored = true;
              helper.trace("(%d/%d) Got error while fetching workers.", attempts+1, maxAttempts, err);
              cb();
            });
          });
        }, 100);
      }, function complete() {
        if(numWorkers < expectedWorkers) {
          helper.trace('WARNING: After %d attempts only %d/%d workers were active.', maxAttempts, numWorkers, expectedWorkers);
        }
        callback();
      }
    );
  }
};

/**
 * A polyfill of Map, valid for testing. It does not support update of values
 * @constructor
 */
function MapPolyFill(arr) {
  this.arr = arr || [];
  const self = this;
  Object.defineProperty(this, 'size', {
    get: function() { return self.arr.length; },
    configurable: false
  });
}

MapPolyFill.prototype.set = function (k, v) {
  this.arr.push([k, v]);
};

MapPolyFill.prototype.get = function (k) {
  return this.arr.filter(function (item) {
    return item[0] === k;
  })[0];
};

MapPolyFill.prototype.forEach = function (callback) {
  this.arr.forEach(function (item) {
    //first the value, then the key
    callback(item[1], item[0]);
  });
};

MapPolyFill.prototype.toString = function() {
  return this.arr.toString();
};

function SetPolyFill(arr) {
  this.arr = arr || [];
}

SetPolyFill.prototype.forEach = function (cb, thisArg) {
  this.arr.forEach(cb, thisArg);
};

SetPolyFill.prototype.add = function (x) {
  this.arr.push(x);
};

SetPolyFill.prototype.toString = function() {
  return this.arr.toString();
};

// Core driver used ccmHelper
helper.ccmHelper = helper.ccm;

/**
 * Removes previous and creates a new cluster (create, populate and start)
 * @param {Number|String} nodeLength number of nodes in the cluster. If multiple dcs, use the notation x:y:z:...
 * @param {{[vnodes]: Boolean, [yaml]: Array.<String>, [jvmArgs]: Array.<String>, [ssl]: Boolean,
 *  [dseYaml]: Array.<String>, [workloads]: Array.<String>, [sleep]: Number, [ipFormat]: String|null, partitioner: String}} options
 * @param {Function} callback
 */
helper.ccm.startAll = function (nodeLength, options, callback) {
  const self = helper.ccm;
  options = options || {};
  // adapt to multi dc format so data center naming is consistent.
  if (typeof nodeLength === 'number') {
    nodeLength = nodeLength + ':0';
  }

  const serverInfo = helper.getServerInfo();

  helper.trace(`Starting ${serverInfo.isDse ? 'DSE' : 'Cassandra'} cluster v${serverInfo.version} with ${nodeLength} node(s)`);

  utils.series([
    function (next) {
      //it wont hurt to remove
      self.exec(['remove'], function () {
        //ignore error
        next();
      });
    },
    function (next) {
      const clusterName = helper.getRandomName('test');
      let create = ['create', clusterName];

      if (serverInfo.isDse) {
        create.push('--dse');
      }

      create.push('-v', serverInfo.version);

      if (process.env['CCM_INSTALL_DIR']) {
        create = ['create', clusterName, '--install-dir=' + process.env['CCM_INSTALL_DIR']];
        helper.trace('With', create[2]);
      }

      if (options.ssl) {
        create.push('--ssl', self.getPath('ssl'));
      }

      if (options.partitioner) {
        create.push('-p');
        create.push(options.partitioner);
      }

      self.exec(create, helper.wait(options.sleep, next));
    },
    function (next) {
      const populate = ['populate', '-n', nodeLength.toString()];
      if (options.vnodes) {
        populate.push('--vnodes');
      }
      if (options.ipFormat) {
        populate.push('--ip-format='+ options.ipFormat);
      }
      self.exec(populate, helper.wait(options.sleep, next));
    },
    function (next) {
      if (!options.yaml || !options.yaml.length) {
        return next();
      }
      helper.trace('With cassandra yaml options', options.yaml);
      self.exec(['updateconf'].concat(options.yaml), next);
    },
    function (next) {
      if (!options.dseYaml || !options.dseYaml.length) {
        return next();
      }
      helper.trace('With dse yaml options', options.dseYaml);
      self.exec(['updatedseconf'].concat(options.dseYaml), next);
    },
    function (next) {
      if (!options.workloads || !options.workloads.length) {
        return next();
      }
      helper.trace('With workloads', options.workloads);
      self.exec(['setworkload', options.workloads.join(',')], next);
    },
    function (next) {
      const start = ['start', '--wait-for-binary-proto'];
      if (util.isArray(options.jvmArgs)) {
        options.jvmArgs.forEach(function (arg) {
          start.push('--jvm_arg', arg);
        }, this);
        helper.trace('With jvm args', options.jvmArgs);
      }
      self.exec(start, helper.wait(options.sleep, next));
    },
    self.waitForUp.bind(self)
  ], function (err) {
    callback(err);
  });
};

helper.ccm.start = function (nodeLength, options) {
  return (function executeStartAll(next) {
    helper.ccm.startAll(nodeLength, options, next);
  });
};

/**
 * Adds a new node to the cluster
 * @param {Number} nodeIndex 1 based index of the node
 * @param {Function} callback
 */
helper.ccm.bootstrapNode = function (nodeIndex, callback) {
  const ipPrefix = helper.ipPrefix;
  helper.trace('bootstrapping node', nodeIndex);
  helper.ccm.exec([
    'add',
    'node' + nodeIndex,
    '-i',
    ipPrefix + nodeIndex,
    '-j',
    (7000 + 100 * nodeIndex).toString(),
    '-b',
    '--dse'
  ], callback);
};

helper.ccm.decommissionNode = function (nodeIndex, callback) {
  helper.trace('decommissioning node', nodeIndex);
  const args = ['node' + nodeIndex, 'decommission'];
  // Special case for C* 3.12+, DSE 5.1+, force decommission (see CASSANDRA-12510)
  if (helper.isDseGreaterThan('5.1')) {
    args.push('--force');
  }
  helper.ccm.exec(args, callback);
};

/**
 * Sets the workload(s) for a given node.
 * @param {Number} nodeIndex 1 based index of the node
 * @param {Array<String>} workloads workloads to set.
 * @param {Function} callback
 */
helper.ccm.setWorkload = function (nodeIndex, workloads, callback) {
  helper.trace('node', nodeIndex, 'with workloads', workloads);
  helper.ccm.exec([
    'node' + nodeIndex,
    'setworkload',
    workloads.join(',')
  ], callback);
};

/**
 * @param {Number} nodeIndex 1 based index of the node
 * @param {Function} callback
 */
helper.ccm.startNode = function (nodeIndex, callback) {
  helper.ccm.exec(['node' + nodeIndex, 'start', '--wait-other-notice', '--wait-for-binary-proto'], callback);
};

/**
 * @param {Number} nodeIndex 1 based index of the node
 * @param {Function} callback
 */
helper.ccm.stopNode = function (nodeIndex, callback) {
  helper.ccm.exec(['node' + nodeIndex, 'stop'], callback);
};

helper.ccm.pauseNode = function (nodeIndex, callback) {
  helper.ccm.exec(['node' + nodeIndex, 'pause'], callback);
};

helper.ccm.resumeNode = function (nodeIndex, callback) {
  helper.ccm.exec(['node' + nodeIndex, 'resume'], callback);
};

helper.ccm.exec = function (params, callback) {
  helper.ccm.spawn('ccm', params, callback);
};

helper.ccm.spawn = function (processName, params, callback) {
  if (!callback) {
    callback = function () {};
  }
  params = params || [];
  const originalProcessName = processName;
  if (process.platform.indexOf('win') === 0) {
    params = ['/c', processName].concat(params);
    processName = 'cmd.exe';
  }
  const p = spawn(processName, params);
  const stdoutArray= [];
  const stderrArray= [];
  let closing = 0;
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  p.stdout.on('data', function (data) {
    stdoutArray.push(data);
  });

  p.stderr.on('data', function (data) {
    stderrArray.push(data);
  });

  p.on('close', function (code) {
    if (closing++ > 0) {
      //avoid calling multiple times
      return;
    }
    const info = {code: code, stdout: stdoutArray, stderr: stderrArray};
    let err = null;
    if (code !== 0) {
      err = new Error(
        'Error executing ' + originalProcessName + ':\n' +
        info.stderr.join('\n') +
        info.stdout.join('\n')
      );
      err.info = info;
    }
    callback(err, info);
  });
};

helper.ccm.remove = function (callback) {
  helper.ccm.exec(['remove'], callback);
};

helper.ccm.removeIfAny = function (callback) {
  helper.ccm.exec(['remove'], function () {
    // Ignore errors
    callback();
  });
};

/**
 * Reads the logs to see if the cql protocol is up
 * @param callback
 */
helper.ccm.waitForUp = function (callback) {
  let started = false;
  let retryCount = 0;
  const self = helper.ccm;
  utils.whilst(function () {
    return !started && retryCount < 60;
  }, function iterator (next) {
    self.exec(['node1', 'showlog'], function (err, info) {
      if (err) {
        return next(err);
      }
      const regex = /Starting listening for CQL clients/mi;
      started = regex.test(info.stdout.join(''));
      retryCount++;
      if (!started) {
        //wait 1 sec between retries
        return setTimeout(next, 1000);
      }
      return next();
    });
  }, callback);
};

/**
 * Gets the path of the ccm
 * @param subPath
 */
helper.ccm.getPath = function (subPath) {
  let ccmPath = process.env.CCM_PATH;
  if (!ccmPath) {
    ccmPath = (process.platform === 'win32') ? process.env.HOMEPATH : process.env.HOME;
    ccmPath = path.join(ccmPath, 'workspace/tools/ccm');
  }
  return path.join(ccmPath, subPath);
};

helper.ads._execute = function(processName, params, cb) {
  const originalProcessName = processName;
  if (process.platform.indexOf('win') === 0) {
    params = ['/c', processName].concat(params);
    processName = 'cmd.exe';
  }
  helper.trace('Executing: ' + processName + ' ' + params.join(" "));

  // If process hasn't completed in 10 seconds.
  let timeout = undefined;
  if(cb) {
    timeout = setTimeout(function() {
      cb("Timed out while waiting for " + processName + " to complete.");
    }, 10000);
  }

  const p = spawn(processName, params, {env:{KRB5_CONFIG: this.getKrb5ConfigPath()}});
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  p.stdout.on('data', function (data) {
    helper.trace("%s_out> %s", originalProcessName, data);
  });

  p.stderr.on('data', function (data) {
    helper.trace("%s_err> %s", originalProcessName, data);
  });

  p.on('close', function (code) {
    helper.trace("%s exited with code %d", originalProcessName, code);
    if(cb) {
      clearTimeout(timeout);
      if (code === 0) {
        cb();
      } else {
        cb(Error("Process exited with non-zero exit code: " + code));
      }
    }
  });

  return p;
};

/**
 * Starts the embedded-ads jar with ldap (port 10389) and kerberos enabled (port 10088).  Depends on ADS_JAR
 * environment variable to resolve the absolute file path of the embedded-ads jar.
 *
 * @param {Function} cb Callback to invoke when server is started and listening.
 */
helper.ads.start = function(cb) {
  const self = this;
  temp.mkdir('ads', function(err, dir) {
    if(err) {
      cb(err);
    }
    self.dir = dir;
    const jarFile = self.getJar();
    const processName = 'java';
    const params = ['-jar', jarFile, '-k', '--confdir', self.dir];
    let initialized = false;

    const timeout = setTimeout(function() {
      cb(new Error("Timed out while waiting for ADS server to start."));
    }, 10000);

    self.process = self._execute(processName, params, function() {
      if(!initialized) {
        cb();
      }
    });
    self.process.stdout.on('data', function (data) {
      // This is a bit of a kludge, check for a particular log statement which indicates
      // that all principals have been created before invoking the completion callback.
      if(data.indexOf('Principal Initialization Complete.') !== -1) {
        initialized = true;
        // Set KRB5_CONFIG environment variable so kerberos module knows to use it.
        process.env.KRB5_CONFIG = self.getKrb5ConfigPath();
        clearTimeout(timeout);
        cb();
      }
    });
  });
};

/**
 * Invokes a klist to list the current registered tickets and their expiration if trace is enabled.
 *
 * This is really only useful for debugging.
 *
 * @param {Function} cb Callback to invoke on completion.
 */
helper.ads.listTickets = function(cb) {
  this._execute('klist', [], cb);
};

/**
 * Acquires a ticket for the given username and its principal.
 * @param {String} username Username to acquire ticket for (i.e. cassandra).
 * @param {String} principal Principal to acquire ticket for (i.e. cassandra@DATASTAX.COM).
 * @param {Function} cb Callback to invoke on completion.
 */
helper.ads.acquireTicket = function(username, principal, cb) {
  const keytab = this.getKeytabPath(username);

  // Use ktutil on windows, kinit otherwise.
  const processName = 'kinit';
  const params = ['-t', keytab, '-k', principal];
  if (process.platform.indexOf('win') === 0) {
    // Not really sure what to do here yet...
  }
  this._execute(processName, params, cb);
};

/**
 * Destroys all tickets for the given principal.
 * @param {String} principal Principal for whom its tickets will be destroyed (i.e. dse/127.0.0.1@DATASTAX.COM).
 * @param {Function} cb Callback to invoke on completion.
 */
helper.ads.destroyTicket = function(principal, cb) {
  if (typeof principal === 'function') {
    //noinspection JSValidateTypes
    cb = principal;
    principal = null;
  }

  // Use ktutil on windows, kdestroy otherwise.
  const processName = 'kdestroy';
  const params = [];
  if (process.platform.indexOf('win') === 0) {
    // Not really sure what to do here yet...
  }
  this._execute(processName, params, cb);
};

/**
 * Stops the server process.
 * @param {Function} cb Callback to invoke when server stopped or with an error.
 */
helper.ads.stop = function(cb) {
  if(this.process !== undefined) {
    if(this.process.exitCode) {
      helper.trace("Server already stopped with exit code %d.", this.process.exitCode);
      cb();
    } else {
      this.process.on('close', function () {
        cb();
      });
      this.process.on('error', cb);
      this.process.kill('SIGINT');
    }
  } else {
    cb(Error("Process is not defined."));
  }
};

/**
 * Gets the path of the embedded-ads jar.  Resolved from ADS_JAR environment variable or $HOME/embedded-ads.jar.
 */
helper.ads.getJar = function () {
  let adsJar = process.env.ADS_JAR;
  if (!adsJar) {
    helper.trace("ADS_JAR environment variable not set, using $HOME/embedded-ads.jar");
    adsJar = (process.platform === 'win32') ? process.env.HOMEPATH : process.env.HOME;
    adsJar = path.join(adsJar, 'embedded-ads.jar');
  }
  helper.trace("Using %s for embedded ADS server.", adsJar);
  return adsJar;
};

/**
 * Returns the file path to the keytab for the given user.
 * @param {String} username User to resolve keytab for.
 */
helper.ads.getKeytabPath = function(username) {
  return path.join(this.dir, username + ".keytab");
};

/**
 * Returns the file path to the krb5.conf file generated by ads.
 */
helper.ads.getKrb5ConfigPath = function() {
  return path.join(this.dir, 'krb5.conf');
};


/**
 * A retry policy for testing purposes only, retries for a number of times
 * @param {Number} times
 * @constructor
 */
function RetryMultipleTimes(times) {
  this.times = times;
}

RetryMultipleTimes.prototype.onReadTimeout = function (requestInfo) {
  if (requestInfo.nbRetry > this.times) {
    return this.rethrowResult();
  }
  return this.retryResult();
};

RetryMultipleTimes.prototype.onUnavailable = function (requestInfo) {
  if (requestInfo.nbRetry > this.times) {
    return this.rethrowResult();
  }
  return this.retryResult();
};

RetryMultipleTimes.prototype.onWriteTimeout = function (requestInfo) {
  if (requestInfo.nbRetry > this.times) {
    return this.rethrowResult();
  }
  return this.retryResult();
};

/**
 * For test purposes, filters the child policy by last octet of the ip address
 * @param {Array} list
 * @param [childPolicy]
 * @constructor
 */
function WhiteListPolicy(list, childPolicy) {
  this.list = list;
  this.childPolicy = childPolicy || new policies.loadBalancing.RoundRobinPolicy();
}

util.inherits(WhiteListPolicy, policies.loadBalancing.LoadBalancingPolicy);

WhiteListPolicy.prototype.init = function (client, hosts, callback) {
  this.childPolicy.init(client, hosts, callback);
};

WhiteListPolicy.prototype.newQueryPlan = function (keyspace, info, callback) {
  const list = this.list;
  this.childPolicy.newQueryPlan(keyspace, info, function (err, iterator) {
    callback(err, {
      next: function () {
        let item = iterator.next();
        while (!item.done) {
          if (list.indexOf(helper.lastOctetOf(item.value)) >= 0) {
            break;
          }
          item = iterator.next();
        }
        return item;
      }
    });
  });
};

function FallthroughRetryPolicy() {

}

util.inherits(FallthroughRetryPolicy, policies.retry.RetryPolicy);

FallthroughRetryPolicy.prototype.onUnavailable = function () {
  this.rethrowResult();
};

FallthroughRetryPolicy.prototype.onReadTimeout = FallthroughRetryPolicy.prototype.onUnavailable;
FallthroughRetryPolicy.prototype.onWriteTimeout = FallthroughRetryPolicy.prototype.onUnavailable;
FallthroughRetryPolicy.prototype.onRequestError = FallthroughRetryPolicy.prototype.onUnavailable;

/**
 * Conditionally executes func if testVersion is <= the current cassandra version.
 * @param {String} testVersion Minimum version of Cassandra needed.
 * @param {Function} func The function to conditionally execute.
 * @param {Array} args the arguments to apply to the function.
 */
function executeIfVersion (testVersion, func, args) {
  const serverInfo = helper.getServerInfo();
  let invokeFunction = false;

  if (testVersion.startsWith('dse-')) {
    if (serverInfo.isDse) {
      // Compare only if the server instance is DSE
      invokeFunction = helper.versionCompare(serverInfo.version, testVersion.substr(4));
    }
  } else {
    // Use the C* version (of DSE or the actual C* version)
    invokeFunction = helper.versionCompare(helper.getCassandraVersion(), testVersion);
  }

  if (invokeFunction) {
    func.apply(this, args);
  }
}

/**
 * Policy only suitable for testing, it creates a fixed query plan containing the nodes in the same order, i.e. [a, b].
 * @constructor
 */
class OrderedLoadBalancingPolicy extends policies.loadBalancing.RoundRobinPolicy {

  /**
   * Creates a new instance.
   * @param {Array<String>|SimulacronCluster} [addresses] When specified, it uses the order from the provided host
   * addresses.
   */
  constructor(addresses) {
    super();

    if (addresses && typeof addresses.dc === 'function') {
      // With Simulacron, use the nodes from the first DC in that order
      addresses = addresses.dc(0).nodes.map(n => n.address);
    }

    this.addresses = addresses;
  }

  newQueryPlan(keyspace, info, callback) {
    const hosts = !this.addresses
      ? this.hosts.values()
      : this.addresses.map(address => this.hosts.get(address));

    return callback(null, hosts[Symbol.iterator]());
  }
}

module.exports = helper;
module.exports.RetryMultipleTimes = RetryMultipleTimes;
module.exports.OrderedLoadBalancingPolicy = OrderedLoadBalancingPolicy;
