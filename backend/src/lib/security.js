const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const EMAIL_PATTERN = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]{2,}$/;

async function passwordHash(password) {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const hash = await scrypt(String(password), salt, KEY_BYTES);
  return `${salt}:${hash.toString('hex')}`;
}

async function passwordMatches(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = await scrypt(String(password), salt, KEY_BYTES);
  const expected = Buffer.from(expectedHex, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

async function simulatePasswordCheck(password) {
  await scrypt(String(password), 'fluxy-conta-inexistente', KEY_BYTES);
}

function passwordProblem(password) {
  const value = typeof password === 'string' ? password : '';
  if (value.length < PASSWORD_MIN_LENGTH) return `A senha precisa de pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  if (value.length > PASSWORD_MAX_LENGTH) return `A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`;
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/\d/.test(value)) {
    return 'A senha precisa ter letra maiúscula, letra minúscula e número.';
  }
  return '';
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

const normalizeEmail = value => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const isValidEmail = value => value.length <= 150 && EMAIL_PATTERN.test(value);

module.exports = {
  passwordHash,
  passwordMatches,
  simulatePasswordCheck,
  passwordProblem,
  newToken,
  hashToken,
  normalizeEmail,
  isValidEmail
};
