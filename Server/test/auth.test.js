const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
const User = require('../models/User');
const app = require('../app');
let server, base, stored;
const originalCreate = User.create;
const originalFindOne = User.findOne;
const originalFindById = User.findById;
before(async () => {
  User.create = async data => {
    if (stored?.email === data.email) throw Object.assign(new Error('duplicate'), { code: 11000 });
    stored = { ...data, id: '507f1f77bcf86cd799439011', createdAt: new Date() };
    return stored;
  };
  User.findOne = ({ email }) => ({ select: async () => stored?.email === email ? stored : null });
  User.findById = async id => stored?.id === id ? stored : null;
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { User.create = originalCreate; User.findOne = originalFindOne; User.findById = originalFindById; await new Promise(resolve => server.close(resolve)); });
const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
test('public health and unauthenticated session', async () => {
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/api/auth/me')).status, 401);
});
test('registration validates, hashes, sets JWT cookie, and protects account data', async () => {
  assert.equal((await post('/api/auth/register', { name: 'A', email: 'bad', password: 'short' })).status, 422);
  const response = await post('/api/auth/register', { name: 'Thandi Mokoena', email: 'THANDI@example.com', password: 'SecurePass123!' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.user.email, 'thandi@example.com');
  assert.equal(body.user.password, undefined);
  assert.notEqual(stored.password, 'SecurePass123!');
  assert.equal(await bcrypt.compare('SecurePass123!', stored.password), true);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  const token = decodeURIComponent(cookie.split(';')[0].split('=')[1]);
  assert.equal(jwt.verify(token, process.env.JWT_SECRET).sub, stored.id);
  const me = await fetch(base + '/api/auth/me', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(me.status, 200); assert.equal((await me.json()).user.password, undefined);
  assert.equal((await post('/api/auth/register', { name: 'Thandi', email: 'thandi@example.com', password: 'SecurePass123!' })).status, 409);
});
test('login, invalid tokens, cross-origin requests and logout', async () => {
  assert.equal((await post('/api/auth/login', { email: 'thandi@example.com', password: 'wrong' })).status, 401);
  assert.equal((await post('/api/auth/login', { email: 'thandi@example.com', password: 'SecurePass123!' })).status, 200);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: 'rt_session=invalid' } })).status, 401);
  assert.equal((await post('/api/auth/logout', {}, { Origin: 'https://untrusted.example' })).status, 403);
  const logout = await post('/api/auth/logout', {});
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
});
