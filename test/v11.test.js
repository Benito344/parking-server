'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { adminTokenDepuisEnv } = require('../src/config');

test('jeton admin : ADMIN_TOKEN_ALBERT prioritaire, ADMIN_TOKEN en repli', () => {
  assert.deepStrictEqual(adminTokenDepuisEnv({ ADMIN_TOKEN_ALBERT: 'a', ADMIN_TOKEN: 'b' }), { token: 'a', source: 'ADMIN_TOKEN_ALBERT' });
  assert.deepStrictEqual(adminTokenDepuisEnv({ ADMIN_TOKEN: 'b' }), { token: 'b', source: 'ADMIN_TOKEN' });
  assert.deepStrictEqual(adminTokenDepuisEnv({ ADMIN_TOKEN_ALBERT: '  ', ADMIN_TOKEN: 'b' }), { token: 'b', source: 'ADMIN_TOKEN' });
  assert.deepStrictEqual(adminTokenDepuisEnv({}), { token: null, source: null });
});
