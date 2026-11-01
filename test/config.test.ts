import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, parseConfig } from '../src/config.js';

const validEnv = {
  AGENTPHONE_API_KEY: 'test-key-do-not-log',
  MY_NUMBER: '+12025550123',
  SUB_ACCOUNTS: 'sa_alice:Alice, sa_bob:Bob Smith',
};

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    parseConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err;
  }
  assert.fail('expected parseConfig to throw');
}

test('valid env parses, with PORT defaulting to 3000', () => {
  assert.deepEqual(parseConfig(validEnv), {
    apiKey: 'test-key-do-not-log',
    myNumber: '+12025550123',
    subAccounts: [
      { id: 'sa_alice', ownerName: 'Alice' },
      { id: 'sa_bob', ownerName: 'Bob Smith' },
    ],
    signingKeyPath: undefined,
    port: 3000,
  });
});

test('missing API key is rejected', () => {
  const { AGENTPHONE_API_KEY: _omitted, ...env } = validEnv;
  assert.match(configError(env).message, /AGENTPHONE_API_KEY: required/);
});

test('non-E.164 number is rejected without echoing it', () => {
  const err = configError({ ...validEnv, MY_NUMBER: '202-555-0123' });
  assert.match(err.message, /MY_NUMBER: must be E\.164/);
  assert.doesNotMatch(err.message, /555-0123/);
});

test('malformed SUB_ACCOUNTS entries are rejected', () => {
  assert.match(configError({ ...validEnv, SUB_ACCOUNTS: 'sa_alice' }).message, /SUB_ACCOUNTS/);
  assert.match(configError({ ...validEnv, SUB_ACCOUNTS: ':Alice' }).message, /SUB_ACCOUNTS/);
  assert.match(configError({ ...validEnv, SUB_ACCOUNTS: ' , ' }).message, /SUB_ACCOUNTS/);
});

test('every problem is listed at once, and the API key never appears', () => {
  const err = configError({ AGENTPHONE_API_KEY: 'test-key-do-not-log', PORT: '0' });
  for (const name of ['MY_NUMBER', 'SUB_ACCOUNTS', 'PORT'])
    assert.match(err.message, new RegExp(name));
  assert.doesNotMatch(err.message, /test-key-do-not-log/);
});
